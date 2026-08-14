/**
 * Unit tests for upstream MCP config resolver.
 * Tests validator branches that are unreachable via the profile loader
 * (which applies Zod validation before calling resolveUpstreamMcpConfig).
 */

import { describe, it, expect, vi } from 'vitest';
import { ValidationError } from '../core/errors.js';
import { resolveUpstreamMcpConfig, hasUpstreamMcpFlag, looksLikeUpstreamMcpProxy, describeEffectiveUpstreamOrigin } from './upstream-mcp-config.js';
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

  it('accepts bearer auth without value_from_env (HTTP session-passthrough)', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      auth: { type: 'bearer' },
    });
    expect(() => resolveUpstreamMcpConfig(profile)).not.toThrow();
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

  it('rejects non-integer validation_timeout_ms', () => {
    const profile = makeProfile({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
      validation_timeout_ms: 1.5,
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
    expect(err?.message).toMatch(/must be a JSON object/);
  });
});

describe('upstream_mcp_from_env D-01 array rejection', () => {
  it('rejects array-typed upstream_mcp_from_env JSON', () => {
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
      /must be a JSON object, not an array/,
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

describe('validateEnvironmentOverride - env override may only harden the static config', () => {
  const ENV_VAR = 'MCP4_UPSTREAM_MCP_JSON';

  function makeEnvProfile(staticUpstream: unknown): Profile {
    return {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: ENV_VAR,
      upstream_mcp: staticUpstream as Profile['upstream_mcp'],
    };
  }

  function envWith(override: Record<string, unknown>): NodeJS.ProcessEnv {
    return {
      [ENV_VAR]: JSON.stringify({
        name: 'env',
        transport: { type: 'http-streamable', url: 'https://env.example.com/mcp' },
        ...override,
      }),
    } as NodeJS.ProcessEnv;
  }

  const staticWithoutToolPolicy = {
    name: 'static',
    transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
    html_description_policy: 'drop',
    tool_description_length_policy: 'drop',
  };

  const staticWithToolPolicy = {
    ...staticWithoutToolPolicy,
    tools: { allow: ['read_tool'], deny: ['write_tool'] },
  };

  it('rejects an env override that downgrades html_description_policy to allow', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithoutToolPolicy),
      envWith({ html_description_policy: 'allow' }),
    )).toThrow(/cannot weaken the static upstream_mcp\.html_description_policy/);
  });

  it('rejects an env override that downgrades tool_description_length_policy to allow', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithoutToolPolicy),
      envWith({ tool_description_length_policy: 'allow' }),
    )).toThrow(/cannot weaken the static upstream_mcp\.tool_description_length_policy/);
  });

  it('accepts an env override that omits both description policies', () => {
    const resolved = resolveUpstreamMcpConfig(makeEnvProfile(staticWithoutToolPolicy), envWith({}));
    expect(resolved?.name).toBe('env');
    expect(resolved?.html_description_policy).toBeUndefined();
    expect(resolved?.tool_description_length_policy).toBeUndefined();
  });

  it('rejects an env override that broadens the static tools policy', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithToolPolicy),
      envWith({ tools: { allow: ['read_tool', 'write_tool'], deny: ['write_tool'] } }),
    )).toThrow('upstream_mcp_from_env cannot broaden the static upstream_mcp.tools policy');
  });

  it('validates the env override even when the static profile declares no tools policy', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithoutToolPolicy),
      envWith({ html_description_policy: 'allow', tools: { allow: ['anything'] } }),
    )).toThrow(ValidationError);
  });

  it('accepts an env override that sets allow when the static policy is already allow', () => {
    const resolved = resolveUpstreamMcpConfig(
      makeEnvProfile({ ...staticWithoutToolPolicy, html_description_policy: 'allow' }),
      envWith({ html_description_policy: 'allow' }),
    );
    expect(resolved?.html_description_policy).toBe('allow');
  });

  it('rejects an env override that downgrades html_description_policy from drop to strip', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithoutToolPolicy),
      envWith({ html_description_policy: 'strip' }),
    )).toThrow(/cannot weaken the static upstream_mcp\.html_description_policy: strip is less strict than drop/);
  });

  it('rejects an env override that downgrades tool_description_length_policy from drop to truncate', () => {
    expect(() => resolveUpstreamMcpConfig(
      makeEnvProfile(staticWithoutToolPolicy),
      envWith({ tool_description_length_policy: 'truncate' }),
    )).toThrow(/cannot weaken the static upstream_mcp\.tool_description_length_policy: truncate is less strict than drop/);
  });

  it('accepts an env override that hardens strip to drop', () => {
    const resolved = resolveUpstreamMcpConfig(
      makeEnvProfile({ ...staticWithoutToolPolicy, html_description_policy: 'strip' }),
      envWith({ html_description_policy: 'drop' }),
    );
    expect(resolved?.html_description_policy).toBe('drop');
  });

  it('accepts an env override with an equal intermediate policy value', () => {
    const resolved = resolveUpstreamMcpConfig(
      makeEnvProfile({
        ...staticWithoutToolPolicy,
        html_description_policy: 'strip',
        tool_description_length_policy: 'truncate',
      }),
      envWith({ html_description_policy: 'strip', tool_description_length_policy: 'truncate' }),
    );
    expect(resolved?.html_description_policy).toBe('strip');
    expect(resolved?.tool_description_length_policy).toBe('truncate');
  });
});

describe('resolveUpstreamMcpConfig off-origin override warning', () => {
  const ENV_VAR = 'MCP4_UPSTREAM_MCP_JSON';

  const profileWithStatic = (): Profile => ({
    profile_name: 'test',
    tools: minimalTools,
    upstream_mcp_from_env: ENV_VAR,
    upstream_mcp: {
      name: 'static',
      transport: { type: 'http-streamable', url: 'https://static.example.com/mcp' },
    },
  });

  const envWithUrl = (url: string): NodeJS.ProcessEnv =>
    ({
      [ENV_VAR]: JSON.stringify({
        name: 'env',
        transport: { type: 'http-streamable', url },
      }),
    }) as NodeJS.ProcessEnv;

  it('warns when the env override points at a different origin', () => {
    const warn = vi.fn();
    resolveUpstreamMcpConfig(profileWithStatic(), envWithUrl('https://proxy.example.net/mcp'), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Upstream MCP endpoint overridden to a different origin by the environment',
      {
        profile: 'test',
        staticOrigin: 'https://static.example.com',
        overrideOrigin: 'https://proxy.example.net',
        envVarName: ENV_VAR,
      },
    );
  });

  it('does not warn when the override keeps the static origin', () => {
    const warn = vi.fn();
    resolveUpstreamMcpConfig(profileWithStatic(), envWithUrl('https://static.example.com/mcp/v2'), { warn });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for an env-only upstream without a static endpoint', () => {
    const warn = vi.fn();
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: ENV_VAR,
    };
    resolveUpstreamMcpConfig(profile, envWithUrl('https://env-only.example.com/mcp'), { warn });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('looksLikeUpstreamMcpProxy', () => {
  it('returns true for valid http-streamable object', () => {
    expect(looksLikeUpstreamMcpProxy({
      name: 'p1',
      transport: { type: 'http-streamable', url: 'https://example.com/mcp' },
    })).toBe(true);
  });

  it('returns false for null', () => {
    expect(looksLikeUpstreamMcpProxy(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(looksLikeUpstreamMcpProxy(undefined)).toBe(false);
  });

  it('returns false for array (legacy shape)', () => {
    expect(looksLikeUpstreamMcpProxy([{ transport: { type: 'http-streamable', url: 'https://example.com/mcp' } }])).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(looksLikeUpstreamMcpProxy({})).toBe(false);
  });

  it('returns false when transport is missing', () => {
    expect(looksLikeUpstreamMcpProxy({ name: 'p1' })).toBe(false);
  });

  it('returns false for stdio transport', () => {
    expect(looksLikeUpstreamMcpProxy({
      name: 'p1',
      transport: { type: 'stdio', command: 'npx' },
    })).toBe(false);
  });

  it('returns false when url is empty string', () => {
    expect(looksLikeUpstreamMcpProxy({
      name: 'p1',
      transport: { type: 'http-streamable', url: '   ' },
    })).toBe(false);
  });

  it('returns false when url is missing', () => {
    expect(looksLikeUpstreamMcpProxy({
      name: 'p1',
      transport: { type: 'http-streamable' },
    })).toBe(false);
  });

  it('returns false when transport is an array', () => {
    expect(looksLikeUpstreamMcpProxy({ transport: [{ type: 'http-streamable', url: 'https://example.com' }] })).toBe(false);
  });
});

describe('describeEffectiveUpstreamOrigin', () => {
  const staticUpstream = {
    name: 'softeria',
    transport: { type: 'http-streamable', url: 'https://softeria.internal.example/mcp' },
  };

  const profileWithEnvRef = (): Profile => ({
    ...makeProfile(staticUpstream),
    upstream_mcp_from_env: 'SOFTERIA_UPSTREAM_MCP',
  });

  it('returns undefined when no upstream is configured', () => {
    expect(describeEffectiveUpstreamOrigin(makeProfile(undefined), {})).toBeUndefined();
  });

  it('reports the static profile origin when no override is set', () => {
    expect(describeEffectiveUpstreamOrigin(profileWithEnvRef(), {})).toEqual({
      origin: 'https://softeria.internal.example',
      fromEnvOverride: false,
      envVarName: 'SOFTERIA_UPSTREAM_MCP',
    });
  });

  it('reports the override origin as env-sourced when an override is set', () => {
    const env = {
      SOFTERIA_UPSTREAM_MCP: JSON.stringify({
        name: 'softeria',
        transport: { type: 'http-streamable', url: 'https://staging-proxy.example/mcp' },
      }),
    };

    expect(describeEffectiveUpstreamOrigin(profileWithEnvRef(), env)).toEqual({
      origin: 'https://staging-proxy.example',
      fromEnvOverride: true,
      envVarName: 'SOFTERIA_UPSTREAM_MCP',
    });
  });

  it('reports the shared origin when the override only changes the path', () => {
    const env = {
      SOFTERIA_UPSTREAM_MCP: JSON.stringify({
        name: 'softeria',
        transport: { type: 'http-streamable', url: 'https://softeria.internal.example/mcp/v2' },
      }),
    };

    const described = describeEffectiveUpstreamOrigin(profileWithEnvRef(), env);
    expect(described?.fromEnvOverride).toBe(true);
    expect(described?.origin).toBe('https://softeria.internal.example');
  });

  it('returns undefined for an unparseable effective URL instead of throwing', () => {
    const profile = makeProfile({ name: 'p', transport: { type: 'http-streamable', url: 'not-a-url' } });
    expect(describeEffectiveUpstreamOrigin(profile, {})).toBeUndefined();
  });
});

describe('describeEffectiveUpstreamOrigin - absent URL handling', () => {
  it('reports an env-only upstream as env-sourced', () => {
    // No static upstream_mcp at all: the override is the only endpoint.
    const profile: Profile = {
      profile_name: 'test',
      tools: minimalTools,
      upstream_mcp_from_env: 'UPSTREAM_JSON',
    };
    const env = {
      UPSTREAM_JSON: JSON.stringify({
        name: 'p',
        transport: { type: 'http-streamable', url: 'https://env-only.example/mcp' },
      }),
    };

    expect(describeEffectiveUpstreamOrigin(profile, env)).toEqual({
      origin: 'https://env-only.example',
      fromEnvOverride: true,
      envVarName: 'UPSTREAM_JSON',
    });
  });

  it('returns undefined when the effective transport URL is blank', () => {
    const profile = makeProfile({ name: 'p', transport: { type: 'http-streamable', url: '   ' } });
    expect(describeEffectiveUpstreamOrigin(profile, {})).toBeUndefined();
  });
});
