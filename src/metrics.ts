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
 * - Tool filtering stats
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
  
  // API metrics (calls to backend API)
  private apiCallsTotal: Counter;
  private apiCallDuration: Histogram;
  private apiCallErrors: Counter;

  // Tool filtering metrics
  private mcpToolsTotal: Gauge; // Original tool count
  private mcpToolsFiltered: Gauge; // Tools after global filter
  private mcpToolsSession: Gauge; // Per-session tool count
  private mcpToolFilterRejectionsTotal: Counter; // Blocked callTool attempts
  private mcpToolFilterPatterns: Gauge; // Active filter patterns

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

    // Tool filtering metrics
    this.mcpToolsTotal = new Gauge({
      name: `${prefix}tools_total`,
      help: 'Original tool count from profile',
      labelNames: ['source'], // e.g. 'profile'
      registers: [this.registry],
    });

    this.mcpToolsFiltered = new Gauge({
      name: `${prefix}tools_filtered`,
      help: 'Tools count after global filtering',
      labelNames: ['source', 'action'], // source='global_env', action='allowed'|'denied'
      registers: [this.registry],
    });

    this.mcpToolsSession = new Gauge({
      name: `${prefix}tools_session`,
      help: 'Per-session tool count',
      labelNames: ['session_id'],
      registers: [this.registry],
    });

    this.mcpToolFilterRejectionsTotal = new Counter({
      name: `${prefix}tool_filter_rejections_total`,
      help: 'Counter of blocked callTool attempts',
      labelNames: ['tool', 'source'], // source='env'|'session'
      registers: [this.registry],
    });

    this.mcpToolFilterPatterns = new Gauge({
      name: `${prefix}tool_filter_patterns`,
      help: 'Number of active filter patterns',
      labelNames: ['type'], // 'allow_regex'|'deny_list'|etc
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

  // --- Filtering Metrics ---

  /**
   * Record original tool count (before filtering)
   */
  recordTotalTools(count: number): void {
    if (!this.enabled) return;
    this.mcpToolsTotal.set({ source: 'profile' }, count);
  }

  /**
   * Record global filtered tool counts
   */
  recordGlobalFilterStats(allowedCount: number, deniedCount: number): void {
    if (!this.enabled) return;
    this.mcpToolsFiltered.set({ source: 'global_env', action: 'allowed' }, allowedCount);
    this.mcpToolsFiltered.set({ source: 'global_env', action: 'denied' }, deniedCount);
  }

  /**
   * Record session tool count
   */
  recordSessionToolCount(sessionId: string, count: number): void {
    if (!this.enabled) return;
    this.mcpToolsSession.set({ session_id: sessionId }, count);
  }

  /**
   * Remove session tool count (on destroy)
   */
  removeSessionToolCount(sessionId: string): void {
    if (!this.enabled) return;
    this.mcpToolsSession.remove({ session_id: sessionId });
  }

  /**
   * Record tool filter rejection
   */
  recordFilterRejection(tool: string, source: 'env' | 'session'): void {
    if (!this.enabled) return;
    this.mcpToolFilterRejectionsTotal.inc({ tool, source });
  }

  /**
   * Record active filter patterns count
   */
  recordFilterPatternCount(type: string, count: number): void {
    if (!this.enabled) return;
    this.mcpToolFilterPatterns.set({ type }, count);
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
