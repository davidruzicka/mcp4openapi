import { describe, it, expect, vi } from 'vitest';
import { ToolFilterService } from './tool-filter-service.js';
import type { ToolDefinition } from '../../types/profile.js';
import { RegexCompiler } from '../regex/regex-compiler.js';
import { RegexValidator } from '../regex/regex-validator.js';
import { EnvConfigParser } from '../config/env-config-parser.js';
import { HeaderConfigParser } from '../config/header-config-parser.js';

describe('ToolFilterService', () => {
  const validator = new RegexValidator();
  const compiler = new RegexCompiler(validator);
  const envParser = new EnvConfigParser(compiler);
  const headerParser = new HeaderConfigParser(compiler);

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  };

  describe('global filtering', () => {
    it('returns tools unchanged when no env config', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'list_users', description: 'List', parameters: {} }
      ];

      const result = service.applyGlobalFilter(tools, {});
      
      expect(result).toHaveLength(2);
      expect(result).toBe(tools);
    });

    it('applies global filtering when env config present', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const env = {
        MCP4_TOOL_FILTER_ALLOW_NAMES: 'get_user'
      };

      const result = service.applyGlobalFilter(tools, env);
      
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('get_user');
    });

    it('logs filtering summary', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      mockLogger.info.mockClear();
      service.applyGlobalFilter(tools, { MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user' });
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Tool filtered',
        expect.objectContaining({
          tool: 'delete_user',
          filter_source: 'env'
        })
      );
    });
  });

  describe('session filtering', () => {
    it('creates session filter from header', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const result = service.applySessionFilter(tools, 'get_user');
      
      expect(result.allowedToolNames.size).toBe(1);
      expect(result.allowedToolNames.has('get_user')).toBe(true);
    });

    it('allows all tools when header empty', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const result = service.applySessionFilter(tools, '');
      
      expect(result.allowedToolNames.size).toBe(2);
    });

    it('supports regex patterns', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'get_project', description: 'Get project', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      const result = service.applySessionFilter(tools, 'regex:get_.*');
      
      expect(result.allowedToolNames.size).toBe(2);
      expect(result.allowedToolNames.has('get_user')).toBe(true);
      expect(result.allowedToolNames.has('get_project')).toBe(true);
    });
  });

  describe('combined filtering', () => {
    it('applies global then session filtering', () => {
      const service = new ToolFilterService(envParser, headerParser, mockLogger as any);
      
      const tools: ToolDefinition[] = [
        { name: 'get_user', description: 'Get', parameters: {} },
        { name: 'list_users', description: 'List', parameters: {} },
        { name: 'delete_user', description: 'Delete', parameters: {} }
      ];

      // Global: only allow get_user and list_users
      const env = { MCP4_TOOL_FILTER_DENY_NAMES: 'delete_user' };
      const filtered = service.applyGlobalFilter(tools, env);
      
      expect(filtered).toHaveLength(2);

      // Session: only allow get_user from remaining tools
      const result = service.applySessionFilter(filtered, 'get_user');
      
      expect(result.allowedToolNames.size).toBe(1);
      expect(result.allowedToolNames.has('get_user')).toBe(true);
    });
  });
});
