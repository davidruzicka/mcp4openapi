import { Request, Response, NextFunction } from 'express';

/**
 * Middleware to add security headers to all responses
 *
 * Why: Provides defense-in-depth against common web attacks
 * - X-Content-Type-Options: Prevents MIME-sniffing
 * - X-Frame-Options: Prevents clickjacking
 * - Strict-Transport-Security: Enforces HTTPS
 * - Content-Security-Policy: Restricts loaded resources
 */
export const addSecurityHeaders = (req: Request, res: Response, next: NextFunction) => {
  // Prevent sniffing of content type
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Prevent clickjacking (not strictly needed for API, but good practice)
  res.setHeader('X-Frame-Options', 'DENY');

  // Strict Transport Security (HSTS) - 1 year
  // Only applicable if HTTPS, but good practice to set generally for security scanning
  // We check secure flag or forwarded proto to determine if HSTS should be sent
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // Content Security Policy
  // Default to none for maximum security, as this is an API server
  // We don't serve HTML/scripts, so we can be very strict
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");

  // Permisison Policy
  // Disable powerful features not needed by an API
  res.setHeader('Permissions-Policy', 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()');

  // Referrer Policy
  // Don't leak referrer information
  res.setHeader('Referrer-Policy', 'no-referrer');

  next();
};
