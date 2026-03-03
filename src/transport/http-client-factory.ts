/**
 * HTTP Client Factory - unified HTTP client management
 *
 * Why: Eliminates code duplication in HTTP client creation and management
 * Provides consistent client lifecycle, auth handling, and caching
 */

import { InterceptorChain, HttpClient } from './interceptors.js';
import type { MetricsCollector } from '../core/metrics.js';
import type { MetricsContextLabels } from '../core/metrics.js';
import type { Profile, AuthInterceptor } from '../types/profile.js';
import type { Logger } from '../core/logger.js';
import { ConfigurationError, AuthenticationError } from '../core/errors.js';
import { AuthStrategyRegistry } from './auth-strategies.js';
import type { ResolvedAuthRuntime } from './auth-runtime.js';

export interface HttpClientConfig {
  profile: Profile;
  baseUrl: string;
  sessionToken?: string;
  authConfigs?: AuthInterceptor[];
  metricsContext?: MetricsContextLabels;
  logger?: Logger;
}

/**
 * Factory for creating and managing HTTP clients
 * Handles both global and session-specific clients
 */
export class HttpClientFactory {
  private globalClient?: HttpClient;
  private sessionClients = new Map<string, HttpClient>();
  private metrics: MetricsCollector | null = null;
  private readonly authStrategyRegistry = new AuthStrategyRegistry();

  /**
   * Create global HTTP client (for stdio transport)
   */
  createGlobalClient(config: HttpClientConfig): HttpClient {
    const authRuntime = this.resolveAuthRuntime(config);
    const interceptors = this.createInterceptorChain(config, authRuntime);
    const client = new HttpClient(config.baseUrl, interceptors, this.metrics, config.logger, undefined, config.metricsContext);
    this.globalClient = client;
    return client;
  }

  /**
   * Get or create session-specific HTTP client
   */
  getOrCreateSessionClient(sessionId: string, config: HttpClientConfig): HttpClient {
    // Check cache first
    let client = this.sessionClients.get(sessionId);
    if (client) {
      return client;
    }

    // Create new client for session
    const authRuntime = this.resolveAuthRuntime(config);
    const interceptors = this.createInterceptorChain(config, authRuntime);
    const newClient = new HttpClient(config.baseUrl, interceptors, this.metrics, config.logger, undefined, config.metricsContext);

    // Double-check for race condition
    const existingClient = this.sessionClients.get(sessionId);
    if (existingClient) {
      return existingClient;
    }

    // Cache and return
    this.sessionClients.set(sessionId, newClient);
    return newClient;
  }

  /**
   * Get global client (throws if not initialized)
   */
  getGlobalClient(): HttpClient {
    if (!this.globalClient) {
      throw new ConfigurationError('Global HTTP client not initialized');
    }
    return this.globalClient;
  }

  /**
   * Get session client (throws if not exists)
   */
  getSessionClient(sessionId: string): HttpClient {
    const client = this.sessionClients.get(sessionId);
    if (!client) {
      throw new ConfigurationError(`Session HTTP client not found for session: ${sessionId}`);
    }
    return client;
  }

  /**
   * Cleanup session client
   */
  cleanupSessionClient(sessionId: string): boolean {
    return this.sessionClients.delete(sessionId);
  }

  /**
   * Check if global client exists
   */
  hasGlobalClient(): boolean {
    return !!this.globalClient;
  }

  /**
   * Check if session client exists
   */
  hasSessionClient(sessionId: string): boolean {
    return this.sessionClients.has(sessionId);
  }

  setMetricsCollector(metrics: MetricsCollector | null): void {
    this.metrics = metrics;
    if (this.globalClient) {
      this.globalClient.setMetricsCollector(metrics);
    }
    for (const client of this.sessionClients.values()) {
      client.setMetricsCollector(metrics);
    }
  }

  /**
   * Create interceptor chain for client
   */
  private createInterceptorChain(config: HttpClientConfig, authRuntime: ResolvedAuthRuntime): InterceptorChain {
    const interceptors = {
      ...(config.profile.interceptors || {}),
      ...(config.authConfigs ? { auth: config.authConfigs } : {}),
    };
    return new InterceptorChain(interceptors, authRuntime.authRuntime || authRuntime.authToken);
  }

  private resolveAuthRuntime(config: HttpClientConfig): ResolvedAuthRuntime {
    return this.authStrategyRegistry.resolve({
      profile: config.profile,
      baseUrl: config.baseUrl,
      authConfigs: config.authConfigs,
      sessionToken: config.sessionToken,
      logger: config.logger,
    });
  }

  /**
   * Validate client configuration
   */
  validateClientConfig(config: HttpClientConfig): void {
    if (!config.baseUrl) {
      throw new ConfigurationError('Base URL is required for HTTP client');
    }

    if (!config.profile) {
      throw new ConfigurationError('Profile is required for HTTP client');
    }

    const authRuntime = this.resolveAuthRuntime(config);
    const activeAuthConfig = authRuntime.activeAuthConfig;
    const hasCredentialSource = !!authRuntime.authToken || !!authRuntime.authRuntime;
    if (!hasCredentialSource && activeAuthConfig && activeAuthConfig.type !== 'oauth') {
      const envVar = activeAuthConfig.value_from_env || 'MCP4_API_TOKEN';
      throw new AuthenticationError(
        `No auth token available. Expected token in Authorization header or ${envVar} env var`,
        { envVar }
      );
    }
  }
}
