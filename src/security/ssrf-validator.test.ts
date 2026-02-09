import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSRFValidator } from './ssrf-validator.js';
import type { Logger } from '../core/logger.js';

// Mock DNS lookup
vi.mock('node:dns/promises', () => {
  return {
    lookup: vi.fn(),
  };
});

import { lookup } from 'node:dns/promises';

describe('SSRFValidator', () => {
  let validator: SSRFValidator;
  let mockLogger: Logger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    validator = new SSRFValidator(mockLogger);
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validate', () => {
    it('should allow valid public domains', async () => {
      (lookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      await expect(validator.validate('http://example.com')).resolves.not.toThrow();
    });

    it('should block localhost by hostname', async () => {
      await expect(validator.validate('http://localhost')).rejects.toThrow('Hostname not allowed (localhost)');
    });

    it('should block private IPv4 addresses', async () => {
      const privateIps = [
        'http://127.0.0.1',
        'http://10.0.0.1',
        'http://192.168.1.1',
        'http://172.16.0.1',
        'http://169.254.169.254',
        'http://198.18.0.1',
        'http://192.0.0.1',
      ];

      for (const ip of privateIps) {
        await expect(validator.validate(ip)).rejects.toThrow('IP address not allowed');
      }
    });

    it('should block IPv4-mapped IPv6 addresses for private IPs', async () => {
      const privateIps = [
        'http://[::ffff:127.0.0.1]',
        'http://[::ffff:10.0.0.1]',
        'http://[::ffff:192.168.1.1]',
      ];

      for (const ip of privateIps) {
        await expect(validator.validate(ip)).rejects.toThrow('IP address not allowed');
      }
    });

    it('should block private IPv6 addresses', async () => {
      const privateIps = [
        'http://[::1]',
        'http://[::]',
        'http://[fe80::1]',
        'http://[fc00::1]',
      ];

      for (const ip of privateIps) {
        await expect(validator.validate(ip)).rejects.toThrow('IP address not allowed');
      }
    });

    it('should block domains resolving to private IPs', async () => {
      (lookup as any).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(validator.validate('http://local.test')).rejects.toThrow('Hostname resolves to disallowed IP');
    });

    it('should allow public IPv6 addresses', async () => {
      await expect(validator.validate('http://[2001:4860:4860::8888]')).resolves.not.toThrow();
    });

    it('should allow domains resolving to public IPv6', async () => {
      (lookup as any).mockResolvedValue([{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]);
      await expect(validator.validate('http://ipv6.example.com')).resolves.not.toThrow();
    });

    it('should block domains resolving to private IPv6', async () => {
      (lookup as any).mockResolvedValue([{ address: 'fc00::1', family: 6 }]);
      await expect(validator.validate('http://private.ipv6')).rejects.toThrow('Hostname resolves to disallowed IP');
    });

    it('should allow private IPs if allowPrivateNetwork is true', async () => {
      await expect(
        validator.validate('http://127.0.0.1', { allowPrivateNetwork: true })
      ).resolves.not.toThrow();

      (lookup as any).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
      await expect(
        validator.validate('http://local.test', { allowPrivateNetwork: true })
      ).resolves.not.toThrow();
    });

    it('should enforce allowedHosts whitelist if provided', async () => {
      const options = { allowedHosts: ['example.com', '*.trusted.com'] };

      (lookup as any).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

      // Allowed
      await expect(validator.validate('http://example.com', options)).resolves.not.toThrow();
      await expect(validator.validate('http://api.trusted.com', options)).resolves.not.toThrow();

      // Blocked
      await expect(validator.validate('http://evil.com', options)).rejects.toThrow("Host not in allowlist");
      await expect(validator.validate('http://sub.example.com', options)).rejects.toThrow("Host not in allowlist");
    });

    it('should fail if DNS lookup fails', async () => {
      (lookup as any).mockRejectedValue(new Error('ENOTFOUND'));
      await expect(validator.validate('http://nonexistent.domain')).rejects.toThrow('DNS lookup failed');
    });

    it('should fail if DNS lookup returns no addresses', async () => {
      (lookup as any).mockResolvedValue([]);
      await expect(validator.validate('http://empty.domain')).rejects.toThrow('DNS lookup returned no addresses');
    });

    it('should handle DNS timeout', async () => {
        // Mock implementation that hangs
        (lookup as any).mockImplementation(() => new Promise(() => {}));

        // This relies on the internal timeout in the validator class (e.g. 2000ms)
        // To speed up test, we use fake timers
        vi.useFakeTimers();
        const promise = validator.validate('http://slow.dns');
        vi.advanceTimersByTime(3000);

        await expect(promise).rejects.toThrow('DNS lookup failed');
        vi.useRealTimers();
    });
  });
});
