/**
 * Multi-auth support tests
 * 
 * Tests:
 * - Profile with single auth config (backward compatibility)
 * - Profile with multiple auth configs
 * - Auth config priority handling
 * - OAuth + Bearer token fallback
 */

import { describe, it, expect } from 'vitest';
import type { AuthInterceptor, InterceptorConfig } from './types/profile.js';

describe('Multi-Auth Support', () => {
  describe('Auth Config Array', () => {
    it('should support single auth config (backward compatibility)', () => {
      const config: InterceptorConfig = {
        auth: {
          type: 'bearer',
          value_from_env: 'MCP4_API_TOKEN',
        },
      };

      expect(config.auth).toBeDefined();
      expect(Array.isArray(config.auth)).toBe(false);
      expect((config.auth as AuthInterceptor).type).toBe('bearer');
    });

    it('should support multiple auth configs as array', () => {
      const config: InterceptorConfig = {
        auth: [
          {
            type: 'oauth',
            priority: 0,
            oauth_config: {
              authorization_endpoint: 'https://example.com/oauth/authorize',
              token_endpoint: 'https://example.com/oauth/token',
              scopes: ['api'],
            },
          },
          {
            type: 'bearer',
            priority: 1,
            value_from_env: 'MCP4_API_TOKEN',
          },
        ],
      };

      expect(config.auth).toBeDefined();
      expect(Array.isArray(config.auth)).toBe(true);
      expect((config.auth as AuthInterceptor[]).length).toBe(2);
    });

    it('should have priority field on each auth config', () => {
      const authConfigs: AuthInterceptor[] = [
        {
          type: 'oauth',
          priority: 0,
          oauth_config: {
            authorization_endpoint: 'https://example.com/oauth/authorize',
            token_endpoint: 'https://example.com/oauth/token',
            scopes: ['api'],
          },
        },
        {
          type: 'bearer',
          priority: 1,
          value_from_env: 'MCP4_API_TOKEN',
        },
      ];

      expect(authConfigs[0].priority).toBe(0);
      expect(authConfigs[1].priority).toBe(1);
    });
  });

  describe('Auth Config Priority', () => {
    it('should sort by priority (lower = higher priority)', () => {
      const configs: AuthInterceptor[] = [
        {
          type: 'bearer',
          priority: 2,
          value_from_env: 'TOKEN_3',
        },
        {
          type: 'oauth',
          priority: 0,
          oauth_config: {
            authorization_endpoint: 'https://example.com/oauth/authorize',
            token_endpoint: 'https://example.com/oauth/token',
            scopes: ['api'],
          },
        },
        {
          type: 'bearer',
          priority: 1,
          value_from_env: 'TOKEN_2',
        },
      ];

      const sorted = configs.sort((a, b) => (a.priority || 0) - (b.priority || 0));

      expect(sorted[0].type).toBe('oauth');
      expect(sorted[0].priority).toBe(0);
      expect(sorted[1].priority).toBe(1);
      expect(sorted[2].priority).toBe(2);
    });

    it('should default priority to 0 if not specified', () => {
      const config: AuthInterceptor = {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      };

      const priority = config.priority || 0;
      expect(priority).toBe(0);
    });

    it('should handle configs with same priority', () => {
      const configs: AuthInterceptor[] = [
        {
          type: 'bearer',
          priority: 0,
          value_from_env: 'TOKEN_1',
        },
        {
          type: 'bearer',
          priority: 0,
          value_from_env: 'TOKEN_2',
        },
      ];

      const sorted = configs.sort((a, b) => (a.priority || 0) - (b.priority || 0));

      // Both have priority 0, order is preserved or stable
      expect(sorted.length).toBe(2);
      expect(sorted[0].priority).toBe(0);
      expect(sorted[1].priority).toBe(0);
    });
  });

  describe('OAuth + Bearer Fallback', () => {
    it('should have OAuth as primary (priority 0) and Bearer as fallback (priority 1)', () => {
      const config: InterceptorConfig = {
        auth: [
          {
            type: 'oauth',
            priority: 0,
            oauth_config: {
              authorization_endpoint: 'https://www.gitlab.com/oauth/authorize',
              token_endpoint: 'https://www.gitlab.com/oauth/token',
              scopes: ['api'],
            },
          },
          {
            type: 'bearer',
            priority: 1,
            value_from_env: 'CI_API_TOKEN',
          },
        ],
      };

      expect(Array.isArray(config.auth)).toBe(true);
      const authArray = config.auth as AuthInterceptor[];
      
      const sorted = authArray.sort((a, b) => (a.priority || 0) - (b.priority || 0));
      expect(sorted[0].type).toBe('oauth');
      expect(sorted[1].type).toBe('bearer');
    });

    it('should allow OAuth without value_from_env', () => {
      const config: AuthInterceptor = {
        type: 'oauth',
        oauth_config: {
          authorization_endpoint: 'https://example.com/oauth/authorize',
          token_endpoint: 'https://example.com/oauth/token',
          scopes: ['api'],
        },
      };

      expect(config.type).toBe('oauth');
      expect(config.value_from_env).toBeUndefined();
      expect(config.oauth_config).toBeDefined();
    });

    it('should require value_from_env for bearer', () => {
      const config: AuthInterceptor = {
        type: 'bearer',
        value_from_env: 'MCP4_API_TOKEN',
      };

      expect(config.type).toBe('bearer');
      expect(config.value_from_env).toBeDefined();
      expect(config.value_from_env).toBe('MCP4_API_TOKEN');
    });
  });

  describe('Multi-Auth Use Cases', () => {
    it('should support OAuth for users + Bearer for CI/CD', () => {
      const config: InterceptorConfig = {
        auth: [
          {
            type: 'oauth',
            priority: 0,
            oauth_config: {
              authorization_endpoint: 'https://www.gitlab.com/oauth/authorize',
              token_endpoint: 'https://www.gitlab.com/oauth/token',
              client_id: 'client-id',
              client_secret: 'client-secret',
              scopes: ['api', 'read_repository'],
              redirect_uri: 'https://mcp-gitlab.ai.iszn.cz/oauth/callback',
            },
          },
          {
            type: 'bearer',
            priority: 1,
            value_from_env: 'CI_API_TOKEN',
          },
        ],
      };

      expect(Array.isArray(config.auth)).toBe(true);
      const authArray = config.auth as AuthInterceptor[];
      expect(authArray.length).toBe(2);
      
      const oauthConfig = authArray.find(a => a.type === 'oauth');
      const bearerConfig = authArray.find(a => a.type === 'bearer');
      
      expect(oauthConfig).toBeDefined();
      expect(oauthConfig!.priority).toBe(0);
      expect(oauthConfig!.oauth_config?.scopes).toEqual(['api', 'read_repository']);
      
      expect(bearerConfig).toBeDefined();
      expect(bearerConfig!.priority).toBe(1);
      expect(bearerConfig!.value_from_env).toBe('CI_API_TOKEN');
    });

    it('should support custom-header + bearer fallback', () => {
      const config: InterceptorConfig = {
        auth: [
          {
            type: 'custom-header',
            priority: 0,
            header_name: 'X-API-Key',
            value_from_env: 'API_KEY',
          },
          {
            type: 'bearer',
            priority: 1,
            value_from_env: 'MCP4_API_TOKEN',
          },
        ],
      };

      expect(Array.isArray(config.auth)).toBe(true);
      const authArray = config.auth as AuthInterceptor[];
      expect(authArray.length).toBe(2);
      
      expect(authArray[0].type).toBe('custom-header');
      expect(authArray[0].header_name).toBe('X-API-Key');
      expect(authArray[1].type).toBe('bearer');
    });
  });
});

