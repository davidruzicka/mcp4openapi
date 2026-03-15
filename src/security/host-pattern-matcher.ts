import { isIP } from 'node:net';

export interface MatchCIDROptions {
  onInvalidIPv4Mask?: (cidr: string) => void;
  onInvalidIPv6Mask?: (cidr: string) => void;
}

export function matchHostPattern(hostname: string, pattern: string, options?: MatchCIDROptions): boolean {
  const normalizedHost = stripIpv6Brackets(hostname);
  const normalizedPattern = stripIpv6Brackets(pattern);

  if (normalizedHost === normalizedPattern) {
    return true;
  }

  if (normalizedPattern.startsWith('*.')) {
    const domain = normalizedPattern.slice(2);
    return normalizedHost === domain || normalizedHost.endsWith(`.${domain}`);
  }

  if (normalizedPattern.includes('/')) {
    return matchCIDR(normalizedHost, normalizedPattern, options);
  }

  return false;
}

export function matchCIDR(ip: string, cidr: string, options?: MatchCIDROptions): boolean {
  const [rawRange, bits] = cidr.split('/');
  const range = stripIpv6Brackets(rawRange);
  const maskBits = parseInt(bits, 10);

  if (Number.isNaN(maskBits)) {
    return false;
  }

  const ipVersion = isIP(ip);
  const rangeVersion = isIP(range);
  if (ipVersion === 0 || rangeVersion === 0 || ipVersion !== rangeVersion) {
    return false;
  }

  if (ipVersion === 4) {
    if (maskBits < 0 || maskBits > 32) {
      options?.onInvalidIPv4Mask?.(cidr);
      return false;
    }

    const ipInt = ipv4ToInt(ip);
    const rangeInt = ipv4ToInt(range);
    if (ipInt === null || rangeInt === null) {
      return false;
    }

    const mask = maskBits === 0 ? 0 : (0xFFFFFFFF << (32 - maskBits)) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  }

  if (maskBits < 0 || maskBits > 128) {
    options?.onInvalidIPv6Mask?.(cidr);
    return false;
  }

  const ipInt = ipv6ToBigInt(ip);
  const rangeInt = ipv6ToBigInt(range);
  if (ipInt === null || rangeInt === null) {
    return false;
  }

  const mask = ipv6Mask(maskBits);
  return (ipInt & mask) === (rangeInt & mask);
}

export function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    const octet = parseInt(part, 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) {
      return null;
    }
    result = (result << 8) | octet;
  }

  return result >>> 0;
}

export function ipv6ToBigInt(ip: string): bigint | null {
  const cleaned = stripIpv6Brackets(ip);

  let ipv4Tail: number | null = null;
  let base = cleaned;
  if (cleaned.includes('.')) {
    const lastColon = cleaned.lastIndexOf(':');
    if (lastColon === -1) {
      return null;
    }

    const ipv4Part = cleaned.slice(lastColon + 1);
    ipv4Tail = ipv4ToInt(ipv4Part);
    if (ipv4Tail === null) {
      return null;
    }

    base = cleaned.slice(0, lastColon);
  }

  const parts = base.split('::');
  if (parts.length > 2) {
    return null;
  }

  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  if (head.some(part => part === '') || tail.some(part => part === '')) {
    return null;
  }

  const totalSegmentsNeeded = 8 - (ipv4Tail !== null ? 2 : 0);
  const headValues = parseIpv6Hextets(head);
  const tailValues = parseIpv6Hextets(tail);
  if (headValues === null || tailValues === null) {
    return null;
  }

  const missingSegments = totalSegmentsNeeded - (headValues.length + tailValues.length);
  if (missingSegments < 0) {
    return null;
  }

  const segments = [
    ...headValues,
    ...Array<number>(missingSegments).fill(0),
    ...tailValues,
  ];
  if (segments.length !== totalSegmentsNeeded) {
    return null;
  }

  if (ipv4Tail !== null) {
    segments.push((ipv4Tail >>> 16) & 0xFFFF, ipv4Tail & 0xFFFF);
  }

  if (segments.length !== 8) {
    return null;
  }

  return segments.reduce((value, part) => (value << 16n) + BigInt(part), 0n);
}

export function ipv6Mask(maskBits: number): bigint {
  if (maskBits === 0) {
    return 0n;
  }

  const ones = (1n << BigInt(maskBits)) - 1n;
  return BigInt.asUintN(128, ones << BigInt(128 - maskBits));
}

export function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[/, '').replace(/\]$/, '');
}

function parseIpv6Hextets(parts: string[]): number[] | null {
  const values: number[] = [];
  for (const part of parts) {
    const value = parseInt(part || '0', 16);
    if (Number.isNaN(value) || value < 0 || value > 0xFFFF) {
      return null;
    }
    values.push(value);
  }

  return values;
}
