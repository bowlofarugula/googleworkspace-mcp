import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, type GoogleContext, ok, omitUndefined, pageInputs } from "./helpers";

const CAL = "https://www.googleapis.com/calendar/v3/calendars";

/** Build a Calendar time object: a bare date → all-day; otherwise a dateTime. */
function timePoint(value: string, timeZone?: string): Record<string, string> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return omitUndefined({ dateTime: value, timeZone }) as Record<string, string>;
}

function attendeeList(csv?: string): { email: string }[] | undefined {
  if (!csv) return undefined;
  return csv
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

/** Google Calendar: create/update/delete/list events (scope calendar.events). */
export function registerCalendarTools(server: McpServer, ctx: GoogleContext): void {
  const calendarId = z.string().optional().describe('Calendar id (default "primary").');

  server.registerTool(
    "list_events",
    {
      description: "List events on a calendar, optionally within a time window.",
      inputSchema: {
        calendar_id: calendarId,
        time_min: z.string().optional().describe("RFC3339 lower bound (event end >= this)."),
        time_max: z.string().optional().describe("RFC3339 upper bound (event start <= this)."),
        query: z.string().optional().describe("Free-text search over event fields."),
        ...pageInputs,
      },
    },
    async ({ calendar_id, time_min, time_max, query, page_size, page_token }) => {
      try {
        const res = await ctx.request<{ items?: unknown[]; nextPageToken?: string }>(
          "GET",
          `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events`,
          {
            query: {
              timeMin: time_min,
              timeMax: time_max,
              q: query,
              maxResults: page_size,
              pageToken: page_token,
              singleEvents: true,
              orderBy: "startTime",
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
    "get_event",
    {
      description: "Show one calendar event's full details.",
      inputSchema: { calendar_id: calendarId, event_id: z.string().describe("Event id.") },
    },
    async ({ calendar_id, event_id }) => {
      try {
        return ok(
          await ctx.request(
            "GET",
            `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events/${event_id}`,
          ),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "create_event",
    {
      description:
        "Create a calendar event. start/end accept a bare date (YYYY-MM-DD → all-day) or an " +
        "RFC3339 dateTime (e.g. 2026-06-10T15:00:00-07:00).",
      inputSchema: {
        calendar_id: calendarId,
        summary: z.string().describe("Event title."),
        start: z.string().describe("Start: YYYY-MM-DD (all-day) or RFC3339 dateTime."),
        end: z.string().describe("End: YYYY-MM-DD (all-day) or RFC3339 dateTime."),
        time_zone: z
          .string()
          .optional()
          .describe('IANA tz for dateTime starts/ends, e.g. "America/Los_Angeles".'),
        description: z.string().optional().describe("Event description/notes."),
        location: z.string().optional().describe("Event location."),
        attendees: z.string().optional().describe("Comma-separated attendee emails."),
        send_updates: z
          .enum(["all", "externalOnly", "none"])
          .optional()
          .describe("Whether to email attendees about the new event (default none)."),
      },
    },
    async ({
      calendar_id,
      summary,
      start,
      end,
      time_zone,
      description,
      location,
      attendees,
      send_updates,
    }) => {
      try {
        const res = await ctx.request(
          "POST",
          `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events`,
          {
            query: { sendUpdates: send_updates },
            body: omitUndefined({
              summary,
              description,
              location,
              start: timePoint(start, time_zone),
              end: timePoint(end, time_zone),
              attendees: attendeeList(attendees),
            }),
          },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "update_event",
    {
      description: "Patch fields on an existing event (only provided fields change).",
      inputSchema: {
        calendar_id: calendarId,
        event_id: z.string().describe("Event id to update."),
        summary: z.string().optional().describe("New title."),
        start: z.string().optional().describe("New start: YYYY-MM-DD or RFC3339 dateTime."),
        end: z.string().optional().describe("New end: YYYY-MM-DD or RFC3339 dateTime."),
        time_zone: z.string().optional().describe("IANA tz for dateTime starts/ends."),
        description: z.string().optional().describe("New description."),
        location: z.string().optional().describe("New location."),
        attendees: z
          .string()
          .optional()
          .describe("Comma-separated attendee emails (replaces the list)."),
        send_updates: z
          .enum(["all", "externalOnly", "none"])
          .optional()
          .describe("Notify attendees (default none)."),
      },
    },
    async ({
      calendar_id,
      event_id,
      summary,
      start,
      end,
      time_zone,
      description,
      location,
      attendees,
      send_updates,
    }) => {
      try {
        const res = await ctx.request(
          "PATCH",
          `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events/${event_id}`,
          {
            query: { sendUpdates: send_updates },
            body: omitUndefined({
              summary,
              description,
              location,
              start: start ? timePoint(start, time_zone) : undefined,
              end: end ? timePoint(end, time_zone) : undefined,
              attendees: attendeeList(attendees),
            }),
          },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "delete_event",
    {
      description: "Delete a calendar event.",
      inputSchema: {
        calendar_id: calendarId,
        event_id: z.string().describe("Event id to delete."),
        send_updates: z
          .enum(["all", "externalOnly", "none"])
          .optional()
          .describe("Notify attendees (default none)."),
      },
    },
    async ({ calendar_id, event_id, send_updates }) => {
      try {
        await ctx.request(
          "DELETE",
          `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events/${event_id}`,
          { query: { sendUpdates: send_updates } },
        );
        return ok({ deleted: event_id });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "quick_add_event",
    {
      description:
        'Create an event from natural language, e.g. "Lunch with Sam tomorrow 12pm". Calendar parses it.',
      inputSchema: {
        calendar_id: calendarId,
        text: z.string().describe("Natural-language event description."),
      },
    },
    async ({ calendar_id, text }) => {
      try {
        const res = await ctx.request(
          "POST",
          `${CAL}/${encodeURIComponent(calendar_id ?? "primary")}/events/quickAdd`,
          { query: { text } },
        );
        return ok(res);
      } catch (e) {
        return fail(e);
      }
    },
  );
}
