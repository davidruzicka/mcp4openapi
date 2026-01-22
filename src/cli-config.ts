/**
 * CLI config helpers
 *
 * Why: Shared parsing and env override logic with tests.
 */

export function flagToEnvVar(flag: string): string {
  return `MCP4_${flag.replace(/-/g, '_').toUpperCase()}`;
}

export function parseCliArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    if (!raw) continue;
    const eqIndex = raw.indexOf('=');
    if (eqIndex !== -1) {
      const key = raw.slice(0, eqIndex);
      const value = raw.slice(eqIndex + 1);
      args[key] = value;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[raw] = next;
      i += 1;
      continue;
    }
    args[raw] = 'true';
  }
  return args;
}

export function applyCliEnvOverrides(args: Record<string, string>): void {
  for (const [key, value] of Object.entries(args)) {
    const envVar = flagToEnvVar(key);
    process.env[envVar] = value;
  }
}
