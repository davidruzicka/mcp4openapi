import type { AuthInterceptor } from '../types/profile.js';
import type { AuthCredentials, RequestContext, ResponseContext } from './interceptors.js';

export interface AuthRuntimeProvider {
  prepareRequest(ctx: RequestContext): Promise<AuthCredentials>;
  getAuthCredentials(): AuthCredentials;
  onResponse(response: ResponseContext): Promise<void>;
  handleAuthFailure(response: ResponseContext): Promise<boolean>;
}

export interface ResolvedAuthRuntime {
  activeAuthConfig?: AuthInterceptor;
  authToken?: string;
  authRuntime?: AuthRuntimeProvider;
}
