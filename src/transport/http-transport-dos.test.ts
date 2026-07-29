import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { HttpTransport } from './http-transport.js';
import { ConsoleLogger } from '../core/logger.js';


describe('HttpTransport - DoS Prevention (Profile Hints)', () => {
  let transport: HttpTransport;
  let logger: ConsoleLogger;

  beforeEach(() => {
    logger = new ConsoleLogger();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (transport) {
      transport.stop();
    }
  });

  it('should evict the oldest profile hint when MAX_PROFILE_HINTS is reached', () => {
    transport = new HttpTransport({ port: 0 }, logger);
    // @ts-expect-error accessing private property for testing
    const maxHints = HttpTransport.MAX_PROFILE_HINTS;

    // Simulate requests to store profile hints
    for (let i = 0; i < maxHints; i++) {
      const mockReq = { ip: `10.0.0.${i % 256}`, get: () => `test-agent-${i}` } as any;
      // @ts-expect-error accessing private method for testing
      transport.storeProfileHint(mockReq, 'test-profile');
    }

    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.size).toBe(maxHints);

    // Get the first key (oldest)
    // @ts-expect-error accessing private property for testing
    const firstKey = transport.profileHintsByClient.keys().next().value;
    expect(firstKey).toBe('10.0.0.0|test-agent-0');
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has(firstKey)).toBe(true);

    // Add one more
    const mockReqOverflow = { ip: '192.168.1.1', get: () => 'overflow-agent' } as any;
    // @ts-expect-error accessing private method for testing
    transport.storeProfileHint(mockReqOverflow, 'test-profile');

    // Size should remain at maxHints
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.size).toBe(maxHints);

    // The oldest key should have been evicted
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has(firstKey)).toBe(false);

    // The new key should exist
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has('192.168.1.1|overflow-agent')).toBe(true);
  });

  it('should refresh the LRU order when a hint is updated', () => {
    transport = new HttpTransport({ port: 0 }, logger);
    // @ts-expect-error accessing private property for testing
    const maxHints = HttpTransport.MAX_PROFILE_HINTS;

    // Insert maxHints hints
    for (let i = 0; i < maxHints; i++) {
      const mockReq = { ip: `10.0.0.${i % 256}`, get: () => `test-agent-${i}` } as any;
      // @ts-expect-error accessing private method for testing
      transport.storeProfileHint(mockReq, 'test-profile');
    }

    const firstKey = '10.0.0.0|test-agent-0';
    const secondKey = '10.0.0.1|test-agent-1';

    // "Update" the first key (mock another request from same client)
    const mockReqFirst = { ip: '10.0.0.0', get: () => 'test-agent-0' } as any;
    // @ts-expect-error accessing private method for testing
    transport.storeProfileHint(mockReqFirst, 'test-profile');

    // Add one more (overflow)
    const mockReqOverflow = { ip: '192.168.1.1', get: () => 'overflow-agent' } as any;
    // @ts-expect-error accessing private method for testing
    transport.storeProfileHint(mockReqOverflow, 'test-profile');

    // Size should remain maxHints
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.size).toBe(maxHints);

    // The first key was refreshed, so it shouldn't be evicted. The second key is now the oldest.
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has(firstKey)).toBe(true);
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has(secondKey)).toBe(false);
  });

  it('should periodically clean up expired profile hints', () => {
    transport = new HttpTransport({ port: 0 }, logger);

    const mockReq1 = { ip: '10.0.0.1', get: () => 'agent-1' } as any;
    const mockReq2 = { ip: '10.0.0.2', get: () => 'agent-2' } as any;

    // @ts-expect-error accessing private method for testing
    transport.storeProfileHint(mockReq1, 'test-profile-1');

    // Advance time by half the TTL
    // @ts-expect-error accessing private property for testing
    vi.advanceTimersByTime(HttpTransport.PROFILE_HINT_TTL_MS / 2);

    // @ts-expect-error accessing private method for testing
    transport.storeProfileHint(mockReq2, 'test-profile-2');

    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.size).toBe(2);

    // Advance time so that the first hint expires, but not the second
    // @ts-expect-error accessing private property for testing
    vi.advanceTimersByTime((HttpTransport.PROFILE_HINT_TTL_MS / 2) + 1000);

    // Trigger cleanup
    // @ts-expect-error accessing private method for testing
    transport.cleanupExpiredSessions();

    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.size).toBe(1);
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has('10.0.0.1|agent-1')).toBe(false);
    // @ts-expect-error accessing private property for testing
    expect(transport.profileHintsByClient.has('10.0.0.2|agent-2')).toBe(true);
  });
});
