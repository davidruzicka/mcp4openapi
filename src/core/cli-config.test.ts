import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyCliEnvOverrides, flagToEnvVar, parseCliArgs } from './cli-config.js';
import { UnknownCliFlagError } from './errors.js';

describe('cli-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('converts flags to MCP4 env vars', () => {
    expect(flagToEnvVar('profile-path')).toBe('MCP4_PROFILE_PATH');
    expect(flagToEnvVar('openapi-spec-path')).toBe('MCP4_OPENAPI_SPEC_PATH');
  });

  it('parses --key=value and --key value forms', () => {
    const parsed = parseCliArgs(['--profile=gitlab', '--openapi-spec-path', 'spec.yaml']);
    expect(parsed.profile).toBe('gitlab');
    expect(parsed['openapi-spec-path']).toBe('spec.yaml');
  });

  it('treats flags without value as true', () => {
    const parsed = parseCliArgs(['--dry-run']);
    expect(parsed['dry-run']).toBe('true');
  });

  it('keeps previous flag true when next token is another flag', () => {
    const parsed = parseCliArgs(['--first', '--second', 'value']);
    expect(parsed.first).toBe('true');
    expect(parsed.second).toBe('value');
  });

  it('handles empty flag names and empty values', () => {
    const parsed = parseCliArgs(['--', '--empty=']);
    expect(parsed['empty']).toBe('');
    expect(parsed['']).toBeUndefined();
  });

  it('ignores non-flag arguments', () => {
    const parsed = parseCliArgs(['value', 'another']);
    expect(Object.keys(parsed)).toHaveLength(0);
  });

  it('parses -l as list-profiles', () => {
    const parsed = parseCliArgs(['-l']);
    expect(parsed['list-profiles']).toBe('true');
  });

  it('parses -h and -v aliases', () => {
    const parsed = parseCliArgs(['-h', '-v']);
    expect(parsed.help).toBe('true');
    expect(parsed.version).toBe('true');
  });

  it('applies CLI args to env using MCP4 mapping', () => {
    const parsed = parseCliArgs(['--profile', 'gitlab', '--profiles-dir', 'profiles']);
    applyCliEnvOverrides(parsed);
    expect(process.env.MCP4_PROFILE).toBe('gitlab');
    expect(process.env.MCP4_PROFILES_DIR).toBe('profiles');
  });

  it('ignores list-profiles in env overrides', () => {
    const parsed = parseCliArgs(['-l']);
    expect(() => applyCliEnvOverrides(parsed)).not.toThrow();
    expect(process.env.MCP4_LIST_PROFILES).toBeUndefined();
  });

  it('ignores help and version in env overrides', () => {
    const parsed = parseCliArgs(['--help', '--version']);
    expect(() => applyCliEnvOverrides(parsed)).not.toThrow();
    expect(process.env.MCP4_HELP).toBeUndefined();
    expect(process.env.MCP4_VERSION).toBeUndefined();
  });

  it('throws for CLI args without known MCP4 env vars', () => {
    const parsed = parseCliArgs(['--unknown-flag', 'value']);
    expect(() => applyCliEnvOverrides(parsed)).toThrow(UnknownCliFlagError);
    expect(() => applyCliEnvOverrides(parsed)).toThrow('Unknown CLI flags: unknown-flag');
  });

  it('allows known OAuth env vars', () => {
    const parsed = parseCliArgs(['--oauth-client-id', 'client', '--oauth-token-url', 'https://auth/token']);
    applyCliEnvOverrides(parsed);
    expect(process.env.MCP4_OAUTH_CLIENT_ID).toBe('client');
    expect(process.env.MCP4_OAUTH_TOKEN_URL).toBe('https://auth/token');
  });

  it('allows bootstrap SSRF control env vars', () => {
    const parsed = parseCliArgs([
      '--ssrf-allow-private-network', 'true',
      '--trust-bootstrap-urls', 'true',
    ]);
    applyCliEnvOverrides(parsed);
    expect(process.env.MCP4_SSRF_ALLOW_PRIVATE_NETWORK).toBe('true');
    expect(process.env.MCP4_TRUST_BOOTSTRAP_URLS).toBe('true');
  });

  it('allows param-filter CLI mapping', () => {
    const parsed = parseCliArgs(['--param-filter', 'project_id=123,_allow_read']);
    applyCliEnvOverrides(parsed);
    expect(process.env.MCP4_PARAM_FILTER).toBe('project_id=123,_allow_read');
  });

  it('throws for mixed known and unknown flags', () => {
    const parsed = parseCliArgs(['--profile', 'gitlab', '--unknown', 'value']);
    expect(() => applyCliEnvOverrides(parsed)).toThrow(UnknownCliFlagError);
    expect(() => applyCliEnvOverrides(parsed)).toThrow('Unknown CLI flags: unknown');
    expect(process.env.MCP4_PROFILE).toBeUndefined();
  });
});
