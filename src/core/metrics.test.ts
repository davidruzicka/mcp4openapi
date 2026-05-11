/**
 * Tests for MetricsCollector
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsCollector } from './metrics.js';

describe('MetricsCollector', () => {
  let metrics: MetricsCollector;

  beforeEach(() => {
    metrics = new MetricsCollector({ enabled: true, prefix: 'test_' });
  });

  describe('HTTP Metrics', () => {
    it('should record HTTP requests', async () => {
      metrics.recordHttpRequest('POST', '/mcp', 200, 0.123, { profileId: 'grafana', tenantId: 'team-a' });
      metrics.recordHttpRequest('POST', '/mcp', 400, 0.045, { profileId: 'grafana', tenantId: 'team-a' });
      metrics.recordHttpRequest('GET', '/mcp', 200, 0.056, { profileId: 'grafana', tenantId: 'none' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_http_requests_total');
      expect(output).toContain('method="POST"');
      expect(output).toContain('path="/mcp"');
      expect(output).toContain('status="200"');
      expect(output).toContain('profile_id="grafana"');
      expect(output).toContain('tenant_id="team-a"');
    });

    it('should record HTTP request duration', async () => {
      metrics.recordHttpRequest('POST', '/mcp', 200, 0.5);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_http_request_duration_seconds');
      expect(output).toContain('bucket');
    });

    it('should normalize paths for metrics', async () => {
      metrics.recordHttpRequest('GET', '/mcp?sessionId=abc', 200, 0.1);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('path="/mcp"');
      expect(output).not.toContain('sessionId');
    });
  });

  describe('Session Metrics', () => {
    it('should track sessions created', async () => {
      metrics.recordSessionCreated({ profileId: 'grafana', tenantId: 'team-a' });
      metrics.recordSessionCreated({ profileId: 'grafana', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_sessions_created_total{profile_id="grafana",tenant_id="team-a"} 2');
    });

    it('should track sessions destroyed', async () => {
      metrics.recordSessionDestroyed({ profileId: 'grafana', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_sessions_destroyed_total{profile_id="grafana",tenant_id="team-a"} 1');
    });

    it('should track active sessions', async () => {
      metrics.recordSessionCreated({ profileId: 'grafana', tenantId: 'team-a' });
      metrics.recordSessionCreated({ profileId: 'grafana', tenantId: 'team-a' });
      metrics.recordSessionDestroyed({ profileId: 'grafana', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_sessions_active{profile_id="grafana",tenant_id="team-a"} 1');
    });

    it('uses fallback labels for missing profile and tenant context', async () => {
      metrics.recordSessionCreated();
      metrics.recordHttpRequest('GET', '/mcp', 200, 0.1);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_sessions_created_total{profile_id="unknown",tenant_id="none"} 1');
      expect(output).toContain('profile_id="unknown"');
      expect(output).toContain('tenant_id="none"');
    });
  });

  describe('Tool Call Metrics', () => {
    it('should record tool calls', async () => {
      metrics.recordToolCall('manage_badges', 'success', 0.5, { profileId: 'gitlab', tenantId: 'team-a' });
      metrics.recordToolCall('manage_badges', 'error', 0.3, { profileId: 'gitlab', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_tool_calls_total');
      expect(output).toContain('tool="manage_badges"');
      expect(output).toContain('status="success"');
      expect(output).toContain('status="error"');
      expect(output).toContain('profile_id="gitlab"');
      expect(output).toContain('tenant_id="team-a"');
    });

    it('should record tool call duration', async () => {
      metrics.recordToolCall('manage_badges', 'success', 1.5);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_tool_call_duration_seconds');
    });

    it('should record tool call errors', async () => {
      metrics.recordToolCallError('manage_badges', 'ValidationError', { profileId: 'gitlab', tenantId: 'team-a' });
      metrics.recordToolCallError('manage_badges', 'APIError', { profileId: 'gitlab', tenantId: 'team-a' });

      const output = await metrics.getMetrics();

      expect(output).toContain('test_tool_call_errors_total');
      expect(output).toContain('error_type="ValidationError"');
      expect(output).toContain('error_type="APIError"');
      expect(output).toContain('profile_id="gitlab"');
      expect(output).toContain('tenant_id="team-a"');
    });

    it('records upstream_host and client_identity labels when provided (OBS-02)', async () => {
      metrics.recordToolCall('manage_badges', 'success', 0.5, {
        profileId: 'gitlab',
        tenantId: 'team-a',
        upstreamHost: 'api.example.com',
        clientIdentity: 'svc-account',
      });

      const output = await metrics.getMetrics();

      expect(output).toContain('test_tool_calls_total');
      expect(output).toContain('upstream_host="api.example.com"');
      expect(output).toContain('client_identity="svc-account"');
      // Duration histogram should also carry the new dimensions
      expect(output).toContain('test_tool_call_duration_seconds');
    });

    it('defaults upstream_host to "none" and client_identity to "anonymous" when omitted (OBS-02)', async () => {
      metrics.recordToolCall('manage_badges', 'success', 0.5, {
        profileId: 'gitlab',
        tenantId: 'team-a',
      });

      const output = await metrics.getMetrics();

      expect(output).toContain('upstream_host="none"');
      expect(output).toContain('client_identity="anonymous"');
    });

    it('truncates client_identity to 64 chars (OBS-02)', async () => {
      const longIdentity = 'c'.repeat(100);
      metrics.recordToolCall('manage_badges', 'success', 0.1, {
        profileId: 'gitlab',
        tenantId: 'team-a',
        clientIdentity: longIdentity,
      });

      const output = await metrics.getMetrics();

      // Should contain exactly 64 'c' characters
      expect(output).toContain(`client_identity="${'c'.repeat(64)}"`);
      // Should NOT contain 100-character value (anchored on label value end)
      expect(output).not.toContain(`client_identity="${'c'.repeat(65)}"`);
    });

    it('truncates upstream_host to 128 chars (OBS-02)', async () => {
      const longHost = 'h'.repeat(200);
      metrics.recordToolCall('manage_badges', 'success', 0.1, {
        profileId: 'gitlab',
        tenantId: 'team-a',
        upstreamHost: longHost,
      });

      const output = await metrics.getMetrics();

      expect(output).toContain(`upstream_host="${'h'.repeat(128)}"`);
      expect(output).not.toContain(`upstream_host="${'h'.repeat(129)}"`);
    });

    it('records upstream_host and client_identity for recordToolCallError (OBS-02)', async () => {
      metrics.recordToolCallError('manage_badges', 'ValidationError', {
        profileId: 'gitlab',
        tenantId: 'team-a',
        upstreamHost: 'api.example.com',
        clientIdentity: 'svc-account',
      });

      const output = await metrics.getMetrics();

      expect(output).toContain('test_tool_call_errors_total');
      expect(output).toContain('error_type="ValidationError"');
      expect(output).toContain('upstream_host="api.example.com"');
      expect(output).toContain('client_identity="svc-account"');
    });
  });

  describe('API Call Metrics', () => {
    it('should record API calls', async () => {
      metrics.recordApiCall('get_project_badges', 200, 0.2, { profileId: 'gitlab', tenantId: 'team-a' });
      metrics.recordApiCall('create_badge', 201, 0.3, { profileId: 'gitlab', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_api_calls_total');
      expect(output).toContain('operation="get_project_badges"');
      expect(output).toContain('status="2xx"');
      expect(output).toContain('profile_id="gitlab"');
      expect(output).toContain('tenant_id="team-a"');
    });

    it('should record API call duration', async () => {
      metrics.recordApiCall('get_project_badges', 200, 0.5);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_api_call_duration_seconds');
    });

    it('should record API call errors', async () => {
      metrics.recordApiCallError('get_project_badges', 'NetworkError', { profileId: 'gitlab', tenantId: 'team-a' });
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('test_api_call_errors_total');
      expect(output).toContain('error_type="NetworkError"');
      expect(output).toContain('profile_id="gitlab"');
      expect(output).toContain('tenant_id="team-a"');
    });

    it('should group status codes (2xx, 4xx, 5xx)', async () => {
      metrics.recordApiCall('operation1', 200, 0.1);
      metrics.recordApiCall('operation2', 404, 0.1);
      metrics.recordApiCall('operation3', 500, 0.1);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('status="2xx"');
      expect(output).toContain('status="4xx"');
      expect(output).toContain('status="5xx"');
    });

    it('uses unknown status label for non-standard status codes', async () => {
      metrics.recordApiCall('weird_status', 700, 0.1);
      const output = await metrics.getMetrics();
      expect(output).toContain('operation="weird_status"');
      expect(output).toContain('status="unknown"');
    });

    it('uses fallback labels for tool and API metrics when context is missing', async () => {
      metrics.recordToolCall('manage_badges', 'success', 0.2);
      metrics.recordApiCall('get_project_badges', 200, 0.2);
      const output = await metrics.getMetrics();
      // OBS-02: tool_calls_total carries upstream_host and client_identity dimensions
      expect(output).toContain('test_tool_calls_total{tool="manage_badges",status="success",profile_id="unknown",tenant_id="none",upstream_host="none",client_identity="anonymous"} 1');
      expect(output).toContain('test_api_calls_total{operation="get_project_badges",status="2xx",profile_id="unknown",tenant_id="none"} 1');
    });

    it('records API cache events', async () => {
      metrics.recordApiCacheEvent('get_nodes', 'hit', { profileId: 'n8n', tenantId: 'none' });
      metrics.recordApiCacheEvent('get_nodes', 'miss', { profileId: 'n8n', tenantId: 'none' });

      const output = await metrics.getMetrics();
      expect(output).toContain('test_api_cache_events_total');
      expect(output).toContain('operation="get_nodes"');
      expect(output).toContain('event="hit"');
      expect(output).toContain('event="miss"');
    });
  });

  describe('Tool filter metrics', () => {
    it('records and clears per-session tool counts', async () => {
      metrics.recordToolsSession('s1', 10);
      metrics.clearToolsSession('s1');
      const output = await metrics.getMetrics();
      expect(output).toContain('test_tools_session');
    });

    it('records tool filter rejections, pattern counts, and exposes registry', async () => {
      metrics.recordToolFilterRejection('tool_a', 'session');
      metrics.recordToolFilterPatternCount('allow_names', 2);
      const output = await metrics.getMetrics();
      expect(output).toContain('test_tool_filter_rejections_total');
      expect(output).toContain('tool="tool_a"');
      expect(output).toContain('source="session"');
      expect(output).toContain('test_tool_filter_patterns');
      expect(metrics.getRegistry()).toBeDefined();
    });
  });

  describe('Disabled Metrics', () => {
    it('should not record metrics when disabled', async () => {
      const disabledMetrics = new MetricsCollector({ enabled: false });
      
      disabledMetrics.recordHttpRequest('POST', '/mcp', 200, 0.1);
      disabledMetrics.recordSessionCreated();
      disabledMetrics.recordToolCall('test', 'success', 0.1);
      disabledMetrics.recordApiCacheEvent('get_nodes', 'hit');
      
      const output = await disabledMetrics.getMetrics();
      
      expect(output).toBe('# Metrics disabled\n');
    });
  });

  describe('Custom Prefix', () => {
    it('should use custom prefix', async () => {
      const customMetrics = new MetricsCollector({ enabled: true, prefix: 'myapp_' });
      
      customMetrics.recordHttpRequest('POST', '/mcp', 200, 0.1);
      
      const output = await customMetrics.getMetrics();
      
      expect(output).toContain('myapp_http_requests_total');
    });

    it('should use default prefix when not specified', async () => {
      const defaultMetrics = new MetricsCollector({ enabled: true });
      
      defaultMetrics.recordHttpRequest('POST', '/mcp', 200, 0.1);
      
      const output = await defaultMetrics.getMetrics();
      
      expect(output).toContain('mcp_http_requests_total');
    });
  });

  describe('Status Labels', () => {
    it('should group 3xx status codes', async () => {
      metrics.recordHttpRequest('GET', '/mcp', 301, 0.1);
      metrics.recordHttpRequest('GET', '/mcp', 302, 0.1);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('status="301"');
      expect(output).toContain('status="302"');
    });

    it('should group 5xx status codes', async () => {
      metrics.recordHttpRequest('GET', '/mcp', 500, 0.1);
      metrics.recordHttpRequest('GET', '/mcp', 503, 0.1);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('status="500"');
      expect(output).toContain('status="503"');
    });
  });

  describe('Path Normalization', () => {
    it('should normalize /health path', async () => {
      metrics.recordHttpRequest('GET', '/health?check=true', 200, 0.1);
      
      const output = await metrics.getMetrics();
      
      expect(output).toContain('path="/health"');
      expect(output).not.toContain('check=true');
    });

    it('should normalize /metrics path', async () => {
      metrics.recordHttpRequest('GET', '/metrics', 200, 0.1);

      const output = await metrics.getMetrics();

      expect(output).toContain('path="/metrics"');
    });

    it('should normalize /ready path', async () => {
      metrics.recordHttpRequest('GET', '/ready', 200, 0.1);

      const output = await metrics.getMetrics();

      expect(output).toContain('path="/ready"');
    });

    it('should normalize /ready path with query string', async () => {
      metrics.recordHttpRequest('GET', '/ready?foo=bar', 503, 0.1);

      const output = await metrics.getMetrics();

      expect(output).toContain('path="/ready"');
      expect(output).not.toContain('foo=bar');
    });

    it('should normalize unknown paths to other', async () => {
      metrics.recordHttpRequest('GET', '/unknown/path?param=value', 200, 0.1);

      const output = await metrics.getMetrics();

      expect(output).toContain('path="other"');
      expect(output).not.toContain('param=value');
    });

    it('should use internal getStatusLabel for unusual status codes', async () => {
      // Test status code outside normal ranges (triggers 'unknown' label)
      metrics.recordHttpRequest('GET', '/mcp', 100, 0.1); // 1xx - informational
      
      const output = await metrics.getMetrics();
      
      // 100 is not in 2xx-5xx range, uses actual status as label
      expect(output).toContain('status="100"');
    });
  });
});
