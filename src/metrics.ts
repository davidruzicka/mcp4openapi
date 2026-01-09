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

export interface MetricsCollectorConfig {
  enabled: boolean;
  prefix?: string;
}

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
  private toolFilterRejectionsTotal: Counter;
  private toolFilterPatterns: Gauge;
  
  // API metrics (calls to backend API)
  private apiCallsTotal: Counter;
  private apiCallDuration: Histogram;
  private apiCallErrors: Counter;

  constructor(config: MetricsCollectorConfig) {
    this.enabled = config.enabled;
    this.registry = new Registry();
    
    const prefix = config.prefix || 'mcp_';

    // HTTP metrics
    this.httpRequestsTotal = new Counter({
      name: `${prefix}http_requests_total`,
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: `${prefix}http_request_duration_seconds`,
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status'],
      buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    // Session metrics
    this.sessionsActive = new Gauge({
      name: `${prefix}sessions_active`,
      help: 'Number of active sessions',
      registers: [this.registry],
    });

    this.sessionsCreatedTotal = new Counter({
      name: `${prefix}sessions_created_total`,
      help: 'Total number of sessions created',
      registers: [this.registry],
    });

    this.sessionsDestroyedTotal = new Counter({
      name: `${prefix}sessions_destroyed_total`,
      help: 'Total number of sessions destroyed',
      registers: [this.registry],
    });

    // MCP operation metrics
    this.mcpToolCallsTotal = new Counter({
      name: `${prefix}tool_calls_total`,
      help: 'Total number of MCP tool calls',
      labelNames: ['tool', 'status'],
      registers: [this.registry],
    });

    this.mcpToolCallDuration = new Histogram({
      name: `${prefix}tool_call_duration_seconds`,
      help: 'MCP tool call duration in seconds',
      labelNames: ['tool', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.mcpToolCallErrors = new Counter({
      name: `${prefix}tool_call_errors_total`,
      help: 'Total number of MCP tool call errors',
      labelNames: ['tool', 'error_type'],
      registers: [this.registry],
    });

    this.toolsTotal = new Gauge({
      name: `${prefix}tools_total`,
      help: 'Total number of tools',
      labelNames: ['source'],
      registers: [this.registry],
    });

    this.toolsFiltered = new Gauge({
      name: `${prefix}tools_filtered`,
      help: 'Tool filtering results',
      labelNames: ['source', 'action'],
      registers: [this.registry],
    });

    this.toolsSession = new Gauge({
      name: `${prefix}tools_session`,
      help: 'Tools available per session',
      labelNames: ['session_id'],
      registers: [this.registry],
    });

    this.toolFilterRejectionsTotal = new Counter({
      name: `${prefix}tool_filter_rejections_total`,
      help: 'Tool filter rejections',
      labelNames: ['tool', 'source'],
      registers: [this.registry],
    });

    this.toolFilterPatterns = new Gauge({
      name: `${prefix}tool_filter_patterns`,
      help: 'Active tool filter patterns',
      labelNames: ['type'],
      registers: [this.registry],
    });

    // API metrics
    this.apiCallsTotal = new Counter({
      name: `${prefix}api_calls_total`,
      help: 'Total number of API calls to backend',
      labelNames: ['operation', 'status'],
      registers: [this.registry],
    });

    this.apiCallDuration = new Histogram({
      name: `${prefix}api_call_duration_seconds`,
      help: 'API call duration in seconds',
      labelNames: ['operation', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.apiCallErrors = new Counter({
      name: `${prefix}api_call_errors_total`,
      help: 'Total number of API call errors',
      labelNames: ['operation', 'error_type'],
      registers: [this.registry],
    });
  }

  /**
   * Record HTTP request
   */
  recordHttpRequest(method: string, path: string, status: number, durationSeconds: number): void {
    if (!this.enabled) return;

    this.httpRequestsTotal.inc({
      method,
      path: this.normalizePath(path),
      status: status.toString(),
    });

    this.httpRequestDuration.observe(
      {
        method,
        path: this.normalizePath(path),
        status: status.toString(),
      },
      durationSeconds
    );
  }

  /**
   * Record session created
   */
  recordSessionCreated(): void {
    if (!this.enabled) return;
    this.sessionsCreatedTotal.inc();
    this.sessionsActive.inc();
  }

  /**
   * Record session destroyed
   */
  recordSessionDestroyed(): void {
    if (!this.enabled) return;
    this.sessionsDestroyedTotal.inc();
    this.sessionsActive.dec();
  }

  /**
   * Record MCP tool call
   */
  recordToolCall(tool: string, status: 'success' | 'error', durationSeconds: number): void {
    if (!this.enabled) return;

    this.mcpToolCallsTotal.inc({ tool, status });
    this.mcpToolCallDuration.observe({ tool, status }, durationSeconds);
  }

  /**
   * Record MCP tool call error
   */
  recordToolCallError(tool: string, errorType: string): void {
    if (!this.enabled) return;
    this.mcpToolCallErrors.inc({ tool, error_type: errorType });
  }

  recordToolFilterTotals(originalCount: number, survivingCount: number): void {
    if (!this.enabled) return;
    this.toolsTotal.set({ source: 'profile' }, originalCount);
    this.toolsFiltered.set({ source: 'global_env', action: 'allowed' }, survivingCount);
    this.toolsFiltered.set({ source: 'global_env', action: 'denied' }, originalCount - survivingCount);
  }

  recordToolFilterPatternCount(type: string, count: number): void {
    if (!this.enabled) return;
    this.toolFilterPatterns.set({ type }, count);
  }

  recordSessionToolCount(sessionId: string, count: number): void {
    if (!this.enabled) return;
    this.toolsSession.set({ session_id: sessionId }, count);
  }

  recordToolFilterRejection(tool: string, source: 'env' | 'session'): void {
    if (!this.enabled) return;
    this.toolFilterRejectionsTotal.inc({ tool, source });
  }

  /**
   * Record API call to backend
   */
  recordApiCall(operation: string, status: number, durationSeconds: number): void {
    if (!this.enabled) return;

    const statusLabel = this.getStatusLabel(status);
    
    this.apiCallsTotal.inc({ operation, status: statusLabel });
    this.apiCallDuration.observe({ operation, status: statusLabel }, durationSeconds);
  }

  /**
   * Record API call error
   */
  recordApiCallError(operation: string, errorType: string): void {
    if (!this.enabled) return;
    this.apiCallErrors.inc({ operation, error_type: errorType });
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
   */
  private normalizePath(path: string): string {
    // Remove query string
    const pathWithoutQuery = path.split('?')[0];
    
    // Known paths
    if (pathWithoutQuery === '/mcp' ||
        pathWithoutQuery === '/metrics' ||
        pathWithoutQuery === '/health') {
      return pathWithoutQuery;
    }
    
    return pathWithoutQuery;
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
}
