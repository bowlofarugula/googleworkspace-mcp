import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, GoogleApiError, type GoogleContext, ok, omitUndefined, pageInputs } from "./helpers";

const DRIVE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Fields returned for a created/updated file — enough to act on next. */
const FILE_FIELDS = "id,name,mimeType,webViewLink,parents,createdTime,modifiedTime,size";

/** Fixed multipart boundary (no Math.random on Workers). */
const BOUNDARY = "googleworkspacemcp_boundary_8f2b";

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Build a multipart/related body (metadata JSON + media) for Drive uploadType=multipart. */
function multipartRelated(metadata: unknown, media: Uint8Array, mediaMime: string): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${BOUNDARY}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      `${JSON.stringify(metadata)}\r\n` +
      `--${BOUNDARY}\r\n` +
      `Content-Type: ${mediaMime}\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${BOUNDARY}--`);
  return concatBytes([head, media, tail]);
}

/** Google Drive: create/upload/organize app-created files (scope drive.file). */
export function registerDriveTools(server: McpServer, ctx: GoogleContext): void {
  async function upload(metadata: Record<string, unknown>, media: Uint8Array, mediaMime: string) {
    return ctx.request("POST", DRIVE_UPLOAD, {
      query: { uploadType: "multipart", fields: FILE_FIELDS, supportsAllDrives: true },
      headers: { "Content-Type": `multipart/related; boundary=${BOUNDARY}` },
      rawBody: multipartRelated(metadata, media, mediaMime),
    });
  }

  server.registerTool(
    "list_files",
    {
      description:
        "List Drive files this app can see (with drive.file: files it created or that were " +
        "explicitly opened with it). Supports a Drive query.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Drive query, e.g. \"name contains 'report'\" or \"mimeType='application/pdf'\".",
          ),
        ...pageInputs,
      },
    },
    async ({ query, page_size, page_token }) => {
      try {
        const res = await ctx.request<{ files?: unknown[]; nextPageToken?: string }>("GET", DRIVE, {
          query: {
            q: query,
            pageSize: page_size,
            pageToken: page_token,
            fields: `nextPageToken,files(${FILE_FIELDS})`,
          },
        });
        return ok({ items: res.files ?? [], next_cursor: res.nextPageToken ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_file",
    {
      description: "Show a Drive file's metadata.",
      inputSchema: { file_id: z.string().describe("Drive file id.") },
    },
    async ({ file_id }) => {
      try {
        return ok(
          await ctx.request("GET", `${DRIVE}/${file_id}`, { query: { fields: FILE_FIELDS } }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_file",
    {
      description:
        "Create a Drive file from text content. Set google_doc=true to convert into a native " +
        "Google Doc (use mime_type text/plain or text/html as the source).",
      inputSchema: {
        name: z.string().describe("File name."),
        content: z.string().describe("Text content of the file."),
        mime_type: z.string().optional().describe("Source MIME type (default text/plain)."),
        google_doc: z
          .boolean()
          .optional()
          .describe("If true, convert into a native Google Doc on import."),
        parent_folder_id: z
          .string()
          .optional()
          .describe("Parent folder id (default My Drive root)."),
      },
    },
    async ({ name, content, mime_type, google_doc, parent_folder_id }) => {
      try {
        const metadata = omitUndefined({
          name,
          parents: parent_folder_id ? [parent_folder_id] : undefined,
          mimeType: google_doc ? "application/vnd.google-apps.document" : undefined,
        });
        const res = await upload(
          metadata,
          new TextEncoder().encode(content),
          mime_type ?? "text/plain",
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "upload_from_url",
    {
      description:
        "Download a file from a public URL and store it in Drive (app-created). Mirrors a " +
        "remote upload — useful for ingesting an image, PDF, or export by URL.",
      inputSchema: {
        url: z.string().url().describe("Public URL to fetch the file bytes from."),
        name: z.string().describe("Name for the new Drive file."),
        mime_type: z
          .string()
          .optional()
          .describe("Override MIME type (default: the source response's Content-Type)."),
        parent_folder_id: z
          .string()
          .optional()
          .describe("Parent folder id (default My Drive root)."),
      },
    },
    async ({ url, name, mime_type, parent_folder_id }) => {
      try {
        const src = await fetch(url);
        if (!src.ok) {
          throw new GoogleApiError(src.status, null, `Source URL fetch failed (${src.status}).`);
        }
        const bytes = new Uint8Array(await src.arrayBuffer());
        const mime = mime_type ?? src.headers.get("content-type") ?? "application/octet-stream";
        const metadata = omitUndefined({
          name,
          parents: parent_folder_id ? [parent_folder_id] : undefined,
        });
        const res = await upload(metadata, bytes, mime);
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_folder",
    {
      description: "Create a Drive folder.",
      inputSchema: {
        name: z.string().describe("Folder name."),
        parent_folder_id: z
          .string()
          .optional()
          .describe("Parent folder id (default My Drive root)."),
      },
    },
    async ({ name, parent_folder_id }) => {
      try {
        const res = await ctx.request("POST", DRIVE, {
          query: { fields: FILE_FIELDS },
          body: omitUndefined({
            name,
            mimeType: FOLDER_MIME,
            parents: parent_folder_id ? [parent_folder_id] : undefined,
          }),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "rename_or_move_file",
    {
      description: "Rename a file and/or move it between folders.",
      inputSchema: {
        file_id: z.string().describe("Drive file id."),
        name: z.string().optional().describe("New name."),
        add_parent_folder_id: z.string().optional().describe("Folder id to move the file into."),
        remove_parent_folder_id: z
          .string()
          .optional()
          .describe("Folder id to remove the file from (the old parent)."),
      },
    },
    async ({ file_id, name, add_parent_folder_id, remove_parent_folder_id }) => {
      try {
        const res = await ctx.request("PATCH", `${DRIVE}/${file_id}`, {
          query: {
            fields: FILE_FIELDS,
            addParents: add_parent_folder_id,
            removeParents: remove_parent_folder_id,
          },
          body: omitUndefined({ name }),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "trash_file",
    {
      description: "Move a Drive file to the trash (reversible; not a permanent delete).",
      inputSchema: { file_id: z.string().describe("Drive file id to trash.") },
    },
    async ({ file_id }) => {
      try {
        const res = await ctx.request("PATCH", `${DRIVE}/${file_id}`, {
          query: { fields: "id,name,trashed" },
          body: { trashed: true },
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "export_file",
    {
      description:
        "Export a Google Doc/Sheet/Slides file to another format and store the result back in " +
        "Drive. Returns the new file. Example: export a Doc as application/pdf.",
      inputSchema: {
        file_id: z.string().describe("Source Google Workspace file id (Doc/Sheet/Slides)."),
        export_mime_type: z
          .string()
          .describe(
            "Target MIME, e.g. application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document.",
          ),
        name: z.string().describe("Name for the exported Drive file."),
        parent_folder_id: z.string().optional().describe("Parent folder id for the export."),
      },
    },
    async ({ file_id, export_mime_type, name, parent_folder_id }) => {
      try {
        // Export returns raw bytes (not JSON).
        const bytes = await ctx.requestBytes(
          `${DRIVE}/${file_id}/export?mimeType=${encodeURIComponent(export_mime_type)}`,
        );
        const metadata = omitUndefined({
          name,
          parents: parent_folder_id ? [parent_folder_id] : undefined,
        });
        const res = await upload(metadata, bytes, export_mime_type);
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_public_link",
    {
      description:
        "Make a Drive file shareable via link and return that link. WARNING: by default this " +
        "grants 'anyone with the link' access — the file becomes accessible to anyone on the " +
        "internet who has the URL, no sign-in required. Use `domain` to restrict the link to a " +
        "Google Workspace domain instead. Returns webViewLink (open in browser) and, for binary " +
        "files, webContentLink (direct download). Use revoke_public_link to undo.",
      inputSchema: {
        file_id: z.string().describe("Drive file id to share."),
        role: z
          .enum(["reader", "commenter", "writer"])
          .optional()
          .describe("Access level granted to link holders (default reader / view-only)."),
        domain: z
          .string()
          .optional()
          .describe(
            "If set, restrict the link to this Google Workspace domain (type=domain) instead of " +
              "public 'anyone'. e.g. \"example.com\".",
          ),
      },
    },
    async ({ file_id, role, domain }) => {
      try {
        const permission = domain
          ? { type: "domain", role: role ?? "reader", domain }
          : { type: "anyone", role: role ?? "reader" };
        const created = await ctx.request("POST", `${DRIVE}/${file_id}/permissions`, {
          query: { fields: "id,type,role", supportsAllDrives: true },
          body: permission,
        });
        // Fetch the shareable links now that the permission is in place.
        const file = await ctx.request("GET", `${DRIVE}/${file_id}`, {
          query: { fields: "id,name,webViewLink,webContentLink", supportsAllDrives: true },
        });
        return ok({ permission: created, ...file });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "revoke_public_link",
    {
      description:
        "Remove link sharing from a Drive file, making it private again. Deletes the file's " +
        "'anyone'/domain permission (pass permission_id to target a specific one).",
      inputSchema: {
        file_id: z.string().describe("Drive file id to make private."),
        permission_id: z
          .string()
          .optional()
          .describe(
            "Specific permission id to remove (from create_public_link). Defaults to the " +
              "'anyone' permission.",
          ),
      },
    },
    async ({ file_id, permission_id }) => {
      try {
        let pid = permission_id;
        if (!pid) {
          // Find the 'anyone' permission to remove.
          const list = await ctx.request<{ permissions?: { id: string; type: string }[] }>(
            "GET",
            `${DRIVE}/${file_id}/permissions`,
            { query: { fields: "permissions(id,type)", supportsAllDrives: true } },
          );
          pid = (list.permissions ?? []).find((p) => p.type === "anyone")?.id;
          if (!pid) {
            return ok({ file_id, removed: null, note: "No 'anyone' link permission found." });
          }
        }
        await ctx.request("DELETE", `${DRIVE}/${file_id}/permissions/${pid}`, {
          query: { supportsAllDrives: true },
        });
        return ok({ file_id, removed: pid });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
