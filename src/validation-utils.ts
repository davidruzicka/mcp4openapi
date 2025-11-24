/**
 * Validation utilities for common data types
 *
 * Why: Provides reusable validation functions for email, URI, and other formats
 * Centralizes validation logic and ensures consistency across the application
 */

import escapeHtml from 'escape-html';

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
