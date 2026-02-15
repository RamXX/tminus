/**
 * tminus-mcp -- MCP (Model Context Protocol) server worker.
 *
 * Exposes calendar tools via JSON-RPC for AI agent consumption.
 * Implements a minimal MCP-compatible HTTP handler:
 *   POST /mcp  -- JSON-RPC endpoint (tools/list, tools/call)
 *   GET /health -- Health check
 *
 * Retro constraint: Worker entrypoint must NOT export constants,
 * types, or utilities (workerd restriction).
 */

import { extractMcpAuth } from "./auth";
import type { McpUserContext } from "./auth";
import {
  addSecurityHeaders,
  addCorsHeaders,
  buildPreflightResponse,
} from "@tminus/shared";

// ---------------------------------------------------------------------------
// Env type (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface McpEnv {
  JWT_SECRET: string;
  DB: D1Database;
  ENVIRONMENT?: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC types (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  method: string;
  params?: Record<string, unknown>;
  id: string | number | null;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: JsonRpcError;
  id: string | number | null;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// MCP tool definitions (local to worker -- not exported)
// ---------------------------------------------------------------------------

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Registry of available MCP tools with their schemas. */
const TOOL_REGISTRY: McpToolDefinition[] = [
  {
    name: "calendar.list_accounts",
    description:
      "List all connected calendar accounts for the authenticated user. Returns account ID, provider, email, and sync status for each linked account.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC error codes (per spec)
// ---------------------------------------------------------------------------

/** Standard JSON-RPC error codes. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_INTERNAL_ERROR = -32603;
/** Application-level error: authentication required. */
const RPC_AUTH_REQUIRED = -32000;

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Execute calendar.list_accounts: query D1 for the authenticated user's
 * connected calendar accounts.
 */
async function handleListAccounts(
  user: McpUserContext,
  db: D1Database,
): Promise<unknown> {
  const result = await db
    .prepare(
      "SELECT account_id, provider, email, status FROM accounts WHERE user_id = ?1",
    )
    .bind(user.userId)
    .all<{
      account_id: string;
      provider: string;
      email: string;
      status: string;
    }>();

  return result.results ?? [];
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

/**
 * Parse and validate a JSON-RPC 2.0 request body.
 * Returns the parsed request or a JSON-RPC error response.
 */
function parseJsonRpcRequest(
  body: unknown,
): { request: JsonRpcRequest } | { error: JsonRpcResponse } {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body)
  ) {
    return {
      error: makeErrorResponse(null, RPC_INVALID_REQUEST, "Invalid Request"),
    };
  }

  const obj = body as Record<string, unknown>;

  if (obj.jsonrpc !== "2.0") {
    return {
      error: makeErrorResponse(
        (obj.id as string | number | null) ?? null,
        RPC_INVALID_REQUEST,
        'Invalid Request: jsonrpc must be "2.0"',
      ),
    };
  }

  if (typeof obj.method !== "string") {
    return {
      error: makeErrorResponse(
        (obj.id as string | number | null) ?? null,
        RPC_INVALID_REQUEST,
        "Invalid Request: method must be a string",
      ),
    };
  }

  // id may be string, number, or null; missing id means notification (we still respond)
  const id = obj.id !== undefined ? (obj.id as string | number | null) : null;

  return {
    request: {
      jsonrpc: "2.0",
      method: obj.method,
      params: (obj.params as Record<string, unknown>) ?? undefined,
      id,
    },
  };
}

/** Build a JSON-RPC success response. */
function makeSuccessResponse(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

/** Build a JSON-RPC error response. */
function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: { code, message, ...(data !== undefined ? { data } : {}) },
    id,
  };
}

/**
 * Dispatch a validated JSON-RPC request to the appropriate handler.
 * Handles tools/list and tools/call methods.
 */
async function dispatch(
  rpcReq: JsonRpcRequest,
  user: McpUserContext,
  db: D1Database,
): Promise<JsonRpcResponse> {
  switch (rpcReq.method) {
    case "tools/list": {
      return makeSuccessResponse(rpcReq.id, { tools: TOOL_REGISTRY });
    }

    case "tools/call": {
      const toolName = rpcReq.params?.name;
      if (typeof toolName !== "string") {
        return makeErrorResponse(
          rpcReq.id,
          RPC_INVALID_PARAMS,
          "Invalid params: tools/call requires params.name (string)",
        );
      }

      // Look up tool in registry
      const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
      if (!tool) {
        return makeErrorResponse(
          rpcReq.id,
          RPC_METHOD_NOT_FOUND,
          `Tool not found: ${toolName}`,
        );
      }

      // Dispatch to tool handler
      try {
        let result: unknown;
        switch (toolName) {
          case "calendar.list_accounts":
            result = await handleListAccounts(user, db);
            break;
          default:
            return makeErrorResponse(
              rpcReq.id,
              RPC_INTERNAL_ERROR,
              `Tool registered but no handler: ${toolName}`,
            );
        }

        return makeSuccessResponse(rpcReq.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Internal error";
        return makeErrorResponse(rpcReq.id, RPC_INTERNAL_ERROR, message);
      }
    }

    default:
      return makeErrorResponse(
        rpcReq.id,
        RPC_METHOD_NOT_FOUND,
        `Method not found: ${rpcReq.method}`,
      );
  }
}

// ---------------------------------------------------------------------------
// HTTP handler factory
// ---------------------------------------------------------------------------

/**
 * Create the MCP worker handler. Factory pattern allows tests to inject
 * dependencies and validate the full request flow.
 */
function createMcpHandler() {
  return {
    async fetch(
      request: Request,
      env: McpEnv,
      _ctx: ExecutionContext,
    ): Promise<Response> {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method;
      const origin = request.headers.get("Origin");
      const environment = env.ENVIRONMENT ?? "development";

      // Wrap response with security + CORS headers
      const finalize = (response: Response): Response => {
        const secured = addSecurityHeaders(response);
        return addCorsHeaders(secured, origin, environment);
      };

      // CORS preflight
      if (method === "OPTIONS") {
        const preflight = buildPreflightResponse(origin, environment);
        return addSecurityHeaders(preflight);
      }

      // Health check -- no auth required
      if (method === "GET" && pathname === "/health") {
        return finalize(
          new Response(
            JSON.stringify({ ok: true, status: "healthy" }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      }

      // MCP JSON-RPC endpoint
      if (method === "POST" && pathname === "/mcp") {
        return finalize(await handleMcpRequest(request, env));
      }

      // Not found
      return finalize(
        new Response(
          JSON.stringify(
            makeErrorResponse(null, RPC_METHOD_NOT_FOUND, "Not Found"),
          ),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    },
  };
}

/**
 * Handle a POST /mcp request: parse body, authenticate, dispatch JSON-RPC.
 */
async function handleMcpRequest(
  request: Request,
  env: McpEnv,
): Promise<Response> {
  // Parse request body
  let body: unknown;
  try {
    const text = await request.text();
    body = JSON.parse(text);
  } catch {
    const errorResp = makeErrorResponse(null, RPC_PARSE_ERROR, "Parse error");
    return new Response(JSON.stringify(errorResp), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Validate JSON-RPC structure
  const parsed = parseJsonRpcRequest(body);
  if ("error" in parsed) {
    return new Response(JSON.stringify(parsed.error), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rpcReq = parsed.request;

  // Authenticate via JWT
  const user = await extractMcpAuth(request, env.JWT_SECRET);
  if (!user) {
    const errorResp = makeErrorResponse(
      rpcReq.id,
      RPC_AUTH_REQUIRED,
      "Authentication required: provide a valid JWT in the Authorization header",
    );
    return new Response(JSON.stringify(errorResp), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Dispatch to method handler
  const result = await dispatch(rpcReq, user, env.DB);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Default export for Cloudflare Workers runtime
//
// IMPORTANT: No constants, types, or utilities are exported from this file.
// workerd restriction (retro learning): worker entrypoints that export
// non-handler values cause deployment failures.
// ---------------------------------------------------------------------------

const handler = createMcpHandler();
export default handler;

// Named exports for testing ONLY -- the createMcpHandler factory and
// internal helpers. These are functions, not constants/types, which are
// safe to export from a worker entrypoint.
export { createMcpHandler };
