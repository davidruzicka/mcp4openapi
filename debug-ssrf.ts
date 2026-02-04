import { isIP } from 'node:net';

function isDisallowedIPv4(ip: string): boolean {
    const parts = ip.split('.').map(p => Number(p));
    if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true;
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true; // "this network"
    return false;
}

function isDisallowedIPv6(ip: string): boolean {
    const normalized = ip.toLowerCase();

    // Check for IPv4-mapped IPv6 address (::ffff:127.0.0.1)
    if (normalized.startsWith('::ffff:') || normalized.startsWith('0:0:0:0:0:ffff:')) {
      const ipv4Part = normalized.split(':').pop();
      console.log(`Checking mapped IPv4: ${ipv4Part} for ${normalized}`);
      if (ipv4Part && ipv4Part.includes('.')) {
        return isDisallowedIPv4(ipv4Part);
      }
    }

    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true; // loopback
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true; // unspecified
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
      return true; // link-local fe80::/10 (approx by prefix)
    }
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7 (approx by prefix)
    return false;
}

async function run() {
    const testIPs = [
        '::ffff:127.0.0.1',
        '::ffff:10.0.0.1',
        '::ffff:192.168.1.1'
    ];

    for (const ip of testIPs) {
        // Mock URL parsing behavior
        const url = new URL(`http://[${ip}]`);
        // Remove brackets
        const hostname = url.hostname.slice(1, -1);
        console.log(`Testing IP: ${hostname}`);
        const result = isDisallowedIPv6(hostname);
        console.log(`Result: ${result}`);
        if (!result) {
            console.error('FAILED');
            process.exit(1);
        }
    }
    console.log('SUCCESS');
}

run();
