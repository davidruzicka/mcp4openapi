import { describe, expect, it, vi } from 'vitest';

import {
  ipv4ToInt,
  ipv6ToBigInt,
  matchCIDR,
  matchHostPattern,
  stripIpv6Brackets,
} from './host-pattern-matcher';

describe('host-pattern-matcher', () => {
  it('matches exact hosts, wildcard domains, and bracketed IPv6 hosts', () => {
    expect(matchHostPattern('example.com', 'example.com')).toBe(true);
    expect(matchHostPattern('api.example.com', '*.example.com')).toBe(true);
    expect(matchHostPattern('example.com', '*.example.com')).toBe(true);
    expect(matchHostPattern('[2001:db8::1]', '[2001:db8::1]')).toBe(true);
    expect(matchHostPattern('evil.com', '*.example.com')).toBe(false);
  });

  it('matches IPv4 and IPv6 CIDR ranges', () => {
    expect(matchCIDR('192.168.1.50', '192.168.1.0/24')).toBe(true);
    expect(matchCIDR('192.168.2.50', '192.168.1.0/24')).toBe(false);
    expect(matchCIDR('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(matchCIDR('2001:db9::1', '2001:db8::/32')).toBe(false);
  });

  it('reports invalid mask bits through caller-provided callbacks', () => {
    const onInvalidIPv4Mask = vi.fn();
    const onInvalidIPv6Mask = vi.fn();

    expect(
      matchCIDR('192.168.1.1', '192.168.1.0/40', {
        onInvalidIPv4Mask,
        onInvalidIPv6Mask,
      })
    ).toBe(false);
    expect(
      matchCIDR('2001:db8::1', '2001:db8::/129', {
        onInvalidIPv4Mask,
        onInvalidIPv6Mask,
      })
    ).toBe(false);

    expect(onInvalidIPv4Mask).toHaveBeenCalledWith('192.168.1.0/40');
    expect(onInvalidIPv6Mask).toHaveBeenCalledWith('2001:db8::/129');
  });

  it('rejects mismatched IP versions and malformed masks', () => {
    expect(matchCIDR('10.0.0.1', '2001:db8::/32')).toBe(false);
    expect(matchCIDR('::1', '10.0.0.0/8')).toBe(false);
    expect(matchCIDR('10.0.0.1', '10.0.0.0/not-a-number')).toBe(false);
  });

  it('converts IPv4 and IPv6 values into numeric forms', () => {
    expect(ipv4ToInt('192.168.1.1')).toBe(3232235777);
    expect(ipv4ToInt('999.1.1.1')).toBeNull();
    expect(ipv4ToInt('10.0.0')).toBeNull();

    const mapped = ipv6ToBigInt('::ffff:192.168.0.1');
    const canonical = ipv6ToBigInt('0:0:0:0:0:ffff:c0a8:1');

    expect(mapped).toEqual(canonical);
    expect(ipv6ToBigInt('2001::db8::1')).toBeNull();
    expect(ipv6ToBigInt('::ffff:999.1.1.1')).toBeNull();
  });

  it('normalizes IPv6 bracket wrappers before comparison', () => {
    expect(stripIpv6Brackets('[2001:db8::1]')).toBe('2001:db8::1');
    expect(stripIpv6Brackets('2001:db8::1')).toBe('2001:db8::1');
  });
});
