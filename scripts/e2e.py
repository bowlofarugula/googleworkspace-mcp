#!/usr/bin/env python3
"""End-to-end MCP OAuth + tool-call harness for googleworkspace-mcp.

Acts as a public MCP client: DCR-registers, prints an /authorize URL for the
human to open + sign in via Google, captures the returned auth code on a local
listener, exchanges it for an MCP bearer token, then runs the MCP handshake and
calls whoami + a couple of read tools. All progress is logged to LOG so the
orchestrator can follow along.

Note: the deployed Worker locks /authorize to the MCP portal's redirect_uri. To
use this direct harness, allow-list REDIRECT_URI below in PORTAL_REDIRECT_URI
(e.g. via .dev.vars for `wrangler dev`, or a temporary vars entry).
"""
import base64
import hashlib
import http.server
import json
import os
import secrets
import threading
import urllib.parse
import urllib.request


def _load_dotenv():
    """Load KEY=VALUE pairs from a repo-root .env into os.environ (existing env wins)."""
    root = os.path.join(os.path.dirname(__file__), os.pardir)
    path = os.path.join(root, ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip().strip("\"'"))


_load_dotenv()
BASE = os.environ.get("GOOGLEWORKSPACE_MCP_BASE", "").rstrip("/")
if not BASE:
    raise SystemExit(
        "Set GOOGLEWORKSPACE_MCP_BASE (in .env or the environment) to your deployed Worker URL, e.g.\n"
        "  GOOGLEWORKSPACE_MCP_BASE=https://googleworkspace-mcp.<your-subdomain>.workers.dev"
    )
# Cloudflare's edge blocks the default Python-urllib UA (403); use a normal one.
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) googleworkspace-mcp-e2e/1.0"
REDIRECT_PORT = 8976
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
LOG = "/tmp/mcp_e2e.log"
TOKEN_FILE = "/tmp/mcp_token.json"

captured = {}


def log(msg):
    with open(LOG, "a") as f:
        f.write(msg + "\n")
    print(msg, flush=True)


def post_form(url, data, headers=None):
    body = urllib.parse.urlencode(data).encode()
    h = {"Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    with urllib.request.urlopen(req) as r:
        return r.status, r.read().decode()


def post_json(url, obj, headers=None):
    body = json.dumps(obj).encode()
    h = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": UA,
    }
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    r = urllib.request.urlopen(req)
    raw = r.read().decode()
    return r.status, dict(r.headers), raw


def parse_mcp(raw):
    """Body may be JSON or SSE (data: lines). Return the first JSON object."""
    raw = raw.strip()
    if raw.startswith("{"):
        return json.loads(raw)
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    raise ValueError(f"Unparseable MCP body: {raw[:300]}")


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        log(f"LISTENER_HIT path={parsed.path} keys={sorted(qs.keys())}")
        if "code" in qs:
            captured["code"] = qs["code"][0]
            captured["state"] = qs.get("state", [""])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Google Workspace MCP: authorization received.</h2>You can close this tab.")
        elif "error" in qs:
            captured["error"] = parsed.query
            self.send_response(400)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<h2>Authorization error.</h2>" + parsed.query.encode())
        else:
            # Ignore favicon/preconnect/stray requests — keep waiting for the real redirect.
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):
        pass


def main():
    open(LOG, "w").close()

    # PKCE
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")

    # 1. Dynamic Client Registration
    req = urllib.request.Request(
        f"{BASE}/register",
        data=json.dumps(
            {
                "client_name": "googleworkspace-mcp-e2e",
                "redirect_uris": [REDIRECT_URI],
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
            }
        ).encode(),
        headers={"Content-Type": "application/json", "User-Agent": UA},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        reg = json.loads(r.read().decode())
    client_id = reg["client_id"]
    log(f"REGISTERED client_id={client_id}")

    # 2. Start local listener for the redirect (threaded, so stray hits don't block)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", REDIRECT_PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    state = secrets.token_urlsafe(16)
    authorize_url = f"{BASE}/authorize?" + urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "scope": "",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    log("OPEN_THIS_URL " + authorize_url)
    log("WAITING for sign-in + callback...")

    # 3. Wait for the code (up to 10 min)
    import time

    for _ in range(600):
        if "code" in captured or "error" in captured:
            break
        time.sleep(1)
    if "error" in captured:
        log("CALLBACK_ERROR " + captured["error"])
        return
    if "code" not in captured:
        log("TIMEOUT waiting for callback")
        return
    log("GOT_CODE")
    if captured.get("state") != state:
        log(f"WARN state mismatch: {captured.get('state')} != {state}")

    # 4. Exchange MCP auth code for MCP bearer token
    status, tok_raw = post_form(
        f"{BASE}/token",
        {
            "grant_type": "authorization_code",
            "code": captured["code"],
            "redirect_uri": REDIRECT_URI,
            "client_id": client_id,
            "code_verifier": verifier,
        },
    )
    tok = json.loads(tok_raw)
    access_token = tok["access_token"]
    log(f"TOKEN ok (expires_in={tok.get('expires_in')}, has_refresh={'refresh_token' in tok})")
    with open(TOKEN_FILE, "w") as f:
        json.dump(
            {
                "access_token": access_token,
                "refresh_token": tok.get("refresh_token"),
                "client_id": client_id,
            },
            f,
        )
    log(f"TOKEN_SAVED {TOKEN_FILE}")

    run_suite(access_token)
    log("DONE")
    server.shutdown()


# --- reusable MCP session helpers -----------------------------------------


def init_session(access_token):
    """Initialize an MCP session; return headers carrying auth + session id."""
    auth = {"Authorization": f"Bearer {access_token}"}
    st, hdrs, raw = post_json(
        f"{BASE}/mcp",
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "e2e", "version": "1.0.0"},
            },
        },
        auth,
    )
    session_id = hdrs.get("mcp-session-id") or hdrs.get("Mcp-Session-Id")
    init = parse_mcp(raw)
    log(f"INITIALIZE ok session={session_id} server={init.get('result',{}).get('serverInfo')}")
    sess_h = dict(auth)
    if session_id:
        sess_h["mcp-session-id"] = session_id
    try:
        post_json(f"{BASE}/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, sess_h)
    except Exception as e:
        log(f"(initialized notification: {e})")
    return sess_h


def tool_call(sess_h, name, args, rid):
    st, hdrs, raw = post_json(
        f"{BASE}/mcp",
        {"jsonrpc": "2.0", "id": rid, "method": "tools/call", "params": {"name": name, "arguments": args}},
        sess_h,
    )
    res = parse_mcp(raw)
    return res.get("result", {}).get("content", [{}])[0].get("text", json.dumps(res))


def run_suite(access_token):
    sess_h = init_session(access_token)
    st, hdrs, raw = post_json(f"{BASE}/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, sess_h)
    tools = parse_mcp(raw).get("result", {}).get("tools", [])
    log(f"TOOLS ({len(tools)}) " + ", ".join(t["name"] for t in tools))

    log("WHOAMI " + tool_call(sess_h, "whoami", {}, 3))
    log("LIST_TASKLISTS " + tool_call(sess_h, "list_tasklists", {}, 4))
    log("LIST_DRAFTS " + tool_call(sess_h, "list_drafts", {}, 5))


def reuse_mode(argv):
    """`call [<tool> <json-args>]` — reuse the saved token, no sign-in. Default: full suite."""
    open(LOG, "w").close()
    with open(TOKEN_FILE) as f:
        tok = json.load(f)
    access = tok["access_token"]
    if len(argv) >= 3:
        sess_h = init_session(access)
        name = argv[2]
        args = json.loads(argv[3]) if len(argv) >= 4 else {}
        log(f"CALL {name} -> " + tool_call(sess_h, name, args, 50))
    else:
        run_suite(access)
    log("DONE")


if __name__ == "__main__":
    import sys

    if len(sys.argv) >= 2 and sys.argv[1] == "call":
        reuse_mode(sys.argv)
    else:
        main()
