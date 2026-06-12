import { env } from "cloudflare:workers";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env, GoogleUser } from "./types";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

// --- Google OAuth 2.0 constants -------------------------------------------

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** OpenID Connect userinfo — used to label the grant. */
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/**
 * Requested scopes (space-delimited per the OAuth spec). Deliberately CASA-FREE:
 * every entry is sensitive-or-lower, NONE restricted (no gmail.readonly/modify,
 * no full drive). The editor scopes (documents/spreadsheets/presentations) allow
 * read/write of EXISTING user files by id; drive.file covers app-created files.
 *
 * These MUST match the scope set configured on the OAuth consent screen, or Google
 * returns invalid_scope / a verification error.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
].join(" ");

/** Canonical form of a scope for granted-vs-requested comparison. */
function canonicalScope(s: string): string {
  if (s === "email") return "https://www.googleapis.com/auth/userinfo.email";
  if (s === "profile") return "https://www.googleapis.com/auth/userinfo.profile";
  return s;
}

/** Friendly checkbox names for the missing-permissions error. */
const SCOPE_LABELS: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email": "Basic profile (email address)",
  "https://www.googleapis.com/auth/userinfo.profile": "Basic profile (name)",
  "https://www.googleapis.com/auth/drive.file": "Google Drive (files created with this app)",
  "https://www.googleapis.com/auth/gmail.send": "Gmail (send email)",
  "https://www.googleapis.com/auth/gmail.compose": "Gmail (manage drafts)",
  "https://www.googleapis.com/auth/calendar.events": "Google Calendar (events)",
  "https://www.googleapis.com/auth/tasks": "Google Tasks",
  "https://www.googleapis.com/auth/documents": "Google Docs",
  "https://www.googleapis.com/auth/spreadsheets": "Google Sheets",
  "https://www.googleapis.com/auth/presentations": "Google Slides",
};

/**
 * Which requested scopes Google did NOT grant. Google's granular-consent screen lets
 * the user uncheck individual permissions and the token exchange still succeeds, so a
 * "connected" grant can silently lack e.g. Sheets — tool calls then 403 with
 * ACCESS_TOKEN_SCOPE_INSUFFICIENT and the connector looks broken. "openid" is implicit
 * in the response and userinfo can come back as the email/profile shorthand, so
 * canonicalize both sides before comparing.
 */
export function missingGoogleScopes(granted: string | undefined): string[] {
  const have = new Set((granted ?? "").split(/\s+/).filter(Boolean).map(canonicalScope));
  return GOOGLE_SCOPES.split(" ")
    .filter((s) => s !== "openid")
    .filter((s) => !have.has(canonicalScope(s)));
}

/** Shape of a successful Google token response. */
export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

/** Token-endpoint POST body for the confidential Web App client. */
function tokenBody(
  e: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
  extra: Record<string, string>,
): URLSearchParams {
  return new URLSearchParams({
    client_id: e.GOOGLE_CLIENT_ID,
    client_secret: e.GOOGLE_CLIENT_SECRET,
    ...extra,
  });
}

/** Exchange an authorization code for Google tokens (Web App confidential client). */
export async function exchangeGoogleCode(
  e: Pick<Env, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
  code: string,
  redirectUri: string,
): Promise<GoogleTokenResponse> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody(e, { grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new OAuthError(
      "invalid_grant",
      `Google token exchange failed (${resp.status}): ${detail.slice(0, 300)}`,
      502,
    );
  }
  return (await resp.json()) as GoogleTokenResponse;
}

/** Fetch Google identity for labeling the grant. Best-effort: never blocks auth. */
async function fetchGoogleUser(accessToken: string): Promise<GoogleUser> {
  try {
    const resp = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) return { id: "unknown" };
    const d = (await resp.json()) as { sub?: string; name?: string; email?: string };
    return { id: d.sub ?? "unknown", name: d.name, email: d.email };
  } catch {
    return { id: "unknown" };
  }
}

// --- Hono app: /authorize (GET + POST), /callback -------------------------

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

const SERVER_INFO = {
  name: "Google Workspace",
  description:
    "Automate Google Workspace — send/draft Gmail, manage Calendar events, create and edit Drive files, Docs, Sheets, Slides, and Tasks — via the Model Context Protocol.",
};

/**
 * Portal lockdown. This Worker's public /authorize endpoint is reachable by anyone
 * (DCR is open so the portal can re-register itself), but only the MCP
 * portal may actually initiate a Google OAuth flow. The portal is identified by its
 * registered redirect_uri — Cloudflare Access's fixed outbound-oauth-callback,
 * configured in PORTAL_REDIRECT_URI (comma-separated allowlist).
 *
 * This holds even though an attacker can register a client claiming the portal's
 * redirect: OAuth delivers the authorization code to that redirect — Cloudflare's
 * callback — so an impostor passes this check yet never receives the code. Fail-closed:
 * an unset/empty allowlist rejects everything.
 */
function splitAllowlist(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isPortalRedirect(
  redirectUri: string | undefined,
  allowlist: string | undefined,
  prefixAllowlist?: string | undefined,
): boolean {
  if (!redirectUri) return false;
  // Exact match: the per-user runtime outbound-oauth-callback.
  if (splitAllowlist(allowlist).includes(redirectUri)) return true;
  // Prefix match: the dashboard per-server sync/authenticate callback (account-pinned).
  return splitAllowlist(prefixAllowlist).some((p) => redirectUri.startsWith(p));
}

const PORTAL_ONLY_MESSAGE =
  "This Google Workspace MCP server is only reachable through the MCP portal. Direct connection is not permitted.";

/** Where Google sends the user back. Must EXACTLY match an Authorized redirect URI. */
function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

function buildGoogleRedirect(
  request: Request,
  stateToken: string,
  headers: Record<string, string> = {},
): Response {
  const authorizeUrl = new URL(GOOGLE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl(request));
  authorizeUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", stateToken);
  // offline + consent are what yield a refresh_token (Google's offline_access equivalent).
  // Google only returns refresh_token on first consent; prompt=consent forces it each time
  // so a re-auth always re-establishes a refresh token.
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");
  authorizeUrl.searchParams.set("include_granted_scopes", "true");
  return new Response(null, {
    status: 302,
    headers: { ...headers, location: authorizeUrl.href },
  });
}

app.get("/authorize", async (c) => {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (error: any) {
    // parseAuthRequest rejects client errors — unknown client, a redirect_uri not
    // registered to the client, a disallowed PKCE method. Those are 400s, not 500s.
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text(`Invalid authorization request: ${error?.message ?? "unknown"}`, 400);
  }

  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  // Portal lockdown: refuse any flow not bound for the portal's redirect_uri.
  if (
    !isPortalRedirect(
      oauthReqInfo.redirectUri,
      c.env.PORTAL_REDIRECT_URI,
      c.env.PORTAL_REDIRECT_URI_PREFIXES,
    )
  ) {
    return c.text(PORTAL_ONLY_MESSAGE, 403);
  }

  // Returning client that already consented — skip the dialog, still bind state to session.
  if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
    const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie } = await bindStateToSession(stateToken);
    return buildGoogleRedirect(c.req.raw, stateToken, { "Set-Cookie": setCookie });
  }

  const { token: csrfToken, setCookie } = generateCSRFProtection();
  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: SERVER_INFO,
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");
    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };
    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }
    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }

    // Portal lockdown (defense in depth — the GET path already gated this).
    if (
      !isPortalRedirect(
        state.oauthReqInfo.redirectUri,
        c.env.PORTAL_REDIRECT_URI,
        c.env.PORTAL_REDIRECT_URI_PREFIXES,
      )
    ) {
      return c.text(PORTAL_ONLY_MESSAGE, 403);
    }

    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );
    const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
    const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return buildGoogleRedirect(c.req.raw, stateToken, Object.fromEntries(headers));
  } catch (error: any) {
    console.error("POST /authorize error:", error);
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text(`Internal server error: ${error?.message ?? "unknown"}`, 500);
  }
});

app.get("/callback", async (c) => {
  // Validate state (KV one-time token + session-binding cookie) before trusting `code`.
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;
  try {
    const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  // Surface a user-denied consent (Google appends ?error=access_denied).
  const oauthError = c.req.query("error");
  if (oauthError) {
    return c.text(`Google authorization was not completed: ${oauthError}`, 400);
  }

  const code = c.req.query("code");
  if (!code) {
    return c.text("Missing authorization code", 400);
  }

  let tokens: GoogleTokenResponse;
  try {
    tokens = await exchangeGoogleCode(c.env, code, callbackUrl(c.req.raw));
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }
    return c.text("Token exchange failed", 502);
  }

  // Granular consent: refuse a partial grant NOW, with the unchecked boxes by name,
  // instead of issuing a connection that fails later on whichever tool lost its scope.
  const missing = missingGoogleScopes(tokens.scope);
  if (missing.length > 0) {
    const names = missing.map((s) => SCOPE_LABELS[s] ?? s).join(", ");
    return c.text(
      `Google sign-in is missing required permissions: ${names}.\n\n` +
        "This usually means some checkboxes were left unchecked on Google's consent " +
        "screen. Please start the connection again and leave every permission checkbox " +
        'checked ("Select all" if shown) — the sign-in always re-prompts for consent.',
      400,
    );
  }

  if (!tokens.refresh_token) {
    // No refresh token — refresh would be impossible. Fail loudly rather than issue a
    // grant that breaks on first refresh. Usually means a prior consent already granted
    // offline access; revoke at myaccount.google.com/permissions and retry.
    return c.text(
      "Google did not return a refresh token. Revoke this app at " +
        "https://myaccount.google.com/permissions and sign in again (we request " +
        "access_type=offline & prompt=consent).",
      400,
    );
  }

  const user = await fetchGoogleUser(tokens.access_token);

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    metadata: { label: user.name ?? user.email ?? user.id },
    props: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      grantedScopes: tokens.scope,
      user,
    },
    request: oauthReqInfo,
    scope: oauthReqInfo.scope,
    userId: user.id,
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }
  return new Response(null, { status: 302, headers });
});

export { app as GoogleHandler };
