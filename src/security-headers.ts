import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to add security headers to all responses
 *
 * Why:
 * - X-Content-Type-Options: nosniff - Prevents MIME-sniffing
 * - X-Frame-Options: DENY - Prevents clickjacking
 * - Content-Security-Policy: default-src 'self' - Reduces XSS risk
 * - Referrer-Policy: no-referrer - Protects user privacy
 * - Permissions-Policy: interest-cohort=() - Disables FLoC
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  // Prevent browser from guessing the MIME type
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent the site from being embedded in a frame (clickjacking protection)
  res.setHeader('X-Frame-Options', 'DENY');

  // Restrict resources to the same origin (XSS mitigation)
  // Note: This is a strict policy; might need adjustment if external resources are needed later
  res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");

  // Do not send referrer header
  res.setHeader('Referrer-Policy', 'no-referrer');

  // Disable FLoC (Federated Learning of Cohorts)
  res.setHeader('Permissions-Policy', 'interest-cohort=()');

  // HSTS (Strict-Transport-Security)
  // Only set if the request is secure (HTTPS) or signaled as such by a proxy
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}
