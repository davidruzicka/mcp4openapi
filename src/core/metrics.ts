/**
 * Prometheus Metrics Collector
 * 
 * Why: Observability for production deployments
 * 
 * Tracks:
 * - HTTP requests (status, method, path)
 * - Session lifecycle (active, created, destroyed)
 * - MCP operations (tool calls, duration, errors)
 * - API calls to backend (operation, status, duration)
 */

import { Registry, Counter, Gauge, Histogram } from 'prom-client';
import { INPUT_LIMITS } from './constants.js';

export interface MetricsCollectorConfig {
  enabled: boolean;
  prefix?: string;
}

export interface MetricsContextLabels {
  profileId?: string | null;
  tenantId?: string | null;
  /**
   * Host of the upstream the tool call targets (e.g. 'api.example.com').
   * Capped at 128 chars in Prometheus labels to bound cardinality.
   * Defaults to 'none' when absent.
   */
  upstreamHost?: string | null;
  /**
   * Client identity resolved from the inbound session principal (e.g. AuthorizedPrincipal.subject).
   * Used in audit log only — NOT a Prometheus label (per-user cardinality is unbounded).
   */
  clientIdentity?: string | null;
}

/** Max chars for the upstream_host Prometheus label - bounds cardinality. */
const UPSTREAM_HOST_LABEL_MAX = 128;

const SAFE_HTTP_METHODS = new Set(['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS']);

export class MetricsCollector {
  private registry: Registry;
  private enabled: boolean;
  
  // HTTP metrics
  private httpRequestsTotal: Counter;
  private httpRequestDuration: Histogram;
  
  // Session metrics
  private sessionsActive: Gauge;
  private sessionsCreatedTotal: Counter;
  private sessionsDestroyedTotal: Counter;
  
  // MCP operation metrics
  private mcpToolCallsTotal: Counter;
  private mcpToolCallDuration: Histogram;
  private mcpToolCallErrors: Counter;

  // Tool filter metrics
  private toolsTotal: Gauge;
  private toolsFiltered: Gauge;
  private toolsSession: Gauge;
  private toolFilterRejections: Counter;
  private toolFilterPatterns: Gauge;
  
  // API metrics (calls to backend API)
  private apiCallsTotal: Counter;
  private apiCallDuration: Histogram;
  private apiCallErrors: Counter;
  private apiCacheEventsTotal: Counter;

  constructor(config: MetricsCollectorConfig) {
    this.enabled = config.enabled;
    this.registry = new Registry();
    
    const prefix = config.prefix || 'mcp_';

    // HTTP metrics
    this.httpRequestsTotal = new Counter({
      name: `${prefix}http_requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status', 'profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status', 'profile_id', 'tenant_id'],
      buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    // Session metrics
    this.sessionsActive = new Gauge({
      name: `${prefix}sessions_active`,
      help: 'Number of active sessions',
      labelNames: ['profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    this.sessionsCreatedTotal = new Counter({
      name: `${prefix}sessions_created_total`,
      help: 'Total number of sessions created',
      labelNames: ['profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    this.sessionsDestroyedTotal = new Counter({
      name: `${prefix}sessions_destroyed_total`,
      help: 'Total number of sessions destroyed',
      labelNames: ['profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    // MCP operation metrics
    this.mcpToolCallsTotal = new Counter({
      name: `${prefix}tool_calls_total`,
      help: 'Total number of MCP tool calls',
      labelNames: ['tool', 'status', 'profile_id', 'tenant_id', 'upstream_host'],
      registers: [this.registry],
    });

    this.mcpToolCallDuration = new Histogram({
      name: `${prefix}tool_call_duration_seconds`,
      help: 'MCP tool call duration in seconds',
      labelNames: ['tool', 'status', 'profile_id', 'tenant_id', 'upstream_host'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.mcpToolCallErrors = new Counter({
      name: `${prefix}tool_call_errors_total`,
      help: 'Total number of MCP tool call errors',
      labelNames: ['tool', 'error_type', 'profile_id', 'tenant_id', 'upstream_host'],
      registers: [this.registry],
    });

    // Tool filter metrics
    this.toolsTotal = new Gauge({
      name: `${prefix}tools_total`,
      help: 'Total number of tools by source',
      labelNames: ['source'],
      registers: [this.registry],
    });

    this.toolsFiltered = new Gauge({
      name: `${prefix}tools_filtered`,
      help: 'Number of tools after filtering',
      labelNames: ['source', 'action'],
      registers: [this.registry],
    });

    this.toolsSession = new Gauge({
      name: `${prefix}tools_session`,
      help: 'Number of tools available per session',
      labelNames: ['session_id'],
      registers: [this.registry],
    });

    this.toolFilterRejections = new Counter({
      name: `${prefix}tool_filter_rejections_total`,
      help: 'Number of tool calls blocked by tool filters',
      labelNames: ['tool', 'source'],
      registers: [this.registry],
    });

    this.toolFilterPatterns = new Gauge({
      name: `${prefix}tool_filter_patterns`,
      help: 'Number of active tool filter patterns by type',
      labelNames: ['type'],
      registers: [this.registry],
    });

    // API metrics
    this.apiCallsTotal = new Counter({
      name: `${prefix}api_calls_total`,
      help: 'Total number of API calls to backend',
      labelNames: ['operation', 'status', 'profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    this.apiCallDuration = new Histogram({
      name: `${prefix}api_call_duration_seconds`,
      help: 'API call duration in seconds',
      labelNames: ['operation', 'status', 'profile_id', 'tenant_id'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.apiCallErrors = new Counter({
      name: `${prefix}api_call_errors_total`,
      help: 'Total number of API call errors',
      labelNames: ['operation', 'error_type', 'profile_id', 'tenant_id'],
      registers: [this.registry],
    });

    this.apiCacheEventsTotal = new Counter({
      name: `${prefix}api_cache_events_total`,
      help: 'Total number of API cache events',
      labelNames: ['operation', 'event', 'profile_id', 'tenant_id'],
      registers: [this.registry],
    });
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(
    method: string,
    path: string,
    status: number,
    durationSeconds: number,
    context?: MetricsContextLabels
  ): void {
    if (!this.enabled) return;
    const labels = this.resolveContextLabels(context);
    const safeMethod = this.safeMethodLabel(method);
    const statusLabel = this.getStatusLabel(status);

    this.httpRequestsTotal.inc({
      method: safeMethod,
      path: this.normalizePath(path),
      status: statusLabel,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
    });

    this.httpRequestDuration.observe(
      {
        method: safeMethod,
        path: this.normalizePath(path),
        status: statusLabel,
        profile_id: labels.profile_id,
        tenant_id: labels.tenant_id,
      },
      durationSeconds
    );
  }

  /**
   * Record session created
   */
  recordSessionCreated(context?: MetricsContextLabels): void {
    if (!this.enabled) return;
    const labels = this.resolveContextLabels(context);
    // Session metrics are registered with only profile_id/tenant_id labels.
    // Pass an explicit subset so prom-client does not reject the extra label keys
    // that resolveContextLabels also produces for tool-call metrics.
    const sessionLabels = { profile_id: labels.profile_id, tenant_id: labels.tenant_id };
    this.sessionsCreatedTotal.inc(sessionLabels);
    this.sessionsActive.inc(sessionLabels);
  }

  /**
   * Record session destroyed
   */
  recordSessionDestroyed(context?: MetricsContextLabels): void {
    if (!this.enabled) return;
    const labels = this.resolveContextLabels(context);
    const sessionLabels = { profile_id: labels.profile_id, tenant_id: labels.tenant_id };
    this.sessionsDestroyedTotal.inc(sessionLabels);
    this.sessionsActive.dec(sessionLabels);
  }

  /**
   * Record MCP tool call
   */
  recordToolCall(
    tool: string,
    status: 'success' | 'error' | 'rejected',
    durationSeconds: number,
    context?: MetricsContextLabels
  ): void {
    if (!this.enabled) return;
    const labels = this.resolveContextLabels(context);
    const safeToolName = this.safeToolLabel(tool);

    this.mcpToolCallsTotal.inc({
      tool: safeToolName,
      status,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
      upstream_host: labels.upstream_host,
    });
    this.mcpToolCallDuration.observe(
      {
        tool: safeToolName,
        status,
        profile_id: labels.profile_id,
        tenant_id: labels.tenant_id,
        upstream_host: labels.upstream_host,
      },
      durationSeconds
    );
  }

  /**
   * Record MCP tool call error
   */
  recordToolCallError(tool: string, errorType: string, context?: MetricsContextLabels): void {
    if (!this.enabled) return;
    const labels = this.resolveContextLabels(context);
    this.mcpToolCallErrors.inc({
      tool: this.safeToolLabel(tool),
      error_type: errorType,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
      upstream_host: labels.upstream_host,
    });
  }

  recordToolsTotal(source: string, count: number): void {
    if (!this.enabled) return;
    this.toolsTotal.set({ source }, count);
  }

  recordToolsFiltered(source: string, action: string, count: number): void {
    if (!this.enabled) return;
    this.toolsFiltered.set({ source, action }, count);
  }

  recordToolsSession(sessionId: string, count: number): void {
    if (!this.enabled) return;
    this.toolsSession.set({ session_id: sessionId }, count);
  }

  clearToolsSession(sessionId: string): void {
    if (!this.enabled) return;
    this.toolsSession.remove({ session_id: sessionId });
  }

  recordToolFilterRejection(tool: string, source: string): void {
    if (!this.enabled) return;
    this.toolFilterRejections.inc({ tool: this.safeToolLabel(tool), source });
  }

  recordToolFilterPatternCount(type: string, count: number): void {
    if (!this.enabled) return;
    this.toolFilterPatterns.set({ type }, count);
  }

  /**
   * Record API call to backend
   */
  recordApiCall(
    operation: string,
    status: number,
    durationSeconds: number,
    context?: MetricsContextLabels
  ): void {
    if (!this.enabled) return;

    const safeOp = this.safeOperationLabel(operation);
    const statusLabel = this.getStatusLabel(status);
    const labels = this.resolveContextLabels(context);

    this.apiCallsTotal.inc({
      operation: safeOp,
      status: statusLabel,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
    });
    this.apiCallDuration.observe(
      { operation: safeOp, status: statusLabel, profile_id: labels.profile_id, tenant_id: labels.tenant_id },
      durationSeconds
    );
  }

  /**
   * Record API call error
   */
  recordApiCallError(operation: string, errorType: string, context?: MetricsContextLabels): void {
    if (!this.enabled) return;
    const safeOp = this.safeOperationLabel(operation);
    const labels = this.resolveContextLabels(context);
    this.apiCallErrors.inc({
      operation: safeOp,
      error_type: errorType,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
    });
  }

  recordApiCacheEvent(operation: string, event: string, context?: MetricsContextLabels): void {
    if (!this.enabled) return;
    const safeOp = this.safeOperationLabel(operation);
    const labels = this.resolveContextLabels(context);
    this.apiCacheEventsTotal.inc({
      operation: safeOp,
      event,
      profile_id: labels.profile_id,
      tenant_id: labels.tenant_id,
    });
  }

  /**
   * Get metrics in Prometheus format
   */
  async getMetrics(): Promise<string> {
    if (!this.enabled) {
      return '# Metrics disabled\n';
    }
    return this.registry.metrics();
  }

  /**
   * Get registry (for testing)
   */
  getRegistry(): Registry {
    return this.registry;
  }

  /**
   * Normalize path for metrics (remove dynamic segments)
   *
   * Why: Avoid high cardinality in metrics labels
   *
   * Examples:
   * - /mcp?sessionId=abc123 -> /mcp
   * - /metrics -> /metrics
   * - /health -> /health
   * - /ready -> /ready
   */
  private normalizePath(path: string): string {
    // Remove query string
    const pathWithoutQuery = path.split('?')[0];

    // Known paths - explicit allowlist documents the gateway's stable surface
    // and guards against future code paths that might prepend dynamic segments.
    if (pathWithoutQuery === '/mcp' ||
        pathWithoutQuery === '/metrics' ||
        pathWithoutQuery === '/health' ||
        pathWithoutQuery === '/ready') {
      return pathWithoutQuery;
    }

    return 'other';
  }

  /**
   * Get status label (2xx, 4xx, 5xx)
   * 
   * Why: Group similar statuses to reduce cardinality
   */
  private getStatusLabel(status: number): string {
    if (status >= 200 && status < 300) return '2xx';
    if (status >= 300 && status < 400) return '3xx';
    if (status >= 400 && status < 500) return '4xx';
    if (status >= 500 && status < 600) return '5xx';
    return 'unknown';
  }

  private safeToolLabel(tool: string): string {
    if (!tool) return 'unknown';
    return tool.slice(0, INPUT_LIMITS.TOOL_NAME_LABEL);
  }

  private safeMethodLabel(method: string): string {
    const upper = method.toUpperCase();
    return SAFE_HTTP_METHODS.has(upper) ? upper : 'other';
  }

  private safeOperationLabel(operation: string): string {
    if (!operation) return 'unknown';
    return operation.slice(0, INPUT_LIMITS.OPERATION_LABEL);
  }

  private resolveContextLabels(context?: MetricsContextLabels): {
    profile_id: string;
    tenant_id: string;
    upstream_host: string;
  } {
    const profileId = context?.profileId?.trim();
    const tenantId = context?.tenantId?.trim();
    const upstreamHost = context?.upstreamHost?.trim();
    return {
      profile_id: profileId && profileId.length > 0 ? profileId : 'unknown',
      tenant_id: tenantId && tenantId.length > 0 ? tenantId : 'none',
      upstream_host:
        upstreamHost && upstreamHost.length > 0
          ? upstreamHost.slice(0, UPSTREAM_HOST_LABEL_MAX)
          : 'none',
    };
  }
}
