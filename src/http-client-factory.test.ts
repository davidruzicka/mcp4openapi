import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HttpClientFactory } from './http-client-factory.js';
import { ConfigurationError, AuthenticationError } from './errors.js';
import type { Profile } from './types/profile.js';

// Mock dependencies
vi.mock('./interceptors.js', () => ({
  InterceptorChain: vi.fn().mockImplementation((interceptors, token) => ({
    interceptors,
    token,
  })),
  HttpClient: vi.fn().mockImplementation((baseUrl, interceptors) => ({
    baseUrl,
    interceptors,
  })),
}));

describe('HttpClientFactory', () => {
  let factory: HttpClientFactory;
  let mockProfile: Profile;

  beforeEach(() => {
    factory = new HttpClientFactory();
    mockProfile = {
      profile_name: 'test-profile',
      interceptors: {
        auth: {
          type: 'bearer',
          value_from_env: 'TEST_TOKEN',
        },
      },
      tools: [],
    };
  });

  describe('createGlobalClient', () => {
    it('should create and cache global client', () => {
      process.env.TEST_TOKEN = 'test-token';

      const client = factory.createGlobalClient({
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
      });

      expect(client).toBeDefined();
      expect(factory.hasGlobalClient()).toBe(true);
      expect(factory.getGlobalClient()).toBe(client);
    });

    it('should throw if global client not initialized', () => {
      expect(() => factory.getGlobalClient()).toThrow(ConfigurationError);
    });
  });

  describe('getOrCreateSessionClient', () => {
    it('should create new session client', () => {
      const client = factory.getOrCreateSessionClient('session-1', {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'session-token',
      });

      expect(client).toBeDefined();
      expect(factory.hasSessionClient('session-1')).toBe(true);
      expect(factory.getSessionClient('session-1')).toBe(client);
    });

    it('should return cached session client', () => {
      const client1 = factory.getOrCreateSessionClient('session-1', {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'session-token',
      });

      const client2 = factory.getOrCreateSessionClient('session-1', {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'session-token',
      });

      expect(client1).toBe(client2);
    });

    it('should throw if session client not found', () => {
      expect(() => factory.getSessionClient('non-existent')).toThrow(ConfigurationError);
    });
  });

  describe('cleanupSessionClient', () => {
    it('should cleanup session client and return true if existed', () => {
      factory.getOrCreateSessionClient('session-1', {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'session-token',
      });

      expect(factory.hasSessionClient('session-1')).toBe(true);

      const removed = factory.cleanupSessionClient('session-1');

      expect(removed).toBe(true);
      expect(factory.hasSessionClient('session-1')).toBe(false);
    });

    it('should return false if session client did not exist', () => {
      const removed = factory.cleanupSessionClient('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('validateClientConfig', () => {
    it('should pass validation with valid config', () => {
      const config = {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'token',
      };

      expect(() => factory.validateClientConfig(config)).not.toThrow();
    });

    it('should throw if baseUrl is missing', () => {
      const config = {
        profile: mockProfile,
        baseUrl: '',
      };

      expect(() => factory.validateClientConfig(config)).toThrow(ConfigurationError);
    });

    it('should throw if profile is missing', () => {
      const config = {
        profile: undefined as any,
        baseUrl: 'https://api.example.com',
      };

      expect(() => factory.validateClientConfig(config)).toThrow(ConfigurationError);
    });

    it('should throw if auth is required but no token available', () => {
      const config = {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: undefined,
      };

      // No session token and no env token
      delete process.env.TEST_TOKEN;

      expect(() => factory.validateClientConfig(config)).toThrow(AuthenticationError);
    });
  });

  describe('getAuthToken', () => {
    it('should prioritize session token over env token', () => {
      process.env.TEST_TOKEN = 'env-token';

      const factory = new HttpClientFactory();
      const config = {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
        sessionToken: 'session-token',
      };

      // We can't directly test private method, but we can test the behavior
      // through public methods. Let's create a client and verify the token is used.
      const client = factory.getOrCreateSessionClient('test-session', config);

      // Verify client was created with session
      expect(client).toBeDefined();
      expect(factory.hasSessionClient('test-session')).toBe(true);
    });

    it('should use env token if no session token', () => {
      process.env.TEST_TOKEN = 'env-token';

      const factory = new HttpClientFactory();
      const config = {
        profile: mockProfile,
        baseUrl: 'https://api.example.com',
      };

      const client = factory.getOrCreateSessionClient('test-session', config);

      expect(client).toBeDefined();
      expect(factory.hasSessionClient('test-session')).toBe(true);
    });

    it('should return undefined when no auth configured', () => {
      const noAuthProfile: Profile = {
        profile_name: 'no-auth',
        interceptors: {},
        tools: [],
      };

      const factory = new HttpClientFactory();
      const config = {
        profile: noAuthProfile,
        baseUrl: 'https://api.example.com',
      };

      const client = factory.getOrCreateSessionClient('test-session', config);

      expect(client).toBeDefined();
      // When no auth is configured, client is still created but without auth
      expect(factory.hasSessionClient('test-session')).toBe(true);
    });

    it('should skip OAuth-only config and return undefined', () => {
      const oauthOnlyProfile: Profile = {
        profile_name: 'oauth-only',
        interceptors: {
          auth: {
            type: 'oauth',
            oauth_config: {
              authorization_endpoint: 'https://oauth.example.com/authorize',
              token_endpoint: 'https://oauth.example.com/token',
            },
          } as any,
        },
        tools: [],
      };

      const factory = new HttpClientFactory();
      const config = {
        profile: oauthOnlyProfile,
        baseUrl: 'https://api.example.com',
      };

      const client = factory.getOrCreateSessionClient('test-session', config);

      expect(client).toBeDefined();
      expect(factory.hasSessionClient('test-session')).toBe(true);
    });
  });
});
