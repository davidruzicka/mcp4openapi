/**
 * Shared tool-filter bounds.
 *
 * Regex tool-name matching is intentionally limited to the same maximum entry
 * length accepted by X-Mcp4-Tools. Tool filters operate on MCP tool names, not
 * arbitrary unbounded input strings, so rejecting oversized values provides a
 * deterministic defense-in-depth boundary for residual regex backtracking risk.
 */
export const MAX_TOOL_FILTER_NAME_LENGTH = 255;