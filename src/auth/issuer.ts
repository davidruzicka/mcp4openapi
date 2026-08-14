export function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/$/, '');
}
