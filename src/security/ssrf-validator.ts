import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { ValidationError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';

export interface SSRFOptions {
  /**
   * Allow connections to private/loopback/link-local IP addresses.
   * Default: false
   */
  allowPrivateNetwork?: boolean;

  /**
   * Whitelist of allowed hostnames (supports *.example.com wildcards).
   * If provided, only hosts matching the whitelist are allowed.
   */
  allowedHosts?: string[];
}

/**
 * Validates URLs to prevent Server-Side Request Forgery (SSRF) attacks.
 * Checks against private IP ranges and DNS resolution.
 */
export class SSRFValidator {
  constructor(private logger: Logger) {}

  /**
   * Validate a URL against SSRF rules.
   * Throws ValidationError if the URL is not allowed.
   */
  async validate(url: string, options: SSRFOptions = {}): Promise<void> {
    const parsedUrl = new URL(url);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ValidationError(`Unsupported URL scheme: ${parsedUrl.protocol}`);
    }

    const hostnameRaw = parsedUrl.hostname.toLowerCase();

    // Remove brackets from IPv6 literals for checking
    const hostname = hostnameRaw.startsWith('[') && hostnameRaw.endsWith(']')
      ? hostnameRaw.slice(1, -1)
      : hostnameRaw;

    // 1. Check allowed hosts whitelist if configured
    if (options.allowedHosts && options.allowedHosts.length > 0) {
      if (!this.isAllowedHost(hostname, options.allowedHosts)) {
        this.logger.warn('SSRF blocked: host not in allowlist', {
          hostname,
          allowed_hosts: options.allowedHosts,
        });
        throw new ValidationError(
          `Host not in allowlist: '${hostname}'`
        );
      }
    }

    // If private networks are allowed, we can stop checks here unless specific logic is needed.
    // However, usually we still want to block metadata services if not explicitly allowed,
    // but the current requirement is mainly about private network access.
    if (options.allowPrivateNetwork) {
      return;
    }

    // 2. Check localhost/loopback/private IPs explicitly
    if (hostname === 'localhost') {
      this.logger.warn('SSRF blocked: localhost target', { hostname });
      throw new ValidationError('Hostname not allowed (localhost)');
    }

    const ipVersion = isIP(hostname);
    if (ipVersion === 4) {
      if (this.isDisallowedIPv4(hostname)) {
        this.logger.warn('SSRF blocked: private/loopback/link-local IPv4 target', { hostname });
        throw new ValidationError('IP address not allowed');
      }
    } else if (ipVersion === 6) {
      if (this.isDisallowedIPv6(hostname)) {
        this.logger.warn('SSRF blocked: private/loopback/link-local IPv6 target', { hostname });
        throw new ValidationError('IP address not allowed');
      }
    } else {
      // 3. DNS resolution check
      // Hostname: resolve to all IPs and block if any are private/loopback/link-local
      const addresses = await this.lookupAllIpAddresses(hostname);
      const disallowed = addresses.find(address => {
        const family = isIP(address);
        if (family === 4) return this.isDisallowedIPv4(address);
        if (family === 6) return this.isDisallowedIPv6(address);
        return false;
      });

      if (disallowed) {
        this.logger.warn('SSRF blocked: hostname resolves to private/loopback/link-local IP', {
          hostname,
          resolved_addresses: addresses,
        });
        throw new ValidationError('Hostname resolves to disallowed IP');
      }
    }
  }

  private async lookupAllIpAddresses(hostname: string): Promise<string[]> {
    const timeoutMs = 2000; // Increased to 2s to be safe

    let results: Array<{ address: string }> = [];
    try {
      results = (await Promise.race([
        lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string }>>,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DNS lookup timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ])) as Array<{ address: string }>;
    } catch (error) {
      this.logger.warn('SSRF blocked: DNS lookup failed', {
        hostname,
        error: error instanceof Error ? error.message : String(error),
      });
      // Fail secure: if we can't resolve it, we can't verify it's safe.
      throw new ValidationError(`DNS lookup failed for hostname '${hostname}'`);
    }

    const addresses = results.map(r => r.address).filter(Boolean);
    if (addresses.length === 0) {
      this.logger.warn('SSRF blocked: DNS lookup returned no addresses', { hostname });
      throw new ValidationError(`DNS lookup returned no addresses for hostname '${hostname}'`);
    }

    return addresses;
  }

  private isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
    const lower = hostname.toLowerCase();
    return allowedHosts.some(patternRaw => {
      const pattern = patternRaw.toLowerCase().trim();
      if (!pattern) return false;

      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        if (!suffix) return false;
        return lower.endsWith(`.${suffix}`);
      }

      return lower === pattern;
    });
  }

  private isDisallowedIPv4(ip: string): boolean {
    let addr: ipaddr.IPv4;
    try {
      const parsed = ipaddr.parse(ip);
      if (parsed.kind() !== 'ipv4') return true;
      addr = parsed as ipaddr.IPv4;
    } catch {
      return true;
    }

    return IPV4_CIDR_BLOCKS.some(block => addr.match(block));
  }

  private isDisallowedIPv6(ip: string): boolean {
    let addr: ipaddr.IPv6;
    try {
      const parsed = ipaddr.parse(ip);
      if (parsed.kind() !== 'ipv6') return true;
      addr = parsed as ipaddr.IPv6;
    } catch {
      return true;
    }

    if (addr.isIPv4MappedAddress()) {
      const ipv4 = addr.toIPv4Address();
      return IPV4_CIDR_BLOCKS.some(block => ipv4.match(block));
    }

    return IPV6_CIDR_BLOCKS.some(block => addr.match(block));
  }
}

const IPV4_CIDR_BLOCKS: Array<[ipaddr.IPv4, number]> = [
  '127.0.0.0/8', // loopback
  '10.0.0.0/8', // private
  '172.16.0.0/12', // private
  '192.168.0.0/16', // private
  '169.254.0.0/16', // link-local
  '192.0.0.0/24', // IETF protocol assignments
  '0.0.0.0/8', // "this network"
  '198.18.0.0/15', // benchmark testing
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
].map(cidr => ipaddr.parseCIDR(cidr) as [ipaddr.IPv4, number]);

const IPV6_CIDR_BLOCKS: Array<[ipaddr.IPv6, number]> = [
  '::1/128', // loopback
  '::/128', // unspecified
  'fe80::/10', // link-local
  'fc00::/7', // unique local
  'ff00::/8', // multicast
].map(cidr => ipaddr.parseCIDR(cidr) as [ipaddr.IPv6, number]);
