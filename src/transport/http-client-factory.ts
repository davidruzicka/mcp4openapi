/**
 * HTTP Client Factory - unified HTTP client management
 *
 * Why: Eliminates code duplication in HTTP client creation and management
 * Provides consistent client lifecycle, auth handling, and caching
 */

import { InterceptorChain, HttpClient } from './interceptors.js';
import type { MetricsCollector } from '../core/metrics.js';
import type { Profile } from '../types/profile.js';
import { ConfigurationError, AuthenticationError } from '../core/errors.js';

export interface HttpClientConfig {
  profile: Profile;
  baseUrl: string;
  sessionToken?: string;
}

/**
 * Factory for creating and managing HTTP clients
 * Handles both global and session-specific clients
 */
export class HttpClientFactory {
  private globalClient?: HttpClient;
  private sessionClients = new Map<string, HttpClient>();
  private metrics: MetricsCollector | null = null;

  /**
   * Create global HTTP client (for stdio transport)
   */
  createGlobalClient(config: HttpClientConfig): HttpClient {
    const interceptors = this.createInterceptorChain(config);
    const client = new HttpClient(config.baseUrl, interceptors, this.metrics);
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
    const interceptors = this.createInterceptorChain(config);
    const newClient = new HttpClient(config.baseUrl, interceptors, this.metrics);

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
   * Get auth token for client creation
   */
  private getAuthToken(config: HttpClientConfig): string | undefined {
    // Priority: session token > environment token
    if (config.sessionToken) {
      return config.sessionToken;
    }

    const authConfigRaw = config.profile.interceptors?.auth;
    if (!authConfigRaw) {
      return undefined;
    }

    // Handle multi-auth: get primary non-OAuth config
    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    const sortedConfigs = authConfigs.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    const authConfig = sortedConfigs.find(c => c.type !== 'oauth');

    if (authConfig && authConfig.value_from_env) {
      return process.env[authConfig.value_from_env];
    }

    return undefined;
  }

  /**
   * Create interceptor chain for client
   */
  private createInterceptorChain(config: HttpClientConfig): InterceptorChain {
    const token = this.getAuthToken(config);
    return new InterceptorChain(config.profile.interceptors || {}, token);
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

    // Check if we have any auth token available
    const hasToken = this.getAuthToken(config);
    if (!hasToken && config.profile.interceptors?.auth) {
      const authConfigRaw = config.profile.interceptors.auth;
      const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
      const nonOAuthConfig = authConfigs.find(c => c.type !== 'oauth');
      const envVar = nonOAuthConfig?.value_from_env || 'MCP4_API_TOKEN';
      throw new AuthenticationError(
        `No auth token available. Expected token in Authorization header or ${envVar} env var`,
        { envVar }
      );
    }
  }
}
