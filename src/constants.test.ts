import { describe, expect, it } from 'vitest';
import { HTTP_STATUS, MIME_TYPES, OAUTH_PATHS, OAUTH_RATE_LIMIT, TIME, TIMEOUTS, PROXY_CREDENTIALS } from './constants.js';

describe('constants', () => {
  describe('TIME', () => {
    it('should expose consistent time units', () => {
      expect(TIME.MS_PER_SECOND).toBe(1000);
      expect(TIME.SECONDS_PER_MINUTE).toBe(60);
      expect(TIME.MS_PER_MINUTE).toBe(TIME.SECONDS_PER_MINUTE * TIME.MS_PER_SECOND);
      expect(TIME.MS_PER_HOUR).toBe(TIME.MINUTES_PER_HOUR * TIME.MS_PER_MINUTE);
    });

    it('should keep derived time units aligned when base changes', () => {
      const minuteFromSeconds = TIME.SECONDS_PER_MINUTE * TIME.MS_PER_SECOND;
      const minuteFromHour = TIME.MS_PER_HOUR / TIME.MINUTES_PER_HOUR;
      expect(minuteFromSeconds).toBe(minuteFromHour);
    });
  });

  describe('HTTP_STATUS', () => {
    it('should map common HTTP statuses to numeric codes', () => {
      expect(HTTP_STATUS.OK).toBe(200);
      expect(HTTP_STATUS.NOT_FOUND).toBe(404);
      expect(HTTP_STATUS.TOO_MANY_REQUESTS).toBe(429);
      expect(HTTP_STATUS.INTERNAL_SERVER_ERROR).toBe(500);
    });

    it('should avoid conflicting numeric assignments', () => {
      const statusValues = Object.values(HTTP_STATUS);
      const uniqueValues = new Set(statusValues);
      expect(uniqueValues.size).toBe(statusValues.length);
    });
  });

  describe('MIME_TYPES', () => {
    it('should provide common MIME type headers', () => {
      expect(MIME_TYPES.JSON).toBe('application/json');
      expect(MIME_TYPES.EVENT_STREAM).toBe('text/event-stream');
      expect(MIME_TYPES.FORM_URLENCODED).toBe('application/x-www-form-urlencoded');
    });
  });

  describe('OAUTH_PATHS', () => {
    it('should include required OAuth endpoints', () => {
      expect(OAUTH_PATHS.AUTHORIZE).toBe('/oauth/authorize');
      expect(OAUTH_PATHS.TOKEN).toBe('/oauth/token');
      expect(OAUTH_PATHS.CALLBACK).toBe('/oauth/callback');
    });

    it('should surface well-known discovery paths', () => {
      expect(OAUTH_PATHS.WELL_KNOWN_AUTHORIZATION_SERVER).toBe('/.well-known/oauth-authorization-server');
      expect(OAUTH_PATHS.WELL_KNOWN_PROTECTED_RESOURCE).toBe('/.well-known/oauth-protected-resource/mcp');
    });
  });

  describe('TIMEOUTS', () => {
    it('should derive timeout values from time constants', () => {
      expect(TIMEOUTS.SESSION_TIMEOUT_MS).toBe(30 * TIME.MS_PER_MINUTE);
      expect(TIMEOUTS.HEARTBEAT_INTERVAL_MS).toBe(30 * TIME.MS_PER_SECOND);
      expect(TIMEOUTS.RATE_LIMIT_WINDOW_MS).toBe(TIME.MS_PER_MINUTE);
      expect(TIMEOUTS.CLEANUP_INTERVAL_MS).toBe(TIME.MS_PER_MINUTE);
    });

    it('should maintain ordering between session timeout and heartbeat', () => {
      expect(TIMEOUTS.SESSION_TIMEOUT_MS).toBeGreaterThan(TIMEOUTS.HEARTBEAT_INTERVAL_MS);
    });
  });

  describe('OAUTH_RATE_LIMIT', () => {
    it('should configure sensible OAuth defaults', () => {
      expect(OAUTH_RATE_LIMIT.MAX_REQUESTS).toBe(10);
      expect(OAUTH_RATE_LIMIT.WINDOW_MS).toBe(10 * TIME.MS_PER_MINUTE);
    });

    it('should align window duration with rate limit expectations', () => {
      const averageRequestsPerMinute = (OAUTH_RATE_LIMIT.MAX_REQUESTS * TIME.MS_PER_MINUTE) / OAUTH_RATE_LIMIT.WINDOW_MS;
      expect(averageRequestsPerMinute).toBeCloseTo(1);
    });
  });

  describe('PROXY_CREDENTIALS', () => {
    it('should have default values', () => {
      expect(PROXY_CREDENTIALS.CLIENT_ID).toBe('mcp-proxy-client');
      expect(PROXY_CREDENTIALS.CLIENT_SECRET).toBe('mcp-proxy-secret');
    });
  });
});
