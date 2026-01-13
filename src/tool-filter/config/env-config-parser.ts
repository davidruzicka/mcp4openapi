/**
 * Environment variable config parser
 */

import type { ToolFilterConfig, CompiledRegex } from '../types.js';
import type { RegexCompiler } from '../regex/regex-compiler.js';
import { ConfigurationError } from '../errors.js';

/**
 * Parses tool filter configuration from environment variables
 */
export class EnvConfigParser {
  constructor(private compiler: RegexCompiler) {}

  /**
   * Parse config from environment variables
   * @returns Config or undefined if no env vars set
   */
  parse(env: NodeJS.ProcessEnv): ToolFilterConfig | undefined {
    const raw = this.extractRawConfig(env);
    if (!raw) {
      return undefined;
    }

    return this.buildConfig(raw);
  }

  /**
   * Extract raw config from env vars
   */
  private extractRawConfig(env: NodeJS.ProcessEnv): RawConfig | undefined {
    const allowList = this.parseCsvList(env.MCP4_TOOL_FILTER_ALLOW_NAMES);
    const allowRegex = this.parseCsvList(env.MCP4_TOOL_FILTER_ALLOW_NAME_REGEX);
    const denyList = this.parseCsvList(env.MCP4_TOOL_FILTER_DENY_NAMES);
    const denyRegex = this.parseCsvList(env.MCP4_TOOL_FILTER_DENY_NAME_REGEX);
    const allowCategories = this.parseCsvList(env.MCP4_TOOL_FILTER_ALLOW_CATEGORIES);

    // Check if any config present
    if (this.isEmpty(allowList, allowRegex, denyList, denyRegex, allowCategories)) {
      return undefined;
    }

    return { allowList, allowRegex, denyList, denyRegex, allowCategories };
  }

  /**
   * Build typed config from raw config
   */
  private buildConfig(raw: RawConfig): ToolFilterConfig {
    const allowList = new Set(raw.allowList.map(name => name.normalize('NFC')));
    const denyList = new Set(raw.denyList.map(name => name.normalize('NFC')));

    const allowRegex: CompiledRegex[] = raw.allowRegex.map(pattern =>
      this.compiler.compile(pattern, 'MCP4_TOOL_FILTER_ALLOW_NAME_REGEX')
    );

    const denyRegex: CompiledRegex[] = raw.denyRegex.map(pattern =>
      this.compiler.compile(pattern, 'MCP4_TOOL_FILTER_DENY_NAME_REGEX')
    );

    const allowCategories = this.parseCategories(raw.allowCategories);

    const hasAllowRules =
      raw.allowList.length > 0 ||
      raw.allowRegex.length > 0 ||
      allowCategories.size > 0;

    return {
      allowList,
      denyList,
      allowRegex,
      denyRegex,
      allowCategories,
      hasAllowRules,
      sources: {
        allowList: raw.allowList,
        allowRegex: raw.allowRegex,
        denyList: raw.denyList,
        denyRegex: raw.denyRegex,
        allowCategories: raw.allowCategories
      }
    };
  }

  /**
   * Parse categories from string array
   */
  private parseCategories(entries: string[]): Set<'list' | 'read'> {
    const categories = new Set<'list' | 'read'>();

    for (const entry of entries) {
      if (!entry) {
        continue;
      }

      const normalized = entry.trim().toLowerCase();
      if (normalized === 'list' || normalized === 'read') {
        categories.add(normalized);
        continue;
      }

      throw new ConfigurationError(
        `MCP4_TOOL_FILTER_ALLOW_CATEGORIES supports only 'list' and 'read', got '${entry}'`
      );
    }

    return categories;
  }

  /**
   * Parse CSV list from env var value
   */
  private parseCsvList(value?: string): string[] {
    if (!value) {
      return [];
    }

    return value
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
  }

  /**
   * Check if all arrays are empty
   */
  private isEmpty(...arrays: string[][]): boolean {
    return arrays.every(arr => arr.length === 0);
  }
}

/**
 * Raw config extracted from env vars
 */
interface RawConfig {
  allowList: string[];
  allowRegex: string[];
  denyList: string[];
  denyRegex: string[];
  allowCategories: string[];
}
