import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fail, type GoogleContext, ok } from "./helpers";

/** Identity. */
export function registerIdentityTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "whoami",
    {
      description: "Return the signed-in Google user's profile (id, name, email).",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(ctx.user());
      } catch (e) {
        return fail(e);
      }
    },
  );
}
