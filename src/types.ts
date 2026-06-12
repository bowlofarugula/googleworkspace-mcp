/**
 * Shared types for the Google Workspace MCP server.
 */

/** Minimal identity captured from Google at auth time, for display/labels. */
export interface GoogleUser {
  id: string;
  name?: string;
  email?: string;
}

/**
 * Auth context, encrypted by workers-oauth-provider and surfaced as `this.props`
 * inside the McpAgent. Google tokens NEVER reach the MCP client — they live here,
 * stored encrypted in the grant.
 */
export interface Props {
  /** Google OAuth access token, used as the Bearer for all Workspace REST calls. */
  accessToken: string;
  /**
   * Google OAuth refresh token. Google issues this only on the FIRST consent
   * (access_type=offline + prompt=consent); it does NOT rotate on refresh, so the
   * same value persists across refreshes.
   */
  refreshToken: string;
  /** Lifetime of the access token in seconds, as reported by Google `expires_in`. */
  expiresIn: number;
  /**
   * Space-delimited scopes Google actually granted (token response `scope`). The
   * callback rejects partial grants, so this should match GOOGLE_SCOPES; kept for
   * diagnostics and so tools could explain scope errors.
   */
  grantedScopes?: string;
  /** Google identity, for the grant label and the whoami tool. */
  user: GoogleUser;
  [key: string]: unknown;
}

/**
 * Secrets and request-scoped bindings not derivable from wrangler.jsonc.
 * Bindings (OAUTH_KV, MCP_OBJECT) come from the wrangler-generated Env in
 * worker-configuration.d.ts; we merge the rest in below so a single `Env`
 * type covers both.
 */
interface SecretsAndInjected {
  /** Google Cloud OAuth Web Application client credential. */
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** Random 32-byte hex used to HMAC-sign the approved-clients cookie. */
  COOKIE_ENCRYPTION_KEY: string;
  /**
   * Portal lockdown allowlist (comma-separated redirect_uris). Only authorize flows
   * whose redirect_uri is on this list may initiate Google OAuth, so the public
   * workers.dev URL can't be used to bypass the MCP portal. See the gate
   * in google-handler.ts. Fail-closed: if unset, every /authorize is rejected.
   */
  PORTAL_REDIRECT_URI: string;
  /**
   * Portal lockdown PREFIX allowlist (comma-separated). An authorize flow also passes the
   * gate if its redirect_uri begins with one of these prefixes. Used for the dashboard
   * "Sync capabilities" / authenticate callback, which is per-server
   * (https://dash.cloudflare.com/<account>/one/access-controls/ai-controls/mcp-server/oauth-callback/<server-id>)
   * — one account-pinned prefix covers every server's sync without a redeploy
   * per server. Safe because the code is delivered to Cloudflare's dashboard backend for
   * that account (admin-session bound), not to the caller. Optional/fail-closed.
   */
  PORTAL_REDIRECT_URI_PREFIXES?: string;
  /** Injected by OAuthProvider for the default handler. */
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

declare global {
  interface Env extends SecretsAndInjected {}
  namespace Cloudflare {
    interface Env extends SecretsAndInjected {}
  }
}

/** Worker environment: wrangler bindings + secrets + injected helpers. */
export type Env = Cloudflare.Env;
