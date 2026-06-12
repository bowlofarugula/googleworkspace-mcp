# googleworkspace-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server running on
Cloudflare Workers that exposes **Google Workspace** (Gmail, Calendar, Drive, Docs,
Sheets, Slides, Tasks) as MCP tools, focused on **write/automation** beyond what the
built-in Google connectors do.

Authentication is delegated to **Google OAuth 2.0**. The Worker acts as an OAuth server to
MCP clients (via
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider))
and as an OAuth client to Google upstream. **Google tokens never reach the MCP client** —
they are stored encrypted in the grant and surfaced to the server as `this.props`. Each
user signs in with their own Google account through **one** Ian-owned OAuth app, so no
per-user OAuth-app creation is needed. Google Workspace REST APIs are called **directly via
`fetch`** — Google's Node client libraries don't run on the Workers runtime.

This mirrors the architecture of the sibling [`frameio-mcp`](https://github.com/bowlofarugula/frameio-mcp)
server (Adobe IMS) — same OAuth-provider→upstream-federation shape, same portal lockdown.

## Scopes — deliberately CASA-free

Only **sensitive-or-lower** scopes; **zero restricted scopes**, so no annual paid CASA
security assessment — only the free sensitive-scope human review. The value is write/
automation, not bulk reading (no full-inbox or full-Drive crawl — that's what the built-in
connectors already do).

| Scope | Class | Buys |
| --- | --- | --- |
| `openid`, `userinfo.email`, `userinfo.profile` | non-sensitive | identity |
| `drive.file` | non-sensitive | create/edit **app-created** Drive files |
| `gmail.send` | sensitive | send mail |
| `gmail.compose` | sensitive | create/update/delete drafts + send |
| `calendar.events` | sensitive | create/update/delete/list events |
| `tasks` | sensitive | manage task lists + tasks |
| `documents` | sensitive | read/write **existing** Google Docs by id |
| `spreadsheets` | sensitive | read/write **existing** Sheets by id |
| `presentations` | sensitive | read/write **existing** Slides by id |

The scope list is defined in [`src/google-handler.ts`](src/google-handler.ts) (`GOOGLE_SCOPES`)
and **must match** the OAuth consent screen exactly.

## Tools

| Area | Tools |
| --- | --- |
| Identity | `whoami` |
| Gmail | `send_email`, `create_draft`, `update_draft`, `send_draft`, `list_drafts` |
| Calendar | `list_events`, `get_event`, `create_event`, `update_event`, `delete_event`, `quick_add_event` |
| Drive | `list_files`, `get_file`, `create_file`, `upload_from_url`, `create_folder`, `rename_or_move_file`, `trash_file`, `export_file`, `create_public_link`, `revoke_public_link` |
| Docs | `create_doc`, `get_doc`, `insert_text`, `replace_text`, `batch_update_doc` |
| Sheets | `create_spreadsheet`, `get_values`, `append_values`, `update_values`, `add_sheet`, `batch_update_spreadsheet` |
| Slides | `create_presentation`, `get_presentation`, `add_slide`, `batch_update_presentation` |
| Tasks | `list_tasklists`, `list_tasks`, `create_task`, `update_task`, `complete_task`, `delete_task` |

- **Lists** return `{ items, next_cursor }`; pass `next_cursor` as the next `page_token`.
- **`drive.file` limits Drive** to files the app created (or that were explicitly opened with
  it). `documents`/`spreadsheets`/`presentations` let the Docs/Sheets/Slides tools edit any
  file the user can open **by id**.
- **`batch_update_*`** tools accept raw Google API `requests` arrays for advanced edits
  (styling, tables, charts, slide elements) straight from Google's API reference.
- **`create_public_link`** grants "anyone with the link" access (default view-only) and returns
  the shareable URL; `revoke_public_link` undoes it. Under `drive.file` this works on files
  this server created/opened — sharing arbitrary pre-existing files would require the
  restricted `drive` scope (CASA), which is intentionally not requested.

## How this complements the built-in Google connectors

This server is designed to run **alongside** Claude's official Google connectors (Gmail,
Calendar, Drive), not replace them. **Keep the official connectors enabled.** They provide
the rich, CASA-free **read** surface this server deliberately omits; this server adds the
**write/automation and document-authoring** surface they lack.

| Capability | Official connector | This server |
| --- | --- | --- |
| Gmail read/search, threads, labels | ✅ | ✕ (out of scope — stays CASA-free) |
| Gmail **send** (non-draft) | ✕ | ✅ |
| Gmail drafts | ✅ | ✅ (overlap) |
| Calendar event CRUD, free/busy | ✅ | ✅ (overlap) |
| Drive read/search, file content | ✅ | ✕ (out of scope) |
| Drive create / **upload-from-URL** / export / folder org | partial | ✅ |
| **Docs** authoring & editing | ✕ | ✅ |
| **Sheets** values read/write, formatting | ✕ | ✅ |
| **Slides** authoring | ✕ | ✅ |
| **Google Tasks** | ✕ | ✅ |

**Net-new value** (the official connectors don't do these at all): Gmail send, Docs/Sheets/
Slides authoring, Google Tasks, and Drive upload-from-URL/export/folder organization.

**Overlap** exists on Calendar event CRUD, Gmail drafts, and Drive create. With both enabled,
an assistant may see two similarly-named tools (e.g. two `create_event`); this is generally
harmless (it picks one). The official connectors are **per-service, all-or-nothing** bundles,
so you can't disable just the overlapping tools — the recommended posture is simply to leave
both on and rely on the official connectors for reading and this server for authoring/sending.

## Architecture

```
MCP client ──/authorize──▶ Worker (redirect_uri allowlist → approval dialog, CSRF + state→KV)
           ──302──▶ Google /o/oauth2/v2/auth (user signs in, consents; access_type=offline)
Google ──/callback──▶ Worker (validates state) ──POST /token──▶ access + refresh tokens
Worker ──completeAuthorization({ props })──▶ 302 back to MCP client with an MCP auth code
MCP client ──/token──▶ Worker (workers-oauth-provider) ──▶ MCP bearer token
MCP client ──/mcp (bearer)──▶ McpAgent: props decrypted into this.props, Google REST via fetch
```

- **Token TTL** tracks Google's `expires_in`.
- **On MCP refresh**, the Worker refreshes against Google in lock-step. Unlike Adobe IMS,
  Google does **not** rotate the refresh token on refresh, so the stored one is kept. A
  refresh failure throws `invalid_grant`, forcing the client to re-authenticate.
- A refresh token is only issued on **first consent**; sign-in uses `prompt=consent` so a
  re-auth always re-establishes it. (If Google ever returns no refresh token, revoke the app
  at <https://myaccount.google.com/permissions> and sign in again.)

### Access control (portal lockdown)

`/authorize` is gated by **`PORTAL_REDIRECT_URI`** — a comma-separated allowlist of redirect
URIs. Only an authorize request whose `redirect_uri` is on the list may start the Google
sign-in flow; everything else is refused with `403`. This stops the public `*.workers.dev`
URL from being used to bypass an upstream gateway — e.g. a Cloudflare
[MCP server portal](https://developers.cloudflare.com/cloudflare-one/) that front-ends the
Worker and authenticates users before forwarding requests.

- It holds even though Dynamic Client Registration is open: an attacker can *claim* an
  allow-listed redirect, but the OAuth code is delivered **to that redirect** — the
  gateway's callback — so they never receive it.
- **Fail-closed:** if `PORTAL_REDIRECT_URI` is unset/empty, every `/authorize` is refused.
- It's a non-secret value, so it ships as a `vars` entry in `wrangler.jsonc`. The default is
  Cloudflare Access's portal callback
  (`https://oauth-callbacks.cloudflareaccess.com/cdn-cgi/access/outbound-oauth-callback`).
- This is the **only** access gate — there is **no** second worker-side Cloudflare Access
  hop (which would stack a redundant login). The portal is the identity gate.

To allow a **direct** client (the MCP Inspector, `scripts/e2e.py`, or a deployment with no
portal), add that client's redirect to the list: for local `wrangler dev`, override it in
`.dev.vars`; for a deployment, edit the `vars` entry in `wrangler.jsonc`.

## Google Cloud setup

1. Create a project at <https://console.cloud.google.com>.
2. **Enable APIs:** Gmail, Google Calendar, Google Drive, Google Docs, Google Sheets,
   Google Slides, Google Tasks.
3. **OAuth consent screen** → User type **External**. Add app name, support email, homepage,
   privacy policy, and an authorized domain (domain verification is needed when you submit
   for sensitive-scope verification).
4. Add the exact scope list above (also in `GOOGLE_SCOPES`).
5. **Credentials** → **OAuth client ID** → **Web application**. Set the **Authorized redirect
   URI** to your deployed callback (HTTPS, must match exactly, no trailing slash):
   ```
   https://googleworkspace-mcp.<your-subdomain>.workers.dev/callback
   ```
6. While the consent screen is in **Testing**, add allow-listed **test users** (up to 100).
   Submit for sensitive-scope verification to publish to all users (free, ~weeks, **no CASA
   audit** because no restricted scopes).

> Gotcha: a mismatched redirect URI yields `redirect_uri_mismatch` — match scheme, host,
> `/callback`, and the absence of a trailing slash exactly.

## Deploy

```bash
npm install
cp .env.example .env            # your local, non-secret config (git-ignored)

# 1. KV namespace — create one and put its id in .env as OAUTH_KV_ID
#    (the committed wrangler.jsonc keeps a <your-kv-namespace-id> placeholder;
#     `npm run dev`/`deploy` inject your id into a generated config):
npx wrangler kv namespace create OAUTH_KV

# 2. Secrets (stored as Worker secrets, never in the repo):
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put COOKIE_ENCRYPTION_KEY

# 3. Deploy:
npm run deploy
```

The deployed URL is `https://googleworkspace-mcp.<your-subdomain>.workers.dev`. Confirm it
matches the Google credential's redirect URI (`…/callback`).

> Before exposing the deployment, review **`PORTAL_REDIRECT_URI`** in `wrangler.jsonc` — it
> allow-lists which `redirect_uri`s may sign in (see
> [Access control](#access-control-portal-lockdown)). The default locks the Worker to a
> Cloudflare MCP portal; set it to your client's redirect to connect directly.

## Local development

```bash
cp .env.example .env             # OAUTH_KV_ID + GOOGLEWORKSPACE_MCP_BASE (git-ignored)
cp .dev.vars.example .dev.vars   # the three secret values (git-ignored)
npm run dev
```

## Connecting a client

- **MCP endpoint:** `https://googleworkspace-mcp.<your-subdomain>.workers.dev/mcp`
  (Streamable HTTP; a legacy SSE endpoint is at `/sse`).
- Supports **Dynamic Client Registration** (`/register`).
- **Sign-in is gated** by `PORTAL_REDIRECT_URI` — connect **through the portal**, or
  allow-list your client's redirect to connect directly.

### Headless verification

`scripts/e2e.py` drives the whole flow without an MCP client: it DCR-registers, prints an
authorize URL to open + sign in, captures the redirect on a local listener, exchanges the
code for an MCP token, then runs the MCP handshake and calls read tools. It caches the token
at `/tmp/mcp_token.json`. It reads `GOOGLEWORKSPACE_MCP_BASE` from `.env`:

```bash
python3 scripts/e2e.py                          # full flow (opens a URL to sign in)
python3 scripts/e2e.py call                     # re-run the read suite with the cached token
python3 scripts/e2e.py call whoami '{}'         # call one tool with JSON args
python3 scripts/e2e.py call create_event '{"summary":"Test","start":"2026-06-12","end":"2026-06-12"}'
```

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local Worker (`wrangler dev`). |
| `npm run deploy` | Deploy to Cloudflare. |
| `npm run typecheck` | `tsc --noEmit` (runs `wrangler types` first). |
| `npm run lint` / `lint:fix` | oxlint. |
| `npm run format` / `format:check` | oxfmt. |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing wrangler.jsonc. |

## Security

Google tokens are never returned to MCP clients — they live encrypted in the OAuth grant
and surface to the Worker only as `this.props`. Secrets (`GOOGLE_CLIENT_SECRET`,
`COOKIE_ENCRYPTION_KEY`) are Cloudflare Worker secrets, never committed. See
[`SECURITY.md`](SECURITY.md) for the threat model and how to report a vulnerability.

## Support & contributing

Best-effort maintenance — I'll do my best to fix bugs and security issues, and contributions
are very welcome. Open an issue or a pull request; help with docs, tests, or features is
encouraged. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

This is an **unofficial, community-built** integration. It is not affiliated with, endorsed
by, or supported by Google. "Google Workspace", "Gmail", "Google Calendar", "Google Drive",
"Google Docs", "Google Sheets", "Google Slides", and "Google Tasks" are trademarks of Google
LLC, used here only to describe what this tool connects to. Use it in accordance with
Google's API terms.

## License

[Apache-2.0](LICENSE) © 2026 Ian McDonald
