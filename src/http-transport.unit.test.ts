/**
 * Unit tests for HttpTransport that do not require a listening socket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import { parseSessionToolFilterHeader } from './tool-filter/index.js';
import type { SessionToolFilter } from './types/http-transport.js';

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

      const ipv6ToBigInt = (localTransport as any).ipv6ToBigInt.bind(localTransport);
      expect(ipv6ToBigInt('2001:db8::1')).not.toBeNull();
      expect(ipv6ToBigInt('[2001:db8::1]')).not.toBeNull();
      expect(ipv6ToBigInt('::ffff:192.168.0.1')).not.toBeNull();
      expect(ipv6ToBigInt('not-an-ip')).toBeNull();

      await localTransport.stop();
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

      const ipv6Mask = (localTransport as any).ipv6Mask.bind(localTransport);
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

      const ipv4ToInt = (localTransport as any).ipv4ToInt.bind(localTransport);
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

      const ipv6ToBigInt = (localTransport as any).ipv6ToBigInt.bind(localTransport);
      expect(ipv6ToBigInt('2001:db8:::1')).toBeNull();
      expect(ipv6ToBigInt('2001::db8::1')).toBeNull();
      expect(ipv6ToBigInt('2001:db8:zzzz::1')).toBeNull();
      expect(ipv6ToBigInt('1:2:3:4:5:6:7:8:9')).toBeNull();

      await localTransport.stop();
    });
  });
});
