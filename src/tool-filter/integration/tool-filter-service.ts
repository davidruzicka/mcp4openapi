/**
 * Tool Filter Service - orchestrates all filtering components
 */

import type { ToolDefinition } from '../../types/profile.js';
import type { Logger } from '../../logger.js';
import type { EnvConfigParser } from '../config/env-config-parser.js';
import type { HeaderConfigParser } from '../config/header-config-parser.js';
import type { SessionToolFilterResult } from '../filter/session-tool-filter.js';
import { GlobalToolFilter } from '../filter/global-tool-filter.js';
import { SessionToolFilter } from '../filter/session-tool-filter.js';

/**
 * Service that orchestrates tool filtering from environment and headers
 */
export class ToolFilterService {
  constructor(
    private envParser: EnvConfigParser,
    private headerParser: HeaderConfigParser,
    private logger: Logger
  ) {}

  /**
   * Apply global filtering based on environment variables
   * 
   * @param tools - Tools to filter
   * @param env - Environment variables (process.env)
   * @returns Filtered tools (or original if no config)
   */
  applyGlobalFilter(
    tools: ToolDefinition[],
    env: NodeJS.ProcessEnv
  ): ToolDefinition[] {
    const config = this.envParser.parse(env);
    
    if (!config) {
      return tools;
    }

    const filter = new GlobalToolFilter(config, this.logger);
    const result = filter.apply(tools);

    this.logger.info('Global tool filter applied', {
      original: result.summary.originalCount,
      allowed: result.summary.allowedCount,
      removed: result.summary.removedCount
    });

    return result.allowed;
  }

  /**
   * Apply session filtering based on X-Mcp4-Tools header
   * 
   * @param tools - Tools to filter (typically after global filtering)
   * @param headerValue - X-Mcp4-Tools header value
   * @returns Session filter result with allowed tool names
   */
  applySessionFilter(
    tools: ToolDefinition[],
    headerValue: string
  ): SessionToolFilterResult {
    const request = this.headerParser.parse(headerValue);
    const filter = new SessionToolFilter(request);
    const result = filter.apply(tools);

    if (request.hasRules) {
      this.logger.info('Session tool filter applied', {
        header: request.normalizedHeader,
        available: tools.length,
        allowed: result.allowedToolNames.size
      });
    }

    return result;
  }

  /**
   * Check if tool is allowed in session
   * 
   * @param toolName - Tool name to check
   * @param sessionResult - Session filter result
   * @returns true if tool is allowed
   */
  isToolAllowed(toolName: string, sessionResult: SessionToolFilterResult): boolean {
    return sessionResult.allowedToolNames.has(toolName);
  }
}
