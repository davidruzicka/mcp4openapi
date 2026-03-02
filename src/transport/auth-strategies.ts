import type { Logger } from '../core/logger.js';
import type { AuthInterceptor, Profile } from '../types/profile.js';
import type { ResolvedAuthRuntime } from './auth-runtime.js';
import { SessionCookieAuthManager } from './session-cookie-auth.js';

export interface AuthStrategyContext {
  profile: Profile;
  baseUrl: string;
  authConfigs?: AuthInterceptor[];
  sessionToken?: string;
  logger?: Logger;
}

export class AuthStrategyRegistry {
  resolve(context: AuthStrategyContext): ResolvedAuthRuntime {
    const activeAuthConfig = this.selectActiveAuthConfig(context.authConfigs || context.profile.interceptors?.auth);
    if (!activeAuthConfig) {
      return {};
    }

    if (activeAuthConfig.type === 'session-cookie') {
      return {
        activeAuthConfig,
        authRuntime: new SessionCookieAuthManager(
          activeAuthConfig.session_cookie_config!,
          context.baseUrl,
          context.logger,
        ),
      };
    }

    if (activeAuthConfig.type === 'oauth') {
      return { activeAuthConfig };
    }

    return {
      activeAuthConfig,
      authToken: context.sessionToken || (activeAuthConfig.value_from_env
        ? process.env[activeAuthConfig.value_from_env]
        : undefined),
    };
  }

  selectActiveAuthConfig(authConfigRaw?: AuthInterceptor | AuthInterceptor[]): AuthInterceptor | undefined {
    if (!authConfigRaw) {
      return undefined;
    }

    const authConfigs = Array.isArray(authConfigRaw) ? authConfigRaw : [authConfigRaw];
    const sortedConfigs = [...authConfigs].sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return sortedConfigs.find((config) => config.type !== 'oauth') || sortedConfigs[0];
  }
}
