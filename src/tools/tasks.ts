import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok, omitUndefined, pageInputs } from "./helpers";

const TASKS = "https://tasks.googleapis.com/tasks/v1";

/** Google Tasks: manage task lists and tasks (scope tasks). */
export function registerTasksTools(server: McpServer, ctx: GoogleContext): void {
  server.registerTool(
    "list_tasklists",
    {
      description: "List the user's task lists (each has an id used by the task tools).",
      inputSchema: { ...pageInputs },
    },
    async ({ page_size, page_token }) => {
      try {
        const res = await ctx.request<{ items?: unknown[]; nextPageToken?: string }>(
          "GET",
          `${TASKS}/users/@me/lists`,
          { query: { maxResults: page_size, pageToken: page_token } },
        );
        return ok({ items: res.items ?? [], next_cursor: res.nextPageToken ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  const tasklist = z
    .string()
    .optional()
    .describe('Task list id (default "@default" — the user\'s primary list).');

  server.registerTool(
    "list_tasks",
    {
      description: "List tasks in a task list.",
      inputSchema: {
        tasklist_id: tasklist,
        show_completed: z.boolean().optional().describe("Include completed tasks (default false)."),
        ...pageInputs,
      },
    },
    async ({ tasklist_id, show_completed, page_size, page_token }) => {
      try {
        const res = await ctx.request<{ items?: unknown[]; nextPageToken?: string }>(
          "GET",
          `${TASKS}/lists/${tasklist_id ?? "@default"}/tasks`,
          {
            query: {
              showCompleted: show_completed ?? false,
              showHidden: show_completed ?? false,
              maxResults: page_size,
              pageToken: page_token,
            },
          },
        );
        return ok({ items: res.items ?? [], next_cursor: res.nextPageToken ?? null });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_task",
    {
      description: "Create a task in a task list.",
      inputSchema: {
        tasklist_id: tasklist,
        title: z.string().describe("Task title."),
        notes: z.string().optional().describe("Task notes/details."),
        due: z
          .string()
          .optional()
          .describe("Due date as RFC3339 (date portion is used), e.g. 2026-06-12T00:00:00Z."),
      },
    },
    async ({ tasklist_id, title, notes, due }) => {
      try {
        const res = await ctx.request("POST", `${TASKS}/lists/${tasklist_id ?? "@default"}/tasks`, {
          body: omitUndefined({ title, notes, due }),
        });
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_task",
    {
      description: "Update a task's title, notes, or due date.",
      inputSchema: {
        tasklist_id: tasklist,
        task_id: z.string().describe("Task id."),
        title: z.string().optional().describe("New title."),
        notes: z.string().optional().describe("New notes."),
        due: z.string().optional().describe("New due date (RFC3339)."),
      },
    },
    async ({ tasklist_id, task_id, title, notes, due }) => {
      try {
        const res = await ctx.request(
          "PATCH",
          `${TASKS}/lists/${tasklist_id ?? "@default"}/tasks/${task_id}`,
          { body: omitUndefined({ title, notes, due }) },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "complete_task",
    {
      description: "Mark a task completed (or reopen it with completed=false).",
      inputSchema: {
        tasklist_id: tasklist,
        task_id: z.string().describe("Task id."),
        completed: z.boolean().optional().describe("True to complete (default), false to reopen."),
      },
    },
    async ({ tasklist_id, task_id, completed }) => {
      try {
        const status = completed === false ? "needsAction" : "completed";
        const res = await ctx.request(
          "PATCH",
          `${TASKS}/lists/${tasklist_id ?? "@default"}/tasks/${task_id}`,
          { body: { status } },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_task",
    {
      description: "Delete a task from a task list.",
      inputSchema: {
        tasklist_id: tasklist,
        task_id: z.string().describe("Task id to delete."),
      },
    },
    async ({ tasklist_id, task_id }) => {
      try {
        await ctx.request("DELETE", `${TASKS}/lists/${tasklist_id ?? "@default"}/tasks/${task_id}`);
        return ok({ deleted: task_id });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
