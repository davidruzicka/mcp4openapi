import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMCPServerManagerConfigFromEnv } from './mcp-server-manager.js';

const ENV_KEYS = [
  'MCP4_PROFILE_SERVER_CACHE_MAX',
  'MCP4_PROFILE_SERVER_CACHE_TTL_MS',
] as const;

describe('buildMCPServerManagerConfigFromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('uses safe defaults when env vars are not set', () => {
    expect(buildMCPServerManagerConfigFromEnv()).toEqual({
      cacheMaxEntries: 32,
      cacheTtlMs: 900000,
    });
  });

  it('reads env overrides when provided', () => {
    process.env.MCP4_PROFILE_SERVER_CACHE_MAX = '12';
    process.env.MCP4_PROFILE_SERVER_CACHE_TTL_MS = '45000';

    expect(buildMCPServerManagerConfigFromEnv()).toEqual({
      cacheMaxEntries: 12,
      cacheTtlMs: 45000,
    });
  });

  it('rejects invalid cache max values', () => {
    process.env.MCP4_PROFILE_SERVER_CACHE_MAX = '0';

    expect(() => buildMCPServerManagerConfigFromEnv()).toThrow(
      /Invalid MCP4_PROFILE_SERVER_CACHE_MAX/
    );
  });

  it('rejects invalid cache ttl values', () => {
    process.env.MCP4_PROFILE_SERVER_CACHE_TTL_MS = '-1';

    expect(() => buildMCPServerManagerConfigFromEnv()).toThrow(
      /Invalid MCP4_PROFILE_SERVER_CACHE_TTL_MS/
    );
  });
});
