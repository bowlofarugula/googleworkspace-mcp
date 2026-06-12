import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok } from "./helpers";

const DOCS = "https://docs.googleapis.com/v1/documents";

/**
 * Google Docs: create and edit documents (scope documents for any doc by id;
 * drive.file for app-created docs).
 */
export function registerDocsTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "create_doc",
    {
      description:
        "Create a Google Doc, optionally with initial body text. Returns the documentId.",
      inputSchema: {
        title: z.string().describe("Document title."),
        text: z.string().optional().describe("Initial body text to insert."),
      },
    },
    async ({ title, text }) => {
      try {
        const doc = await ctx.request<{ documentId: string }>("POST", DOCS, { body: { title } });
        if (text) {
          await ctx.request("POST", `${DOCS}/${doc.documentId}:batchUpdate`, {
            body: { requests: [{ insertText: { endOfSegmentLocation: {}, text } }] },
          });
        }
        return ok(doc);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_doc",
    {
      description: "Fetch a Google Doc's structured content (title + body).",
      inputSchema: { document_id: z.string().describe("Document id.") },
    },
    async ({ document_id }) => {
      try {
        return ok(await ctx.request("GET", `${DOCS}/${document_id}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "insert_text",
    {
      description:
        "Insert text into a Google Doc. By default appends at the end; pass index to insert at a " +
        "specific character offset.",
      inputSchema: {
        document_id: z.string().describe("Document id."),
        text: z.string().describe("Text to insert."),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based character index to insert at (default: end of document)."),
      },
    },
    async ({ document_id, text, index }) => {
      try {
        const insertText =
          index === undefined ? { endOfSegmentLocation: {}, text } : { location: { index }, text };
        const res = await ctx.request("POST", `${DOCS}/${document_id}:batchUpdate`, {
          body: { requests: [{ insertText }] },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "replace_text",
    {
      description: "Replace all occurrences of a string in a Google Doc.",
      inputSchema: {
        document_id: z.string().describe("Document id."),
        find: z.string().describe("Text to find."),
        replace: z.string().describe("Replacement text."),
        match_case: z.boolean().optional().describe("Case-sensitive match (default false)."),
      },
    },
    async ({ document_id, find, replace, match_case }) => {
      try {
        const res = await ctx.request("POST", `${DOCS}/${document_id}:batchUpdate`, {
          body: {
            requests: [
              {
                replaceAllText: {
                  containsText: { text: find, matchCase: match_case ?? false },
                  replaceText: replace,
                },
              },
            ],
          },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "batch_update_doc",
    {
      description:
        "Apply raw Google Docs API batchUpdate requests for advanced edits (styling, tables, " +
        "images, deletes). Pass the `requests` array from the Docs API reference.",
      inputSchema: {
        document_id: z.string().describe("Document id."),
        requests: z.array(z.any()).describe("Array of Docs API Request objects."),
      },
    },
    async ({ document_id, requests }) => {
      try {
        return ok(
          await ctx.request("POST", `${DOCS}/${document_id}:batchUpdate`, { body: { requests } }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
