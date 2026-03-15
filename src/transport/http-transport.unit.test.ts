/**
 * Unit tests for HttpTransport that do not require a listening socket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';
import { ipv4ToInt, ipv6Mask, ipv6ToBigInt } from '../security/host-pattern-matcher.js';
import { parseSessionToolFilterHeader } from '../tool-filter/index.js';
import type { SessionToolFilter } from '../types/http-transport.js';
import { ConfigurationError, ValidationError } from '../core/errors.js';

describe('HttpTransport unit', () => {
  let transport: HttpTransport;
  const logger = new ConsoleLogger();

  const createProfileState = (target: any, profileId: string = 'default') => {
    const state = {
      profileId,
      context: { profileId },
      oauthProvider: null,
      oauthTokensByAccessToken: new Map(),
      sessions: new Map(),
    };
    target.profileStates.set(profileId, state);
    return state;
  };

  const withGet = (req: any) => {
    if (typeof req.get === 'function') {
      return req;
    }
    const headers = req.headers ?? {};
    return {
      ...req,
      headers,
      get(name: string) {
        const key = name.toLowerCase();
        return headers[key] ?? headers[name];
      },
    };
  };

  beforeEach(async () => {
    const config = {
      host: '127.0.0.1',
      port: 0,
      sessionTimeoutMs: 1800000,
      heartbeatEnabled: false,
      heartbeatIntervalMs: 30000,
      metricsEnabled: false,
      metricsPath: '/metrics',
    };

    transport = new HttpTransport(config, logger);
  });

  afterEach(async () => {
    await transport.stop();
  });

  describe('filtering header helpers', () => {
    it('detects unknown message types', () => {
      const messageType = (transport as any).getMessageType(123);
      expect(messageType).toBe('unknown');
    });

    it('detects response-only messages', () => {
      const messageType = (transport as any).getMessageType({ result: { ok: true } });
      expect(messageType).toBe('response-only');
    });

    it('handles filtering header arrays', () => {
      const getFilteringHeaderValue = (transport as any).getFilteringHeaderValue.bind(transport);
      expect(getFilteringHeaderValue({ headers: { 'x-mcp4-params': [] } })).toBeUndefined();
      expect(() =>
        getFilteringHeaderValue({ headers: { 'x-mcp4-params': ['a=b', 'c=d'] } })
      ).toThrow();
    });

    it('returns first filtering header value when single entry is provided', () => {
      const getFilteringHeaderValue = (transport as any).getFilteringHeaderValue.bind(transport);
      expect(getFilteringHeaderValue({ headers: { 'x-mcp4-params': ['project_id=1'] } })).toBe(
        'project_id=1'
      );
      expect(
        getFilteringHeaderValue({ headers: { 'x-mcp4-params': ['project_id=1,group_id=2'] } })
      ).toBe('project_id=1,group_id=2');
    });

    it('exposes session filtering values', () => {
      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { project_id: ['1'] },
        'project_id=1'
      );

      expect(transport.getSessionFiltering('default', sessionId)).toEqual({ project_id: ['1'] });
      expect(transport.getSessionFilteringHeader('default', sessionId)).toBe('project_id=1');
    });

    it('applies global filtering to sessions without a session header filter', async () => {
      const scopedTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          globalFiltering: { project_id: ['1'], _allow_read: [] },
        },
        logger
      );

      try {
        const sessionId = (scopedTransport as any).createSession(createProfileState(scopedTransport as any));
        expect(scopedTransport.getSessionFiltering('default', sessionId)).toEqual({
          project_id: ['1'],
          _allow_read: [],
        });
        expect(scopedTransport.getSessionFilteringHeader('default', sessionId)).toBeUndefined();
      } finally {
        await scopedTransport.stop();
      }
    });

    it('merges session filtering with global filtering when creating a session', async () => {
      const scopedTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          globalFiltering: { project_id: ['1', '2'], _allow_read: [] },
        },
        logger
      );

      try {
        const sessionId = (scopedTransport as any).createSession(
          createProfileState(scopedTransport as any),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { project_id: ['2'], _allow_read: [] },
          'project_id=2,_allow_read'
        );

        expect(scopedTransport.getSessionFiltering('default', sessionId)).toEqual({
          project_id: ['2'],
          _allow_read: [],
        });
        expect(scopedTransport.getSessionFilteringHeader('default', sessionId)).toBe(
          'project_id=2,_allow_read'
        );
      } finally {
        await scopedTransport.stop();
      }
    });

    it('rejects conflicting session filtering against global filtering', async () => {
      const scopedTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          globalFiltering: { project_id: ['1'] },
        },
        logger
      );

      try {
        expect(() =>
          (scopedTransport as any).createSession(
            createProfileState(scopedTransport as any),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { project_id: ['2'] },
            'project_id=2'
          )
        ).toThrow(ValidationError);
      } finally {
        await scopedTransport.stop();
      }
    });

    it('handles tenant header arrays and invalid values', () => {
      const getTenantIdHeaderValue = (transport as any).getTenantIdHeaderValue.bind(transport);
      const getTenantBaseUrlHeaderValue = (transport as any).getTenantBaseUrlHeaderValue.bind(transport);

      expect(getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': [] } })).toBeUndefined();
      expect(() => getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': ['a', 'b'] } })).toThrow();
      expect(() => getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': '   ' } })).toThrow();
      expect(getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': ' team-a ' } })).toBe('team-a');
      expect(() => getTenantIdHeaderValue({ headers: { 'x-mcp4-tenant-id': 'team-a,team-b' } })).toThrow();

      expect(getTenantBaseUrlHeaderValue({ headers: { 'x-mcp4-api-base-url': [] } })).toBeUndefined();
      expect(() => getTenantBaseUrlHeaderValue({ headers: { 'x-mcp4-api-base-url': ['a', 'b'] } })).toThrow();
      expect(() => getTenantBaseUrlHeaderValue({ headers: { 'x-mcp4-api-base-url': `https://a.${String.fromCharCode(10)}example.com` } })).toThrow();
    });

    it('handles tool filter header arrays', () => {
      const getToolFilterHeaderValue = (transport as any).getToolFilterHeaderValue.bind(transport);
      expect(getToolFilterHeaderValue({ headers: { 'x-mcp4-tools': [] } })).toBeUndefined();
      expect(() =>
        getToolFilterHeaderValue({ headers: { 'x-mcp4-tools': ['a', 'b'] } })
      ).toThrow();
    });

    it('exposes session tool filter values', () => {
      const toolFilterRequest = parseSessionToolFilterHeader('get_user');
      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolFilterRequest,
        toolFilterRequest.normalizedHeader
      );
      expect(transport.getSessionToolFilterRequest('default', sessionId)).toEqual(toolFilterRequest);
      expect(transport.getSessionToolFilterHeader('default', sessionId)).toBe(toolFilterRequest.normalizedHeader);
    });

    it('parses and stores _allow_list category in session tool filter', () => {
      const toolFilterRequest = parseSessionToolFilterHeader('_allow_list');
      expect(toolFilterRequest.allowCategories.has('list')).toBe(true);
      expect(toolFilterRequest.hasRules).toBe(true);

      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolFilterRequest,
        toolFilterRequest.normalizedHeader
      );
      const stored = transport.getSessionToolFilterRequest('default', sessionId);
      expect(stored?.allowCategories.has('list')).toBe(true);
    });

    it('parses and stores _allow_read category in session tool filter', () => {
      const toolFilterRequest = parseSessionToolFilterHeader('_allow_read');
      expect(toolFilterRequest.allowCategories.has('read')).toBe(true);

      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolFilterRequest,
        toolFilterRequest.normalizedHeader
      );
      const stored = transport.getSessionToolFilterRequest('default', sessionId);
      expect(stored?.allowCategories.has('read')).toBe(true);
    });

    it('parses and stores combined categories with tool names', () => {
      const toolFilterRequest = parseSessionToolFilterHeader('get_user, _allow_list, regex:read_.*');
      expect(toolFilterRequest.exactNames.has('get_user')).toBe(true);
      expect(toolFilterRequest.allowCategories.has('list')).toBe(true);
      expect(toolFilterRequest.regexPatterns.length).toBe(1);

      const sessionId = (transport as any).createSession(
        createProfileState(transport as any),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        toolFilterRequest,
        toolFilterRequest.normalizedHeader
      );
      const stored = transport.getSessionToolFilterRequest('default', sessionId);
      expect(stored?.exactNames.has('get_user')).toBe(true);
      expect(stored?.allowCategories.has('list')).toBe(true);
      expect(stored?.regexPatterns.length).toBe(1);
    });
  });

  describe('tool filter service with OperationDetector', () => {
    it('creates OperationDetector when parser is provided in config', async () => {
      const mockParser = {
        getOperationById: vi.fn(),
        getOperationForCall: vi.fn()
      } as any;

      const transportWithParser = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          parser: mockParser
        },
        logger
      );

      const profileState = createProfileState(transportWithParser as any);
      const service = (transportWithParser as any).getToolFilterService(profileState);
      expect(service).toBeDefined();

      const toolFilterRequest = parseSessionToolFilterHeader('_allow_list');
      expect(toolFilterRequest.allowCategories.has('list')).toBe(true);

      await transportWithParser.stop();
    });

    it('creates ToolFilterService without detector when parser not provided', async () => {
      const transportWithoutParser = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics'
        },
        logger
      );

      const profileState = createProfileState(transportWithoutParser as any);
      const service = (transportWithoutParser as any).getToolFilterService(profileState);
      expect(service).toBeDefined();

      const toolFilterRequest = parseSessionToolFilterHeader('get_user');
      expect(toolFilterRequest.exactNames.has('get_user')).toBe(true);

      await transportWithoutParser.stop();
    });
  });

  describe('tool filter metrics', () => {
    it('records global tool filter metrics', async () => {
      const metricsTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: true,
          metricsPath: '/metrics',
        },
        logger
      );

      metricsTransport.recordGlobalToolFilterMetrics({
        originalCount: 4,
        allowedCount: 3,
        removedCount: 1,
        patternCounts: { allow_list: 1 },
      });

      const metricsOutput = await (metricsTransport as any).metrics.getMetrics();
      expect(metricsOutput).toContain('mcp_tools_total{source="profile"} 4');
      expect(metricsOutput).toContain('mcp_tools_filtered{source="global_env",action="allowed"} 3');
      expect(metricsOutput).toContain('mcp_tools_filtered{source="global_env",action="denied"} 1');

      await metricsTransport.stop();
    });

    it('records session tool filter metrics', async () => {
      const metricsTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: true,
          metricsPath: '/metrics',
        },
        logger
      );

      const sessionId = 'test-session';
      const request = parseSessionToolFilterHeader('get_user, list_users, regex:read_.*');

      metricsTransport.recordSessionToolFilterMetrics(sessionId, 2, request);

      const metricsOutput = await (metricsTransport as any).metrics.getMetrics();
      expect(metricsOutput).toContain(`mcp_tools_session{session_id="${sessionId}"} 2`);
      expect(metricsOutput).toContain('mcp_tool_filter_patterns{type="session_allow_list"} 2');
      expect(metricsOutput).toContain('mcp_tool_filter_patterns{type="session_allow_regex"} 1');

      await metricsTransport.stop();
    });

    it('records tool filter rejection metrics', async () => {
      const metricsTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: true,
          metricsPath: '/metrics',
        },
        logger
      );

      metricsTransport.recordToolFilterRejection('delete_user', 'env');
      metricsTransport.recordToolFilterRejection('drop_table', 'session');

      const metricsOutput = await (metricsTransport as any).metrics.getMetrics();
      expect(metricsOutput).toContain('mcp_tool_filter_rejections_total{tool="delete_user",source="env"} 1');
      expect(metricsOutput).toContain('mcp_tool_filter_rejections_total{tool="drop_table",source="session"} 1');

      await metricsTransport.stop();
    });

    it('skips metrics recording when metrics disabled', async () => {
      const noMetricsTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );

      noMetricsTransport.recordGlobalToolFilterMetrics({
        originalCount: 1,
        allowedCount: 1,
        removedCount: 0,
        patternCounts: {},
      });

      noMetricsTransport.recordSessionToolFilterMetrics('session', 1, parseSessionToolFilterHeader('tool'));
      noMetricsTransport.recordToolFilterRejection('tool', 'env');

      await noMetricsTransport.stop();
    });
  });

  describe('session tool filter getters/setters', () => {
    it('gets and sets session tool filter', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );
      const profileState = createProfileState(localTransport as any);
      const sessionId = (localTransport as any).createSession(profileState);

      const toolFilter: SessionToolFilter = {
        allowedToolNames: new Set(['get_user', 'list_users']),
        reasons: new Map(),
        patterns: { allow: [] },
        normalizedHeader: 'get_user, list_users'
      };

      localTransport.setSessionToolFilter('default', sessionId, toolFilter);
      const retrieved = localTransport.getSessionToolFilter('default', sessionId);

      expect(retrieved).toEqual(toolFilter);
      expect(retrieved?.allowedToolNames.has('get_user')).toBe(true);
      expect(retrieved?.allowedToolNames.has('list_users')).toBe(true);

      (localTransport as any).destroySession(profileState, sessionId);
      await localTransport.stop();
    });

    it('getSessionToolFilter returns undefined for non-existent session', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );

      const result = localTransport.getSessionToolFilter('default', 'non-existent');
      expect(result).toBeUndefined();

      await localTransport.stop();
    });

    it('setSessionToolFilter does nothing for non-existent session', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );

      const toolFilter: SessionToolFilter = {
        allowedToolNames: new Set(['tool']),
        reasons: new Map(),
        patterns: { allow: [] },
        normalizedHeader: 'tool'
      };

      localTransport.setSessionToolFilter('default', 'non-existent', toolFilter);

      await localTransport.stop();
    });
  });

  describe('origin / CIDR matching helpers', () => {
    it('allows localhost origins and configured host origin', async () => {
      const localTransport = new HttpTransport(
        {
          host: 'example.com',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        logger
      );

      const isAllowedOrigin = (localTransport as any).isAllowedOrigin.bind(localTransport);
      expect(isAllowedOrigin('http://localhost:1234')).toBe(true);
      expect(isAllowedOrigin('http://127.0.0.1:1234')).toBe(true);
      expect(isAllowedOrigin('https://example.com')).toBe(true);
      expect(isAllowedOrigin('https://not-example.com')).toBe(false);

      await localTransport.stop();
    });

    it('matches wildcard and exact allowed origins', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: ['*.example.com', 'exact.example.org'],
        } as any,
        logger
      );

      const isAllowedOrigin = (localTransport as any).isAllowedOrigin.bind(localTransport);
      expect(isAllowedOrigin('https://api.example.com')).toBe(true);
      expect(isAllowedOrigin('https://example.com')).toBe(true);
      expect(isAllowedOrigin('https://exact.example.org')).toBe(true);
      expect(isAllowedOrigin('https://nope.example.org')).toBe(false);

      await localTransport.stop();
    });

    it('allows origin matching OAuth redirect_uri from config', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: {
            redirect_uri: 'http://app.example.com/callback',
          },
        } as any,
        logger
      );

      const isAllowedOrigin = (localTransport as any).isAllowedOrigin.bind(localTransport);
      expect(isAllowedOrigin('http://app.example.com')).toBe(true);
      expect(isAllowedOrigin('http://not-app.example.com')).toBe(false);

      await localTransport.stop();
    });

    it('supports CIDR patterns and rejects invalid masks', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        logger
      );

      const matchOrigin = (localTransport as any).matchOrigin.bind(localTransport);
      expect(matchOrigin('192.168.1.50', '192.168.1.0/24')).toBe(true);
      expect(matchOrigin('192.168.2.50', '192.168.1.0/24')).toBe(false);
      expect(matchOrigin('10.0.0.1', '10.0.0.0/not-a-number')).toBe(false);

      await localTransport.stop();
    });

    it('parses IPv6 and IPv4-mapped IPv6 values', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        logger
      );

      expect(ipv6ToBigInt('2001:db8::1')).not.toBeNull();
      expect(ipv6ToBigInt('[2001:db8::1]')).not.toBeNull();
      expect(ipv6ToBigInt('::ffff:192.168.0.1')).not.toBeNull();
      expect(ipv6ToBigInt('not-an-ip')).toBeNull();

      await localTransport.stop();
    });

    it('collects OAuth redirect host patterns from states, config, and cache', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          oauthConfig: { redirect_uri: 'http://config.example.com/callback' },
        } as any,
        logger
      );

      (localTransport as any).profileStates.set('default', {
        profileId: 'default',
        context: { profileId: 'default' },
        oauthProvider: { redirectUri: 'http://state.example.com/callback' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      });
      (localTransport as any).profileStates.set('bad', {
        profileId: 'bad',
        context: { profileId: 'bad' },
        oauthProvider: { redirectUri: 'not-a-url' },
        oauthTokensByAccessToken: new Map(),
        sessions: new Map(),
      });
      (localTransport as any).oauthRedirectHostCache.set('cached', ['cached.example.com']);

      const hosts = (localTransport as any).getOAuthRedirectHostPatterns();
      expect(hosts).toContain('state.example.com');
      expect(hosts).toContain('config.example.com');
      expect(hosts).toContain('cached.example.com');

      await localTransport.stop();
    });

    it('extractRedirectHostPatterns handles missing and invalid redirect URIs', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        } as any,
        logger
      );

      const extractor = (localTransport as any).extractRedirectHostPatterns.bind(localTransport);
      expect(extractor(undefined, 'default')).toEqual([]);
      expect(extractor({ redirect_uri: 'not-a-url' }, 'default')).toEqual([]);

      await localTransport.stop();
    });

    it('resolveRedirectUriFromEnv returns literal values and resolves env', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        } as any,
        logger
      );

      const resolver = (localTransport as any).resolveRedirectUriFromEnv.bind(localTransport);
      expect(resolver('http://literal.example.com/cb', 'default')).toBe('http://literal.example.com/cb');

      process.env.OAUTH_REDIRECT_URI = 'http://env.example.com/cb';
      expect(resolver('${env:OAUTH_REDIRECT_URI}', 'default')).toBe('http://env.example.com/cb');
      delete process.env.OAUTH_REDIRECT_URI;

      await localTransport.stop();
    });

    it('resolves profile id from path and resource query', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
          defaultProfileId: 'default',
        } as any,
        logger
      );

      const fromPath = (localTransport as any).resolveProfileIdFromPath.bind(localTransport);
      expect(fromPath('/profile/gitlab/mcp')).toBe('gitlab');
      expect(fromPath('/not-profile/mcp')).toBeNull();
      expect(fromPath('/profile/%E0%A4%A/mcp')).toBeNull();

      const fromReq = (localTransport as any).resolveProfileIdForOriginCheck.bind(localTransport);
      const reqPath: any = { path: '/profile/alias/mcp', query: {} };
      expect(fromReq(reqPath)).toBe('alias');

      const reqResource: any = { path: '/mcp', query: { resource: 'http://localhost/profile/alpha/mcp' } };
      expect(fromReq(reqResource)).toBe('alpha');

      const reqDefault: any = { path: '/mcp', query: {} };
      expect(fromReq(reqDefault)).toBe('default');

      await localTransport.stop();
    });

    it('primeOAuthRedirectHosts caches empty configs and handles errors', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const warnSpy = vi.spyOn(logger, 'warn');
      (localTransport as any).setProfileContextProvider(async (id: string) => {
        if (id === 'missing') {
          throw new ConfigurationError('Profile not found');
        }
        if (id === 'boom') {
          throw new Error('boom');
        }
        return { profileId: id };
      });

      const primer = (localTransport as any).primeOAuthRedirectHosts.bind(localTransport);
      await primer('empty');
      expect((localTransport as any).oauthRedirectHostCache.get('empty')).toEqual([]);

      await primer('missing');
      await primer('boom');
      expect(warnSpy).toHaveBeenCalledWith(
        'Failed to preload OAuth redirect hosts',
        expect.objectContaining({ profileId: 'boom' })
      );

      warnSpy.mockRestore();
      await localTransport.stop();
    });

    it('isAllowedOriginForRequest returns false when routing disabled or no profile id', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        } as any,
        logger
      );

      const checker = (localTransport as any).isAllowedOriginForRequest.bind(localTransport);
      const req: any = withGet({ path: '/mcp', query: {} });
      expect(await checker('http://example.com', req)).toBe(false);

      await localTransport.stop();

      const routingTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const checkerRouting = (routingTransport as any).isAllowedOriginForRequest.bind(routingTransport);
      const reqNoProfile: any = withGet({ path: '/mcp', query: {} });
      expect(await checkerRouting('http://example.com', reqNoProfile)).toBe(false);

      await routingTransport.stop();
    });

    it('rejects invalid origin strings and ignores invalid oauth redirectUri', async () => {
      const localLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const localTransport = new HttpTransport(
        {
          host: 'example.com',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        localLogger as any
      );

      createProfileState(localTransport as any).oauthProvider = { redirectUri: 'not-a-url' };

      const isAllowedOrigin = (localTransport as any).isAllowedOrigin.bind(localTransport);
      expect(isAllowedOrigin('not-a-url')).toBe(false);
      expect(isAllowedOrigin('https://not-example.com')).toBe(false);

      await localTransport.stop();
    });

    it('matches IPv6 CIDR patterns and rejects invalid IPv6 masks', async () => {
      const localLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        localLogger as any
      );

      const matchOrigin = (localTransport as any).matchOrigin.bind(localTransport);
      expect(matchOrigin('2001:db8::1', '2001:db8::/32')).toBe(true);
      expect(matchOrigin('2001:db9::1', '2001:db8::/32')).toBe(false);
      expect(matchOrigin('2001:db8::1', '2001:db8::/129')).toBe(false);
      expect(localLogger.warn).toHaveBeenCalled();

      expect(ipv6Mask(0)).toBe(0n);

      await localTransport.stop();
    });

    it('ipv4ToInt rejects invalid IPv4 inputs', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        logger
      );

      expect(ipv4ToInt('1.2.3')).toBeNull();
      expect(ipv4ToInt('256.1.1.1')).toBeNull();

      await localTransport.stop();
    });

    it('ipv6ToBigInt rejects invalid IPv6 inputs', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          allowedOrigins: [],
        } as any,
        logger
      );

      expect(ipv6ToBigInt('2001:db8:::1')).toBeNull();
      expect(ipv6ToBigInt('2001::db8::1')).toBeNull();
      expect(ipv6ToBigInt('2001:db8:zzzz::1')).toBeNull();
      expect(ipv6ToBigInt('1:2:3:4:5:6:7:8:9')).toBeNull();

      await localTransport.stop();
    });

    it('allows origin when profile OAuth redirect_uri is set via env before init', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      process.env.OAUTH_REDIRECT_URI = 'http://oauth.example.com/callback';
      localTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          redirect_uri: '${env:OAUTH_REDIRECT_URI}',
        },
      }));

      const req: any = withGet({ path: '/profile/gitlab/oauth/authorize', query: {}, headers: {} });
      const isAllowed = await (localTransport as any).isAllowedOriginForRequest('http://oauth.example.com', req);
      expect(isAllowed).toBe(true);

      delete process.env.OAUTH_REDIRECT_URI;
      await localTransport.stop();
    });

    it('warns when OAuth redirect_uri env var is empty', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const warnSpy = vi.spyOn(logger, 'warn');
      process.env.OAUTH_REDIRECT_URI = '';
      localTransport.setProfileContextProvider(async (id) => ({
        profileId: id,
        oauthConfig: {
          redirect_uri: '${env:OAUTH_REDIRECT_URI}',
        },
      }));

      const req: any = withGet({ path: '/profile/gitlab/oauth/authorize', query: {}, headers: {} });
      const isAllowed = await (localTransport as any).isAllowedOriginForRequest('http://oauth.example.com', req);
      expect(isAllowed).toBe(false);
      expect(warnSpy).toHaveBeenCalledWith(
        'OAuth redirect_uri environment variable is empty',
        expect.objectContaining({ profileId: 'gitlab', envVar: 'OAUTH_REDIRECT_URI' })
      );

      warnSpy.mockRestore();
      delete process.env.OAUTH_REDIRECT_URI;
      await localTransport.stop();
    });
  });

  describe('origin middleware error handling', () => {
    it('returns 403 when origin check throws', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        } as any,
        logger
      );

      (localTransport as any).isAllowedOriginForRequest = async () => {
        throw new Error('boom');
      };

      const app = (localTransport as any).app;
      const router = app._router ?? app.router;
      expect(router).toBeDefined();
      const originLayer = router.stack.find((layer: any) =>
        typeof layer.handle === 'function' && layer.handle.toString().includes('isAllowedOriginForRequest')
      );
      expect(originLayer).toBeDefined();

      const req: any = withGet({ headers: { origin: 'http://evil.example.com' }, ip: '127.0.0.1' });
      const res: any = {
        statusCode: 200,
        body: undefined,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          this.body = payload;
          return this;
        },
      };
      const next = vi.fn();

      originLayer.handle(req, res, next);
      await new Promise(resolve => setImmediate(resolve));

      expect(res.statusCode).toBe(403);
      expect(res.body.message).toBe('Origin not allowed');
      expect(next).not.toHaveBeenCalled();

      await localTransport.stop();
    });
  });

  describe('profile context resolution', () => {
    it('buildDefaultProfileContext returns null without default profile', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const context = (localTransport as any).buildDefaultProfileContext();
      expect(context).toBeNull();

      await localTransport.stop();
    });

    it('getProfileState returns null and warns when profile not found', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const warnSpy = vi.spyOn(logger, 'warn');
      localTransport.setProfileContextProvider(async () => {
        throw new ConfigurationError('Profile not found');
      });

      const state = await (localTransport as any).getProfileState('missing');
      expect(state).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith('Profile not found during request', { profileId: 'missing' });

      warnSpy.mockRestore();
      await localTransport.stop();
    });

    it('getProfileState returns null when provider returns null', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      localTransport.setProfileContextProvider(async () => null);
      const state = await (localTransport as any).getProfileState('missing');
      expect(state).toBeNull();

      await localTransport.stop();
    });

    it('getProfileStateForRequest returns null without profile id', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
          profileRoutingEnabled: true,
        } as any,
        logger
      );

      const req: any = withGet({ headers: {}, path: '/mcp' });
      const state = await (localTransport as any).getProfileStateForRequest(req);
      expect(state).toBeNull();

      await localTransport.stop();
    });

    it('rejects arbitrary bearer tokens when enterprise mode is required', async () => {
      const localTransport = new HttpTransport(
        {
          host: '127.0.0.1',
          port: 0,
          sessionTimeoutMs: 1800000,
          heartbeatEnabled: false,
          heartbeatIntervalMs: 30000,
          metricsEnabled: false,
          metricsPath: '/metrics',
        },
        logger
      );
      expect(
        (localTransport as any).hasTrustedEnterpriseToken('default', 'not-an-issued-enterprise-token')
      ).toBe(false);

      const issuedToken = (localTransport as any).inboundAuthTokenStore.issue({
        authType: 'enterprise',
        profileId: 'default',
        subject: 'user-1',
        scopes: ['api'],
        tenantId: 'tenant-a',
      });

      expect((localTransport as any).hasTrustedEnterpriseToken('default', issuedToken.token)).toBe(true);
      expect((localTransport as any).hasTrustedEnterpriseToken('default', issuedToken.token, 'tenant-a')).toBe(true);
      expect((localTransport as any).hasTrustedEnterpriseToken('default', issuedToken.token, 'tenant-b')).toBe(false);
      expect((localTransport as any).hasTrustedEnterpriseToken('other-profile', issuedToken.token)).toBe(false);

      await localTransport.stop();
    });
  });
});
