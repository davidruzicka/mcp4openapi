/**
 * JSON-RPC message validation utilities
 *
 * Why: Eliminates code duplication between http-transport.ts and mcp-server.ts
 * These functions validate JSON-RPC 2.0 message types used in MCP protocol.
 */

/**
 * Check if message is an initialize request
 */
export function isInitializeRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return req.method === 'initialize';
}

/**
 * Check if message is a tool call request
 */
export function isToolCallRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return req.method === 'tools/call';
}

/**
 * Check if message is a tools/list request
 */
export function isToolsListRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return req.method === 'tools/list';
}

/**
 * Check if message is a valid JSON-RPC request object
 */
export function isJsonRpcRequest(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const req = message as Record<string, unknown>;
  return (
    typeof req.jsonrpc === 'string' &&
    req.jsonrpc === '2.0' &&
    typeof req.method === 'string' &&
    'id' in req
  );
}

/**
 * Check if message is a valid JSON-RPC response object
 */
export function isJsonRpcResponse(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const resp = message as Record<string, unknown>;
  return (
    typeof resp.jsonrpc === 'string' &&
    resp.jsonrpc === '2.0' &&
    'id' in resp &&
    ('result' in resp || 'error' in resp)
  );
}

