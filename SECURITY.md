# Security

## Reporting a vulnerability

Please report security issues **privately** rather than opening a public issue:

- Use GitHub's [private vulnerability reporting](https://github.com/bowlofarugula/googleworkspace-mcp/security/advisories/new), or
- Email the maintainer (see the commit history / GitHub profile).

Please include reproduction steps and the affected version/commit. You'll get an
acknowledgement as soon as practical, and I'll make a best effort to address valid
reports promptly.

## How secrets and tokens are handled

- **Google tokens never reach the MCP client.** The Google OAuth access/refresh tokens are
  stored encrypted in the OAuth grant by
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
  and are surfaced to the Worker only as `this.props`. They are never logged or returned
  in tool output.
- **Server secrets are not in the repo.** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
  `COOKIE_ENCRYPTION_KEY` are set as Cloudflare Worker secrets (`wrangler secret put`).
  `.dev.vars` (local secrets) is git-ignored; only `.dev.vars.example` is tracked.
- **The Google credential is a confidential OAuth Web Application.** The client secret lives
  only in Worker secrets; `COOKIE_ENCRYPTION_KEY` (a random 32-byte hex) signs the
  approved-clients cookie.

## Scopes — deliberately CASA-free

This server requests only **sensitive-or-lower** OAuth scopes — **no restricted scopes**
(no `gmail.readonly`/`gmail.modify`/`mail.google.com`, no full `drive`/`drive.readonly`).
The value is **write/automation**, not bulk reading:

- `drive.file` (non-sensitive) — app-created files only.
- `gmail.send`, `gmail.compose` — send and draft; **no inbox read**.
- `calendar.events`, `tasks` — manage events and tasks.
- `documents`, `spreadsheets`, `presentations` — edit Docs/Sheets/Slides by id.

Avoiding restricted scopes keeps us out of Google's annual paid CASA security assessment;
only the free sensitive-scope verification (human review) applies.

## OAuth flow protections

- **Portal lockdown:** `/authorize` enforces a `PORTAL_REDIRECT_URI` allowlist — only
  requests whose `redirect_uri` is on the list may start the Google flow (others get `403`,
  fail-closed if unset). This prevents the public `*.workers.dev` URL from being used to
  bypass an upstream gateway, and holds even with open Dynamic Client Registration: the
  authorization code is delivered to the allow-listed redirect (the gateway's callback), so
  a client that merely *claims* it never receives the code. See **Access control** in the
  [README](README.md#access-control-portal-lockdown).
- **CSRF:** the approval form carries a one-time `__Host-CSRF_TOKEN` cookie (RFC 9700).
- **State binding:** the OAuth `state` is stored one-time in KV and bound to the browser
  session via a hashed `__Host-CONSENTED_STATE` cookie, so a leaked `state` can't be
  replayed from another session.
- **Cookies** use the `__Host-` prefix with `Secure`, `HttpOnly`, `SameSite=Lax`.
- **Output is escaped:** all client-supplied values rendered in the approval dialog are
  HTML-escaped, and redirect/URI values are scheme-validated (http/https only).
- **Offline access:** sign-in requests `access_type=offline` + `prompt=consent` to obtain a
  refresh token; a failed upstream refresh surfaces as `invalid_grant` to force
  re-authentication.

## Scope of trust

This project is a deployable Cloudflare Worker, not a published library. Running it means
operating your own Google OAuth credential and Cloudflare account; you are responsible for
the secrets you configure and the access your Google credential grants. Each user signs in
with their own Google account and the server only ever acts as that user.
