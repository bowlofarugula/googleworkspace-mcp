import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok, pageInputs } from "./helpers";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** UTF-8-safe base64url (no padding) — Gmail's `raw` message encoding. */
function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2047 encoded-word for a header value when it contains non-ASCII. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${btoa(unescape(encodeURIComponent(value)))}?=`;
}

interface MailInput {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: boolean;
}

/** Build a base64url-encoded RFC 822 message for the Gmail `raw` field. */
function buildRaw({ to, cc, bcc, subject, body, html }: MailInput): string {
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${html ? "html" : "plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  return b64url(`${headers.join("\r\n")}\r\n\r\n${body}`);
}

const mailSchema = {
  to: z.string().describe("Recipient address(es), comma-separated."),
  cc: z.string().optional().describe("Cc address(es), comma-separated."),
  bcc: z.string().optional().describe("Bcc address(es), comma-separated."),
  subject: z.string().describe("Email subject."),
  body: z.string().describe("Email body."),
  html: z.boolean().optional().describe("If true, body is sent as text/html (default plain)."),
};

/** Gmail: send and manage drafts (scopes gmail.send + gmail.compose — no inbox read). */
export function registerGmailTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "send_email",
    {
      description: "Send an email immediately as the signed-in user.",
      inputSchema: mailSchema,
    },
    async (args) => {
      try {
        const res = await ctx.request("POST", `${GMAIL}/messages/send`, {
          body: { raw: buildRaw(args) },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_draft",
    {
      description: "Create a Gmail draft (not sent). Returns the draft id.",
      inputSchema: mailSchema,
    },
    async (args) => {
      try {
        const res = await ctx.request("POST", `${GMAIL}/drafts`, {
          body: { message: { raw: buildRaw(args) } },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_draft",
    {
      description: "Replace the contents of an existing draft.",
      inputSchema: {
        draft_id: z.string().describe("Draft id (from create_draft/list_drafts)."),
        ...mailSchema,
      },
    },
    async ({ draft_id, ...args }) => {
      try {
        const res = await ctx.request("PUT", `${GMAIL}/drafts/${draft_id}`, {
          body: { message: { raw: buildRaw(args) } },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "send_draft",
    {
      description: "Send an existing draft.",
      inputSchema: { draft_id: z.string().describe("Draft id to send.") },
    },
    async ({ draft_id }) => {
      try {
        const res = await ctx.request("POST", `${GMAIL}/drafts/send`, { body: { id: draft_id } });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "list_drafts",
    {
      description: "List the user's Gmail drafts (ids + minimal message refs).",
      inputSchema: { ...pageInputs },
    },
    async ({ page_size, page_token }) => {
      try {
        const res = await ctx.request<{ drafts?: unknown[]; nextPageToken?: string }>(
          "GET",
          `${GMAIL}/drafts`,
          { query: { maxResults: page_size, pageToken: page_token } },
        );
        return ok({ items: res.drafts ?? [], next_cursor: res.nextPageToken ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
