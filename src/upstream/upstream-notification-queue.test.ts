/**
 * Tests for bounded notification queue
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { NotificationQueue } from './upstream-notification-queue.js';

describe('NotificationQueue', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates queue with default maxSize=50 and ttlMs=300000', () => {
    const queue = new NotificationQueue();
    expect(queue.size).toBe(0);
  });

  it('creates queue with custom maxSize and ttlMs', () => {
    const queue = new NotificationQueue({ maxSize: 3, ttlMs: 1000 });
    queue.push({ method: 'test', timestamp: Date.now() });
    queue.push({ method: 'test', timestamp: Date.now() });
    queue.push({ method: 'test', timestamp: Date.now() });
    expect(queue.size).toBe(3);
    // push 4th causes eviction of oldest
    queue.push({ method: 'test4', timestamp: Date.now() });
    expect(queue.size).toBe(3);
  });

  it('push adds entry to queue', () => {
    const queue = new NotificationQueue();
    queue.push({ method: 'tools/list_changed', timestamp: Date.now() });
    expect(queue.size).toBe(1);
  });

  it('drain returns all entries in insertion order and clears queue', () => {
    const queue = new NotificationQueue();
    const t = Date.now();
    queue.push({ method: 'a', timestamp: t });
    queue.push({ method: 'b', timestamp: t + 1 });
    queue.push({ method: 'c', timestamp: t + 2 });

    const result = queue.drain();
    expect(result).toHaveLength(3);
    expect(result[0].method).toBe('a');
    expect(result[1].method).toBe('b');
    expect(result[2].method).toBe('c');
    expect(queue.size).toBe(0);
  });

  it('drain on empty queue returns []', () => {
    const queue = new NotificationQueue();
    expect(queue.drain()).toEqual([]);
  });

  it('push when at maxSize evicts oldest entry', () => {
    const queue = new NotificationQueue({ maxSize: 2 });
    const t = Date.now();
    queue.push({ method: 'first', timestamp: t });
    queue.push({ method: 'second', timestamp: t + 1 });
    queue.push({ method: 'third', timestamp: t + 2 });

    expect(queue.size).toBe(2);
    const result = queue.drain();
    expect(result[0].method).toBe('second');
    expect(result[1].method).toBe('third');
  });

  it('evicts entries based on wall-clock time, not incoming entry timestamp', () => {
    vi.useFakeTimers();
    const queue = new NotificationQueue({ ttlMs: 1000 });
    queue.push({ method: 'test', timestamp: Date.now() });
    expect(queue.size).toBe(1);
    vi.advanceTimersByTime(1500); // 1.5s later
    queue.push({ method: 'test2', timestamp: Date.now() });
    expect(queue.size).toBe(1); // first entry evicted by TTL
  });

  it('size getter returns current queue length', () => {
    const queue = new NotificationQueue();
    expect(queue.size).toBe(0);
    queue.push({ method: 'a', timestamp: Date.now() });
    expect(queue.size).toBe(1);
    queue.push({ method: 'b', timestamp: Date.now() });
    expect(queue.size).toBe(2);
  });

  it('after drain, size is 0', () => {
    const queue = new NotificationQueue();
    queue.push({ method: 'a', timestamp: Date.now() });
    queue.drain();
    expect(queue.size).toBe(0);
  });

  it('multiple push + drain cycles work correctly (queue is reusable)', () => {
    const queue = new NotificationQueue();
    queue.push({ method: 'a', timestamp: Date.now() });
    queue.push({ method: 'b', timestamp: Date.now() });

    const first = queue.drain();
    expect(first).toHaveLength(2);
    expect(queue.size).toBe(0);

    queue.push({ method: 'c', timestamp: Date.now() });
    const second = queue.drain();
    expect(second).toHaveLength(1);
    expect(second[0].method).toBe('c');
  });

  it('drain evicts entries that expired while client was disconnected', () => {
    vi.useFakeTimers();
    const queue = new NotificationQueue({ ttlMs: 1000 });
    queue.push({ method: 'old', timestamp: Date.now() });
    vi.advanceTimersByTime(1500); // TTL has now passed without any push()
    const result = queue.drain();
    expect(result).toHaveLength(0); // stale entry must not be replayed
    expect(queue.size).toBe(0);
  });

  it('drain returns only non-expired entries when some are stale', () => {
    vi.useFakeTimers();
    const queue = new NotificationQueue({ ttlMs: 1000 });
    queue.push({ method: 'will-expire', timestamp: Date.now() });
    vi.advanceTimersByTime(500);
    queue.push({ method: 'still-valid', timestamp: Date.now() });
    vi.advanceTimersByTime(600); // first entry now 1100ms old, second is 600ms old
    const result = queue.drain();
    expect(result).toHaveLength(1);
    expect(result[0].method).toBe('still-valid');
  });

  it('push supports optional params field', () => {
    const queue = new NotificationQueue();
    queue.push({ method: 'tools/list_changed', timestamp: Date.now(), params: { count: 5 } });
    const result = queue.drain();
    expect(result[0].params).toEqual({ count: 5 });
  });

  it('TTL eviction does not remove non-expired entries', () => {
    vi.useFakeTimers();
    const queue = new NotificationQueue({ ttlMs: 5000 });
    queue.push({ method: 'recent', timestamp: Date.now() });
    vi.advanceTimersByTime(1000); // only 1s of 5s TTL passed
    queue.push({ method: 'new', timestamp: Date.now() });
    expect(queue.size).toBe(2); // both entries still valid
  });

  it('respects default maxSize of 50', () => {
    const queue = new NotificationQueue();
    for (let i = 0; i < 55; i++) {
      queue.push({ method: `event-${i}`, timestamp: Date.now() });
    }
    expect(queue.size).toBe(50);
    const result = queue.drain();
    expect(result[0].method).toBe('event-5'); // first 5 were evicted
  });
});
