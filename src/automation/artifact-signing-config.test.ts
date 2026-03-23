import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../core/errors.js';
import { readArtifactTrustConfig } from './artifact-signing-config.js';

describe('artifact-signing-config', () => {
  it('returns compatibility defaults when the environment is empty', () => {
    expect(readArtifactTrustConfig({})).toEqual({
      allowUnsigned: true,
    });
  });

  it('keeps unsigned planner artifacts enabled by default until signing is configured', () => {
    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_KEY_ID: 'primary',
    })).toEqual({
      allowUnsigned: true,
    });
  });

  it('parses a signing key from the environment and switches to strict trust by default', () => {
    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_SIGNING_KEY: 'planner-secret',
    })).toEqual({
      allowUnsigned: false,
      signing: {
        key: 'planner-secret',
        keyId: 'default',
      },
    });
  });

  it('defaults blank key IDs to default and ignores blank signing keys', () => {
    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_SIGNING_KEY: '   ',
      MCP4_AGENT_ARTIFACT_KEY_ID: '   ',
    })).toEqual({
      allowUnsigned: true,
    });

    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_SIGNING_KEY: 'planner-secret',
      MCP4_AGENT_ARTIFACT_KEY_ID: '   ',
    })).toEqual({
      allowUnsigned: false,
      signing: {
        key: 'planner-secret',
        keyId: 'default',
      },
    });
  });

  it('parses allowUnsigned as an explicit boolean', () => {
    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED: 'true',
    })).toEqual({
      allowUnsigned: true,
    });

    expect(readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED: 'false',
    })).toEqual({
      allowUnsigned: false,
    });
  });

  it('rejects invalid allowUnsigned values', () => {
    expect(() => readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED: 'sometimes',
    })).toThrow(ConfigurationError);
    expect(() => readArtifactTrustConfig({
      MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED: 'sometimes',
    })).toThrow('MCP4_AGENT_ARTIFACT_ALLOW_UNSIGNED must be either');
  });
});
