/**
 * Tests for UpstreamHeartbeatManager
 *
 * Verifies configurable heartbeat pings, failure callbacks,
 * cleanup, and idempotent start behavior using fake timers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UpstreamHeartbeatManager,
  DEFAULT_HEARTBEAT_CONFIG,
} from './upstream-heartbeat.js';

describe('UpstreamHeartbeatManager', () => {
  let manager: UpstreamHeartbeatManager;
  let mockPing: ReturnType<typeof vi.fn>;
  let onFailure: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new UpstreamHeartbeatManager();
    mockPing = vi.fn().mockResolvedValue(undefined);
    onFailure = vi.fn();
  });

  afterEach(() => {
    manager.stopAll();
    vi.useRealTimers();
  });

  describe('DEFAULT_HEARTBEAT_CONFIG', () => {
    it('has intervalMs of 30000', () => {
      expect(DEFAULT_HEARTBEAT_CONFIG.intervalMs).toBe(30000);
    });

    it('has timeoutMs of 5000', () => {
      expect(DEFAULT_HEARTBEAT_CONFIG.timeoutMs).toBe(5000);
    });
  });

  describe('start and ping interval', () => {
    it('calls ping after intervalMs elapses', async () => {
      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(30000);
      expect(mockPing).toHaveBeenCalledTimes(1);
    });

    it('calls ping twice after 2x intervalMs', async () => {
      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(60000);
      expect(mockPing).toHaveBeenCalledTimes(2);
    });

    it('does not call ping before intervalMs', async () => {
      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(29999);
      expect(mockPing).not.toHaveBeenCalled();
    });
  });

  describe('ping success', () => {
    it('does not invoke onFailure when ping succeeds', async () => {
      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(30000);
      expect(mockPing).toHaveBeenCalledTimes(1);
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('reports isRunning true after successful ping', async () => {
      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(30000);
      expect(manager.isRunning('session:provider')).toBe(true);
    });
  });

  describe('ping failure', () => {
    it('invokes onFailure when ping rejects', async () => {
      const pingError = new Error('connection lost');
      mockPing.mockRejectedValueOnce(pingError);

      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(30000);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure).toHaveBeenCalledWith(pingError);
    });

    it('wraps non-Error rejections in Error', async () => {
      mockPing.mockRejectedValueOnce('string error');

      manager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(30000);
      expect(onFailure).toHaveBeenCalledTimes(1);
      const receivedError = onFailure.mock.calls[0][0];
      expect(receivedError).toBeInstanceOf(Error);
      expect(receivedError.message).toBe('string error');
    });
  });

  describe('stop', () => {
    it('prevents further pings after stop', async () => {
      manager.start('session:provider', mockPing, onFailure);
      manager.stop('session:provider');

      await vi.advanceTimersByTimeAsync(60000);
      expect(mockPing).not.toHaveBeenCalled();
    });

    it('sets isRunning to false', () => {
      manager.start('session:provider', mockPing, onFailure);
      expect(manager.isRunning('session:provider')).toBe(true);

      manager.stop('session:provider');
      expect(manager.isRunning('session:provider')).toBe(false);
    });

    it('does not throw when stopping a non-running key', () => {
      expect(() => manager.stop('nonexistent')).not.toThrow();
    });
  });

  describe('stopAll', () => {
    it('stops all active timers', async () => {
      const mockPing2 = vi.fn().mockResolvedValue(undefined);
      manager.start('session:providerA', mockPing, onFailure);
      manager.start('session:providerB', mockPing2, onFailure);
      expect(manager.getActiveCount()).toBe(2);

      manager.stopAll();

      expect(manager.getActiveCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockPing).not.toHaveBeenCalled();
      expect(mockPing2).not.toHaveBeenCalled();
    });
  });

  describe('idempotent start', () => {
    it('does not create duplicate timers on double start', async () => {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const initialCallCount = setIntervalSpy.mock.calls.length;

      manager.start('session:provider', mockPing, onFailure);
      manager.start('session:provider', mockPing, onFailure);

      expect(setIntervalSpy.mock.calls.length - initialCallCount).toBe(1);

      await vi.advanceTimersByTimeAsync(30000);
      expect(mockPing).toHaveBeenCalledTimes(1);

      setIntervalSpy.mockRestore();
    });
  });

  describe('custom config', () => {
    it('uses custom intervalMs', async () => {
      const customManager = new UpstreamHeartbeatManager({
        intervalMs: 10000,
        timeoutMs: 3000,
      });

      customManager.start('session:provider', mockPing, onFailure);

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockPing).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10000);
      expect(mockPing).toHaveBeenCalledTimes(2);

      customManager.stopAll();
    });

    it('exposes config via getConfig()', () => {
      const customManager = new UpstreamHeartbeatManager({
        intervalMs: 10000,
      });
      const config = customManager.getConfig();
      expect(config.intervalMs).toBe(10000);
      expect(config.timeoutMs).toBe(5000);
    });
  });

  describe('isRunning', () => {
    it('returns false before start', () => {
      expect(manager.isRunning('session:provider')).toBe(false);
    });

    it('returns true after start', () => {
      manager.start('session:provider', mockPing, onFailure);
      expect(manager.isRunning('session:provider')).toBe(true);
    });

    it('returns false after stop', () => {
      manager.start('session:provider', mockPing, onFailure);
      manager.stop('session:provider');
      expect(manager.isRunning('session:provider')).toBe(false);
    });
  });

  describe('getActiveCount', () => {
    it('returns 0 with no active timers', () => {
      expect(manager.getActiveCount()).toBe(0);
    });

    it('returns correct count with multiple active timers', () => {
      manager.start('session:providerA', mockPing, onFailure);
      manager.start('session:providerB', mockPing, onFailure);
      expect(manager.getActiveCount()).toBe(2);
    });
  });

  describe('in-flight guard', () => {
    it('skips overlapping ping when previous ping is still running', async () => {
      // pingFn never resolves during the test - simulates a slow upstream
      let resolveFirstPing!: () => void;
      const slowPing = vi.fn().mockReturnValue(new Promise<void>(resolve => { resolveFirstPing = resolve; }));

      const fastManager = new UpstreamHeartbeatManager({ intervalMs: 100 });
      fastManager.start('session:provider', slowPing, onFailure);

      // First tick - starts the slow ping
      await vi.advanceTimersByTimeAsync(100);
      expect(slowPing).toHaveBeenCalledTimes(1);

      // Second tick fires while first ping is still in-flight - must be skipped
      await vi.advanceTimersByTimeAsync(100);
      expect(slowPing).toHaveBeenCalledTimes(1);

      // Third tick also skipped
      await vi.advanceTimersByTimeAsync(100);
      expect(slowPing).toHaveBeenCalledTimes(1);

      // First ping completes - next tick should fire
      resolveFirstPing();
      await vi.advanceTimersByTimeAsync(100);
      expect(slowPing).toHaveBeenCalledTimes(2);

      fastManager.stopAll();
    });
  });
});
