import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok } from "./helpers";

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * Google Sheets: create and edit spreadsheets (scope spreadsheets for any sheet by id;
 * drive.file for app-created sheets). Values are 2-D arrays of cells.
 */
export function registerSheetsTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "create_spreadsheet",
    {
      description: "Create a Google Sheet. Returns the spreadsheetId.",
      inputSchema: {
        title: z.string().describe("Spreadsheet title."),
        sheet_titles: z
          .array(z.string())
          .optional()
          .describe("Optional tab names to create (default a single 'Sheet1')."),
      },
    },
    async ({ title, sheet_titles }) => {
      try {
        const body: Record<string, unknown> = { properties: { title } };
        if (sheet_titles?.length) {
          body.sheets = sheet_titles.map((t) => ({ properties: { title: t } }));
        }
        return ok(await ctx.request("POST", SHEETS, { body }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_values",
    {
      description: "Read a range of cells. Returns the 2-D `values` array.",
      inputSchema: {
        spreadsheet_id: z.string().describe("Spreadsheet id."),
        range: z.string().describe("A1 range, e.g. 'Sheet1!A1:C10' or 'Sheet1'."),
      },
    },
    async ({ spreadsheet_id, range }) => {
      try {
        return ok(
          await ctx.request(
            "GET",
            `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}`,
          ),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "append_values",
    {
      description: "Append rows after the last row of data in a range.",
      inputSchema: {
        spreadsheet_id: z.string().describe("Spreadsheet id."),
        range: z.string().describe("A1 range whose table to append to, e.g. 'Sheet1!A1'."),
        values: z.array(z.array(z.any())).describe("Rows to append (array of row arrays)."),
        value_input: z
          .enum(["RAW", "USER_ENTERED"])
          .optional()
          .describe("USER_ENTERED parses formulas/dates (default); RAW stores verbatim."),
      },
    },
    async ({ spreadsheet_id, range, values, value_input }) => {
      try {
        const res = await ctx.request(
          "POST",
          `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}:append`,
          {
            query: {
              valueInputOption: value_input ?? "USER_ENTERED",
              insertDataOption: "INSERT_ROWS",
            },
            body: { values },
          },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_values",
    {
      description: "Overwrite the cells in a range with the given values.",
      inputSchema: {
        spreadsheet_id: z.string().describe("Spreadsheet id."),
        range: z.string().describe("A1 range to write, e.g. 'Sheet1!A1:C3'."),
        values: z.array(z.array(z.any())).describe("Rows to write (array of row arrays)."),
        value_input: z
          .enum(["RAW", "USER_ENTERED"])
          .optional()
          .describe("USER_ENTERED parses formulas/dates (default); RAW stores verbatim."),
      },
    },
    async ({ spreadsheet_id, range, values, value_input }) => {
      try {
        const res = await ctx.request(
          "PUT",
          `${SHEETS}/${spreadsheet_id}/values/${encodeURIComponent(range)}`,
          { query: { valueInputOption: value_input ?? "USER_ENTERED" }, body: { values } },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_sheet",
    {
      description: "Add a new tab (sheet) to an existing spreadsheet.",
      inputSchema: {
        spreadsheet_id: z.string().describe("Spreadsheet id."),
        title: z.string().describe("New tab title."),
      },
    },
    async ({ spreadsheet_id, title }) => {
      try {
        const res = await ctx.request("POST", `${SHEETS}/${spreadsheet_id}:batchUpdate`, {
          body: { requests: [{ addSheet: { properties: { title } } }] },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "batch_update_spreadsheet",
    {
      description:
        "Apply raw Sheets API batchUpdate requests for advanced edits (formatting, charts, " +
        "conditional formatting, deletes). Pass the `requests` array from the Sheets API reference.",
      inputSchema: {
        spreadsheet_id: z.string().describe("Spreadsheet id."),
        requests: z.array(z.any()).describe("Array of Sheets API Request objects."),
      },
    },
    async ({ spreadsheet_id, requests }) => {
      try {
        return ok(
          await ctx.request("POST", `${SHEETS}/${spreadsheet_id}:batchUpdate`, {
            body: { requests },
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );
}
