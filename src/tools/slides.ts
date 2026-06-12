import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok } from "./helpers";

const SLIDES = "https://slides.googleapis.com/v1/presentations";

/**
 * Google Slides: create and edit presentations (scope presentations for any deck by id;
 * drive.file for app-created decks).
 */
export function registerSlidesTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "create_presentation",
    {
      description: "Create a Google Slides presentation. Returns the presentationId.",
      inputSchema: { title: z.string().describe("Presentation title.") },
    },
    async ({ title }) => {
      try {
        return ok(await ctx.request("POST", SLIDES, { body: { title } }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_presentation",
    {
      description: "Fetch a presentation's structure (slides, page elements, ids).",
      inputSchema: { presentation_id: z.string().describe("Presentation id.") },
    },
    async ({ presentation_id }) => {
      try {
        return ok(await ctx.request("GET", `${SLIDES}/${presentation_id}`));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_slide",
    {
      description:
        "Add a new slide to a presentation, optionally with a predefined layout. Returns the " +
        "created slide's objectId.",
      inputSchema: {
        presentation_id: z.string().describe("Presentation id."),
        layout: z
          .string()
          .optional()
          .describe(
            "Predefined layout, e.g. TITLE_AND_BODY, TITLE, BLANK, SECTION_HEADER (default TITLE_AND_BODY).",
          ),
      },
    },
    async ({ presentation_id, layout }) => {
      try {
        const res = await ctx.request("POST", `${SLIDES}/${presentation_id}:batchUpdate`, {
          body: {
            requests: [
              {
                createSlide: {
                  slideLayoutReference: { predefinedLayout: layout ?? "TITLE_AND_BODY" },
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
    "batch_update_presentation",
    {
      description:
        "Apply raw Slides API batchUpdate requests for advanced edits (insert text into shapes, " +
        "create text boxes/images, styling). Pass the `requests` array from the Slides API reference.",
      inputSchema: {
        presentation_id: z.string().describe("Presentation id."),
        requests: z.array(z.any()).describe("Array of Slides API Request objects."),
      },
    },
    async ({ presentation_id, requests }) => {
      try {
        return ok(
          await ctx.request("POST", `${SLIDES}/${presentation_id}:batchUpdate`, {
            body: { requests },
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
