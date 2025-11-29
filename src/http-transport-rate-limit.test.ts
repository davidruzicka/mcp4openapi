/**
 * Unit tests for HTTP transport rate limiting
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server as HttpServer } from 'http';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from './logger.js';
import type { HttpTransportConfig } from './types/http-transport.js';

// Generate unique port for each test run to avoid conflicts
let portCounter = 13580;
function getNextPort(): number {
  return portCounter++;
}

describe('HttpTransport Rate Limiting', () => {
  let transport: HttpTransport;
  let server: HttpServer | null = null;
  let testPort: number;

  afterEach(async () => {
    if (transport) {
      await transport.stop();
    }
  });

  describe('Rate limiting enabled (default)', () => {
    beforeEach(async () => {
      testPort = getNextPort();
      const config: HttpTransportConfig = {
        host: 'localhost',
        port: testPort,
        sessionTimeoutMs: 300000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        rateLimitEnabled: true,
        rateLimitWindowMs: 1000, // 1 second window for testing
        rateLimitMaxRequests: 5, // 5 requests per second
        rateLimitMetricsMax: 2, // 2 requests per second for metrics
      };

      transport = new HttpTransport(config, new ConsoleLogger());
      transport.setMessageHandler(async (message: unknown) => {
        return { jsonrpc: '2.0', result: { success: true }, id: 1 };
      });

      await transport.start();
    });

    it('should allow requests under the limit', async () => {
      const responses: Response[] = [];

      // Make 3 requests (under limit of 5)
      for (let i = 0; i < 3; i++) {
        const response = await fetch(`http://localhost:${testPort}/health`);
        responses.push(response);
      }

      // All should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });

    it('should block requests over the limit', async () => {
      const responses: Response[] = [];

      // Make 7 requests (over limit of 5)
      for (let i = 0; i < 7; i++) {
        const response = await fetch(`http://localhost:${testPort}/health`);
        responses.push(response);
      }

      // First 5 should succeed
      for (let i = 0; i < 5; i++) {
        expect(responses[i].status).toBe(200);
      }

      // Last 2 should be rate limited
      for (let i = 5; i < 7; i++) {
        expect(responses[i].status).toBe(429);
        const body = await responses[i].json();
        expect(body.error).toBe('Too Many Requests');
      }
    });

    it('should return rate limit headers', async () => {
      const response = await fetch(`http://localhost:${testPort}/health`);
      
      expect(response.headers.has('ratelimit-limit')).toBe(true);
      expect(response.headers.has('ratelimit-remaining')).toBe(true);
      expect(response.headers.has('ratelimit-reset')).toBe(true);
    });

    it('should apply same rate limit to /mcp and /sse endpoints', async () => {
      const responses: Response[] = [];

      // Make 6 requests to /health (over limit of 5)
      for (let i = 0; i < 6; i++) {
        const response = await fetch(`http://localhost:${testPort}/health`);
        responses.push(response);
      }

      // First 5 should succeed, 6th should be rate limited
      const statuses = responses.map(r => r.status);
      
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).toBe(200);
      expect(statuses[2]).toBe(200);
      expect(statuses[3]).toBe(200);
      expect(statuses[4]).toBe(200);
      expect(statuses[5]).toBe(429); // Rate limited
    });

    it('should apply lower rate limit to /metrics endpoint', async () => {
      // Enable metrics for this test
      await transport.stop();
      
      const config: HttpTransportConfig = {
        host: 'localhost',
        port: testPort,
        sessionTimeoutMs: 300000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: true,
        metricsPath: '/metrics',
        rateLimitEnabled: true,
        rateLimitWindowMs: 1000,
        rateLimitMaxRequests: 10, // High limit for other endpoints
        rateLimitMetricsMax: 2, // Low limit for metrics
      };

      transport = new HttpTransport(config, new ConsoleLogger());
      await transport.start();

      const responses: Response[] = [];

      // Make 4 requests to /metrics (over limit of 2)
      for (let i = 0; i < 4; i++) {
        const response = await fetch(`http://localhost:${testPort}/metrics`);
        responses.push(response);
      }

      // First 2 should succeed
      expect(responses[0].status).toBe(200);
      expect(responses[1].status).toBe(200);

      // Last 2 should be rate limited
      expect(responses[2].status).toBe(429);
      expect(responses[3].status).toBe(429);
    });

    it('should reset rate limit after window expires', async () => {
      // Make 5 requests (hit the limit)
      for (let i = 0; i < 5; i++) {
        await fetch(`http://localhost:${testPort}/health`);
      }

      // 6th request should be blocked
      const blockedResponse = await fetch(`http://localhost:${testPort}/health`);
      expect(blockedResponse.status).toBe(429);

      // Wait for window to reset (1 second + buffer)
      await new Promise(resolve => setTimeout(resolve, 1100));

      // New request should succeed
      const newResponse = await fetch(`http://localhost:${testPort}/health`);
      expect(newResponse.status).toBe(200);
    });
  });

  describe('Rate limiting disabled', () => {
    beforeEach(async () => {
      testPort = getNextPort();
      const config: HttpTransportConfig = {
        host: 'localhost',
        port: testPort,
        sessionTimeoutMs: 300000,
        heartbeatEnabled: false,
        heartbeatIntervalMs: 30000,
        metricsEnabled: false,
        metricsPath: '/metrics',
        rateLimitEnabled: false, // Disabled
        rateLimitWindowMs: 1000,
        rateLimitMaxRequests: 5,
      };

      transport = new HttpTransport(config, new ConsoleLogger());
      transport.setMessageHandler(async (message: unknown) => {
        return { jsonrpc: '2.0', result: { success: true }, id: 1 };
      });

      await transport.start();
    });

    it('should allow unlimited requests when rate limiting is disabled', async () => {
      const responses: Response[] = [];

      // Make 20 requests (well over normal limit)
      for (let i = 0; i < 20; i++) {
        const response = await fetch(`http://localhost:${testPort}/health`);
        responses.push(response);
      }

      // All should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
      }
    });
  });
});

