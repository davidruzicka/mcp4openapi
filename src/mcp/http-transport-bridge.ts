/**
 * Narrow HTTP transport contracts used by MCPServer and MCPServerManager.
 *
 * Why: keep core MCP runtime code dependent on explicit session/runtime hooks
 * instead of the full concrete HttpTransport implementation.
 */

import type { FilteringRules } from '../core/filtering.js';
import type { MetricsCollector } from '../core/metrics.js';
import type { AuthInterceptor } from '../types/profile.js';
import type {
  SessionToolFilterCompat as SessionToolFilter,
  SessionToolFilterRequest,
} from '../tool-filter/index.js';

export type HttpMessageHandler = (
  message: unknown,
  sessionId?: string,
  profileId?: string
) => Promise<unknown>;

export type SessionDestroyedHandler = (
  profileId: string,
  sessionId: string
) => void | Promise<void>;

export interface MCPServerHttpBridge {
  stop(): Promise<void>;
  hasOAuthProvider(profileId?: string): boolean;
  ensureValidSessionToken(profileId: string, sessionId: string): Promise<boolean>;
  getSessionToken(profileId: string, sessionId: string): string | undefined;
  getSessionFiltering(profileId: string, sessionId: string): FilteringRules | undefined;
  getMetricsCollector?(): MetricsCollector | null;
  getOAuthProtectedResourceUrl?(profileId?: string): string;
  getSessionTenantContext?(
    profileId: string,
    sessionId: string
  ): {
    tenantId?: string;
    tenantBaseUrl?: string;
    tenantAuthConfigs?: AuthInterceptor[];
  } | undefined;
  getSessionToolFilter?(profileId: string, sessionId: string): SessionToolFilter | undefined;
  getSessionEnterpriseAllowedToolCategories?(
    profileId: string,
    sessionId: string
  ): Set<'list' | 'read' | 'modify' | 'admin'> | undefined;
  getSessionToolFilterRequest?(
    profileId: string,
    sessionId: string
  ): SessionToolFilterRequest | undefined;
  setSessionToolFilter?(profileId: string, sessionId: string, filter: SessionToolFilter): void;
  recordGlobalToolFilterMetrics?(summary: {
    originalCount: number;
    allowedCount: number;
    removedCount: number;
    patternCounts: Record<string, number>;
  }): void;
  recordSessionToolFilterMetrics?(
    sessionId: string,
    allowedCount: number,
    request: SessionToolFilterRequest
  ): void;
  recordToolFilterRejection?(toolName: string, source: string): void;
}

export interface MCPServerHttpRuntimeBridge extends MCPServerHttpBridge {
  start(): Promise<void>;
  setMessageHandler(handler: HttpMessageHandler): void;
  onSessionDestroyed(handler: SessionDestroyedHandler): void;
}
