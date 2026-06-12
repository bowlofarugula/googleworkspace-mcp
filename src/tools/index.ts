import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCalendarTools } from "./calendar";
import { registerDocsTools } from "./docs";
import { registerDriveTools } from "./drive";
import { registerGmailTools } from "./gmail";
import { GoogleContext } from "./helpers";
import { registerIdentityTools } from "./identity";
import { registerSheetsTools } from "./sheets";
import { registerSlidesTools } from "./slides";
import { registerTasksTools } from "./tasks";

export { GoogleContext } from "./helpers";

/** Register the full Google Workspace tool set on the MCP server. */
export function registerGoogleTools(server: McpServer, ctx: GoogleContext): void {
  registerIdentityTools(server, ctx);
  registerGmailTools(server, ctx);
  registerCalendarTools(server, ctx);
  registerDriveTools(server, ctx);
  registerDocsTools(server, ctx);
  registerSheetsTools(server, ctx);
  registerSlidesTools(server, ctx);
  registerTasksTools(server, ctx);
}
