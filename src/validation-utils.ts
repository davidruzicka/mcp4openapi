/**
 * Validation utilities for common data types
 *
 * Why: Provides reusable validation functions for email, URI, and other formats
 * Centralizes validation logic and ensures consistency across the application
 */

import escapeHtml from 'escape-html';

/** Property names that must never be used as dynamic object keys */
const FORBIDDEN_PROPERTY_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

/**
 * Validates that a property name is safe to use as dynamic object key.
 * Prevents prototype pollution attacks.
 */
export function isSafePropertyName(name: string): boolean {
  return !FORBIDDEN_PROPERTY_NAMES.has(name);
}

/**
 * Escape special regex characters in a string.
 * Prevents ReDoS attacks when using dynamic strings in RegExp.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact specific header from headers object (case-insensitive)
 */
export function redactHeader(
  headers: unknown,
  headerName: string
): Record<string, unknown> {
  if (!headers || typeof headers !== 'object') return {};
  
  const redacted = { ...(headers as Record<string, unknown>) };
  
  for (const key of Object.keys(redacted)) {
    if (key.toLowerCase() === headerName.toLowerCase()) {
      redacted[key] = '[REDACTED]';
    }
  }
  
  return redacted;
}

/**
 * Redact query parameter from URL string
 */
export function redactQueryParam(
  url: string | undefined,
  paramName: string
): string {
  if (!url) return '';
  
  try {
    const urlObj = new URL(url);
    if (urlObj.searchParams.has(paramName)) {
      urlObj.searchParams.set(paramName, '[REDACTED]');
    }
    return urlObj.toString();
  } catch {
    const regex = new RegExp(`([?&]${escapeRegExp(paramName)}=)[^&]+`, 'gi');
    return url.replace(regex, `$1[REDACTED]`);
  }
}

/**
 * Redact parameter from params object
 */
export function redactParam(
  params: unknown,
  paramName: string
): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  
  const redacted = { ...(params as Record<string, unknown>) };
  if (paramName in redacted) {
    redacted[paramName] = '[REDACTED]';
  }
  
  return redacted;
}

/**
 * Validates if a string is a valid email address
 */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * Validates if a string is a valid URI
 */
export function isUri(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Escape HTML special characters to prevent XSS attacks
 * 
 * Why: User-provided strings in error messages must be sanitized
 * before being returned in JSON responses that might be rendered as HTML.
 * 
 * Uses escape-html library for reliable HTML entity escaping.
 * 
 * @param str - String to escape (can be undefined or null)
 * @returns Escaped string safe for HTML rendering, empty string if input is falsy
 */
export function escapeHtmlSafe(str: string | undefined | null): string {
  if (!str) return '';
  return escapeHtml(String(str));
}
