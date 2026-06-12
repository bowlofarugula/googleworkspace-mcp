import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type {
  TokenExchangeCallbackOptions,
  TokenExchangeCallbackResult,
} from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { GOOGLE_TOKEN_URL, GoogleHandler, type GoogleTokenResponse } from "./google-handler";
import { GoogleContext, registerGoogleTools } from "./tools";
import type { Env, Props } from "./types";
import { OAuthError } from "./workers-oauth-utils";

/** No durable per-session state is needed — Google grants are single-user. */
type State = Record<string, never>;

/**
 * The Google Workspace MCP server. One Durable Object instance per authenticated grant;
 * the decrypted auth context (Google tokens + identity) is available as `this.props`.
 */
export class GoogleWorkspaceMCP extends McpAgent<Env, State, Props> {
  server = new McpServer(
    { name: "Google Workspace", version: "1.0.0" },
    {
      instructions:
        "Google Workspace automation. Use these tools whenever the user mentions Gmail, " +
        "Google Calendar, Google Drive, Docs, Sheets, Slides, or Tasks — especially to " +
        "CREATE or EDIT things. Capabilities: send email and manage drafts (Gmail); create, " +
        "update, delete, and list calendar events (Calendar); create files, upload from a " +
        "URL, make folders, export/convert, and organize app-created files (Drive); author " +
        "and edit documents, spreadsheets, and presentations by id, including text, values, " +
        "and slides (Docs/Sheets/Slides); and manage task lists and tasks (Tasks). These act " +
        "as the signed-in Google user and only touch what that user can access. Reads are " +
        "deliberately limited (no full-inbox or full-Drive crawl) — the value is write/" +
        "automation. List tools return { items, next_cursor }; pass next_cursor as the next " +
        "page_token. Drive create/upload returns app-created files; Docs/Sheets/Slides edits " +
        "work on any file the user can open by id.",
    },
  );
  initialState: State = {};

  async init(): Promise<void> {
    const ctx = new GoogleContext(
      () => this.props!.accessToken,
      () => this.props!.user,
    );
    registerGoogleTools(this.server, ctx);
  }
}

/**
 * Keeps the MCP access-token lifecycle in lock-step with Google OAuth.
 *
 * - On the initial code exchange, cap the MCP access token's TTL to Google's
 *   `expires_in` so we never hand out an MCP token that outlives the upstream one.
 * - On MCP refresh, refresh against Google too. Unlike Adobe IMS, Google does NOT
 *   rotate the refresh token on refresh, so we keep the stored one. A failed refresh
 *   throws `invalid_grant`, forcing the client to re-authenticate.
 */
async function tokenExchangeCallback(
  options: TokenExchangeCallbackOptions,
): Promise<TokenExchangeCallbackResult | void> {
  const props = options.props as Props;

  if (options.grantType === "authorization_code") {
    return { accessTokenTTL: props.expiresIn, newProps: { ...props } };
  }

  if (options.grantType === "refresh_token") {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: props.refreshToken,
      }),
    });

    if (!resp.ok) {
      // Terminal: surface as invalid_grant so the client re-runs the full auth flow.
      throw new OAuthError("invalid_grant", "Google token refresh failed; re-authenticate", 400);
    }

    const tokens = (await resp.json()) as GoogleTokenResponse;
    const updated: Props = {
      ...props,
      accessToken: tokens.access_token,
      // Google does NOT return a new refresh token on refresh; keep the existing one.
      refreshToken: tokens.refresh_token ?? props.refreshToken,
      expiresIn: tokens.expires_in,
    };

    return {
      accessTokenProps: updated,
      newProps: updated,
      accessTokenTTL: tokens.expires_in,
    };
  }
}

export default new OAuthProvider({
  apiHandlers: {
    "/mcp": GoogleWorkspaceMCP.serve("/mcp"),
    "/sse": GoogleWorkspaceMCP.serveSSE("/sse"),
  },
  defaultHandler: GoogleHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  tokenExchangeCallback,
});
