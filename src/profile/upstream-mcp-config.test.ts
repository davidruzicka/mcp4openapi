/**
 * Unit tests for upstream MCP config resolver.
 * Tests validator branches that are unreachable via the profile loader
 * (which applies Zod validation before calling resolveUpstreamMcpConfig).
 */

import { describe, it, expect } from 'vitest';
import { ValidationError } from '../core/errors.js';
import { resolveUpstreamMcpConfig, hasUpstreamMcpFlag } from './upstream-mcp-config.js';
import type { Profile } from '../types/profile.js';

/** Minimal valid tool definition to satisfy Profile type. */
const minimalTools: Profile['tools'] = [
  { name: 'tool_a', description: 'Tool A', operations: { list: 'listItems' }, parameters: {} },
];

function makeProfile(upstream_mcp: unknown): Profile {
  return { profile_name: 'test', tools: minimalTools, upstream_mcp: upstream_mcp as Profile['upstream_mcp'] };
}

describe('resolveUpstreamMcpConfig – validator error branches', () => {
  it('rejects invalid auth type', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'api-key', value_from_env: 'TOKEN' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects missing transport object', () => {
    const profile = makeProfile({ name: 'p1', transport: null });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects unsupported transport type', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'stdio', command: 'npx' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects empty provider name', () => {
    const profile = makeProfile({
      name: '  ',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/name must not be empty/);
  });

  it('rejects empty transport URL', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: '' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects non-absolute transport URL', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'not-a-url' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects non-http/https transport URL', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'ftp://example.com/mcp' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/http or https/);
  });

  it('rejects transport URL with inline credentials', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://user:pass@example.com/mcp' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/inline credentials/);
  });

  it('rejects transport URL with fragment', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp#section' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/fragment/);
  });

  it('rejects empty auth value_from_env', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'bearer', value_from_env: '  ' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/value_from_env must not be empty/);
  });

  it('rejects custom-header auth with unsafe header_name', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'custom-header', value_from_env: 'TOKEN', header_name: '__proto__' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/header_name contains invalid/);
  });

  it('rejects custom-header auth with space in header_name', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'custom-header', value_from_env: 'TOKEN', header_name: 'X My Header' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/RFC7230 token/);
  });

  it('rejects custom-header auth with colon in header_name', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'custom-header', value_from_env: 'TOKEN', header_name: 'X-Header:Colon' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/RFC7230 token/);
  });

  it('rejects custom-header auth with CRLF in header_name (header injection)', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'custom-header', value_from_env: 'TOKEN', header_name: "X-Header\r\nX-Inject: evil" },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/RFC7230 token/);
  });

  it('rejects query auth without query_param', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'query', value_from_env: 'TOKEN' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/query_param is required/);
  });

  it('rejects empty tool policy allow list', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      tools: { allow: [] },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/must contain at least one tool pattern/);
  });

  it('rejects tool policy allow list with empty pattern', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      tools: { allow: ['valid_tool', ''] },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/must not be empty/);
  });

  it('rejects non-positive timeout_ms', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      timeout_ms: 0,
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/timeout_ms must be a positive integer/);
  });

  it('rejects relative validation_endpoint', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_endpoint: '/validate',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(ValidationError);
  });

  it('rejects non-http validation_endpoint', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_endpoint: 'ftp://example.com/validate',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/http or https/);
  });

  it('rejects validation_endpoint with inline credentials', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_endpoint: 'https://user:pass@example.com/validate',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/inline credentials/);
  });

  it('accepts valid absolute validation_endpoint', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_endpoint: 'https://example.com/validate',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).not.toThrow();
  });

  it('rejects non-positive validation_timeout_ms', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_timeout_ms: 0,
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/validation_timeout_ms must be a positive integer/);
  });

  it('rejects negative validation_timeout_ms', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_timeout_ms: -100,
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/validation_timeout_ms must be a positive integer/);
  });

  it('rejects empty tool_prefix', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      tool_prefix: '  ',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/tool_prefix must not be empty/);
  });

  it('rejects tool_prefix with invalid characters', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      tool_prefix: 'bad prefix!',
    });
    expect(() => resolveUpstreamMcpConfig(profile)).toThrow(/tool_prefix may only contain/);
  });

  it('resolves env var fallback to static upstream_mcp when env var value is empty', () => {
    const profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UNSET_VAR_THAT_DOES_NOT_EXIST',
      upstream_mcp: {
        name: 'static',
        transport: { type: 'http-streamable' as const, url: 'https://example.com/mcp' },
      },
    };
    const result = resolveUpstreamMcpConfig(profile, {});
    expect(result?.name).toBe('static');
  });
});

describe('hasUpstreamMcpFlag', () => {
  it('returns true for non-empty array (legacy shape)', () => {
    expect(hasUpstreamMcpFlag([{ name: 'p1' }])).toBe(true);
  });

  it('returns false for empty array', () => {
    expect(hasUpstreamMcpFlag([])).toBe(false);
  });

  it('returns true for singular object (current shape)', () => {
    expect(hasUpstreamMcpFlag({ name: 'p1' })).toBe(true);
  });

  it('returns false for null', () => {
    expect(hasUpstreamMcpFlag(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(hasUpstreamMcpFlag(undefined)).toBe(false);
  });

  it('returns true for empty object (not a valid config but passes the presence check)', () => {
    expect(hasUpstreamMcpFlag({})).toBe(true);
  });
});

describe('parseUpstreamMcpJson – via upstream_mcp_from_env', () => {
  it('rejects invalid JSON', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
    };
    const env = { MCP4_UPSTREAM_MCP_JSON: 'not-valid-json' } as NodeJS.ProcessEnv;
    expect(() => resolveUpstreamMcpConfig(profile, env)).toThrowError(ValidationError);
    expect(() => resolveUpstreamMcpConfig(profile, env)).toThrowError(/must contain valid JSON/);
  });

  it('rejects null JSON value', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
    };
    const env = { MCP4_UPSTREAM_MCP_JSON: 'null' } as NodeJS.ProcessEnv;
    expect(() => resolveUpstreamMcpConfig(profile, env)).toThrowError(/must contain a JSON object/);
  });

  it('rejects string JSON value', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
    };
    const env = { MCP4_UPSTREAM_MCP_JSON: '"just-a-string"' } as NodeJS.ProcessEnv;
    expect(() => resolveUpstreamMcpConfig(profile, env)).toThrowError(/must contain a JSON object/);
  });

  it('error message does not leak env var name', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'SECRET_INTERNAL_VAR_NAME',
    };
    const env = {
      SECRET_INTERNAL_VAR_NAME: JSON.stringify([{ name: 'p1', transport: { type: 'http-streamable', url: 'https://example.com/mcp' } }]),
    } as NodeJS.ProcessEnv;
    let err: Error | undefined;
    try {
      resolveUpstreamMcpConfig(profile, env);
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err?.message).not.toContain('SECRET_INTERNAL_VAR_NAME');
    expect(err?.message).toMatch(/must contain a single JSON object/);
  });
});

describe('upstream_mcp_from_env D-01 migration', () => {
  it('rejects array-typed upstream_mcp_from_env JSON with migration message', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
    };
    const env = {
      MCP4_UPSTREAM_MCP_JSON: JSON.stringify([{
        name: 'p1',
        transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      }]),
    } as NodeJS.ProcessEnv;
    expect(() => resolveUpstreamMcpConfig(profile, env)).toThrowError(
      /must contain a single JSON object, not an array/,
    );
  });

  it('accepts single-object upstream_mcp_from_env JSON', () => {
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'MCP4_UPSTREAM_MCP_JSON',
    };
    const env = {
      MCP4_UPSTREAM_MCP_JSON: JSON.stringify({
        name: 'p1',
        transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      }),
    } as NodeJS.ProcessEnv;
    const resolved = resolveUpstreamMcpConfig(profile, env);
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('p1');
  });
});
