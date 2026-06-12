import { z } from "zod";
import type { GoogleUser } from "../types";

/** Returns the current grant's Google OAuth access token. */
export type TokenGetter = () => string;

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Compact JSON text result. */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/** An error from a Google REST API call, carrying the HTTP status and parsed body. */
export class GoogleApiError extends Error {
  constructor(
    public statusCode: number,
    public body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** Map a thrown error to a user-actionable MCP error result. */
export function fail(error: unknown): ToolResult {
  if (error instanceof GoogleApiError) {
    const status = error.statusCode;
    let hint = "";
    if (status === 401) hint = " — access token rejected; re-authenticate.";
    else if (status === 403)
      hint =
        " — insufficient permission or scope. drive.file only reaches files this app created; " +
        "Docs/Sheets/Slides edits need the file shared with you.";
    else if (status === 404) hint = " — not found (check the id).";
    else if (status === 429) hint = " — rate limited; retry after a short delay.";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Google API error (${status})${hint}\n${JSON.stringify(error.body)}`,
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

/** Shared pagination inputs for list tools (Google uses pageToken/pageSize). */
export const pageInputs = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max items per page (1-100; API default varies)."),
  page_token: z
    .string()
    .optional()
    .describe("Opaque pageToken from a previous response's next_cursor."),
};

/** Drop keys whose value is undefined (for clean payloads / query strings). */
export function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

interface RequestOptions {
  /** Query-string params; undefined values are dropped, others stringified. */
  query?: Record<string, string | number | boolean | undefined>;
  /** JSON request body (object) — serialized and sent as application/json. */
  body?: unknown;
  /** Raw body (string/ArrayBuffer) when you need a non-JSON content type. */
  rawBody?: BodyInit;
  /** Extra/override headers (e.g. a different Content-Type for media uploads). */
  headers?: Record<string, string>;
}

/**
 * Per-session Google context: holds the access token and identity, and issues
 * authenticated REST calls to Google Workspace APIs via `fetch` (no Node SDK — it
 * doesn't run on Workers). All tools go through `request`, which attaches the bearer,
 * parses JSON, and throws GoogleApiError on a non-2xx status.
 */
export class GoogleContext {
  constructor(
    private getToken: TokenGetter,
    private getUser: () => GoogleUser,
  ) {}

  user(): GoogleUser {
    return this.getUser();
  }

  /** Issue an authenticated request to an absolute Google API URL. Returns parsed JSON. */
  async request<T = any>(
    method: string,
    url: string,
    { query, body, rawBody, headers }: RequestOptions = {},
  ): Promise<T> {
    const u = new URL(url);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
    }

    const h: Record<string, string> = {
      Authorization: `Bearer ${this.getToken()}`,
      Accept: "application/json",
      ...headers,
    };
    let payload: BodyInit | undefined;
    if (rawBody !== undefined) {
      payload = rawBody;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      h["Content-Type"] ??= "application/json";
    }

    const resp = await fetch(u.href, { method, headers: h, body: payload });

    // 204 No Content (and other empty bodies) — return an empty object.
    const text = await resp.text();
    let parsed: any = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!resp.ok) {
      const message =
        parsed?.error?.message ?? (typeof parsed === "string" ? parsed : `HTTP ${resp.status}`);
      throw new GoogleApiError(resp.status, parsed ?? null, message);
    }
    return (parsed ?? {}) as T;
  }

  /**
   * Authenticated GET that returns raw bytes (for endpoints like Drive `export` that
   * respond with a file body rather than JSON). Throws GoogleApiError on a non-2xx.
   */
  async requestBytes(url: string): Promise<Uint8Array> {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.getToken()}` } });
    if (!resp.ok) {
      const detail = await resp.text();
      const parsed = detail ? safeJson(detail) : null;
      const message = parsed?.error?.message ?? `HTTP ${resp.status}`;
      throw new GoogleApiError(resp.status, parsed ?? detail, message);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
