/**
 * Utility functions for tool filtering
 */

/**
 * Normalize tool name using Unicode NFC normalization
 * 
 * Why: Ensures consistent matching across different Unicode representations
 * Example: "café" (composed) vs "café" (decomposed) match correctly
 */
export function normalizeToolName(name: string): string {
  return name.normalize('NFC');
}
