/**
 * Tool name length warning and recommendations
 *
 * Why: Help users understand name length issues and choose appropriate strategy
 */

import type { Logger } from './logger.js';
import { 
  shortenToolName, 
  pickMostSimilarPairs, 
  detectCollisions,
  NamingStrategy,
  type OperationForNaming 
} from './naming.js';

export interface NameWarningOptions {
  maxLength: number;
  similarTopN: number;
  similarityThreshold: number;
  minParts?: number;
  minLength?: number;
}

/**
 * Collect operations that exceed name length limit
 */
export function collectOffenders(
  operations: OperationForNaming[],
  maxLength: number
): OperationForNaming[] {
  return operations.filter(op => op.operationId.length > maxLength);
}

/**
 * Generate warnings and suggestions for long tool names
 */
export function generateNameWarnings(
  operations: OperationForNaming[],
  options: NameWarningOptions,
  logger: Logger
): void {
  const { maxLength, similarTopN, similarityThreshold } = options;
  
  const offenders = collectOffenders(operations, maxLength);
  
  if (offenders.length === 0) {
    return; // No warnings needed
  }

  logger.warn(`\n${'='.repeat(80)}`);
  logger.warn(`⚠️  Tool Name Length Warning`);
  logger.warn(`${'='.repeat(80)}\n`);
  
  logger.warn(`Detected ${offenders.length} tool names exceeding ${maxLength} characters.`);
  logger.warn(`Long names may be truncated or cause issues in some MCP clients.\n`);

  // Pick most similar pairs to show as examples
  const similarPairs = pickMostSimilarPairs(offenders, similarTopN, similarityThreshold);
  
  if (similarPairs.length > 0) {
    logger.warn(`Showing ${similarPairs.length} most similar name pairs with shortening suggestions:\n`);
    
    for (let i = 0; i < similarPairs.length; i++) {
      const pair = similarPairs[i];
      logger.warn(`${'-'.repeat(80)}`);
      logger.warn(`Example ${i + 1}/${similarPairs.length}:`);
      logger.warn(`  Operation A: ${pair.opA.operationId} (${pair.opA.operationId.length} chars)`);
      logger.warn(`  Operation B: ${pair.opB.operationId} (${pair.opB.operationId.length} chars)`);
      logger.warn(`  Similarity: ${(pair.similarity * 100).toFixed(1)}%\n`);
      
      // Show all strategies
      const strategies = [NamingStrategy.Balanced, NamingStrategy.Iterative, NamingStrategy.Hash];
      
      for (const strategy of strategies) {
        const resultA = shortenToolName(pair.opA, strategy, maxLength, operations, {
          minParts: options.minParts,
          minLength: options.minLength,
        });
        const resultB = shortenToolName(pair.opB, strategy, maxLength, operations, {
          minParts: options.minParts,
          minLength: options.minLength,
        });
        
        const collision = resultA.name === resultB.name ? '⚠️  COLLISION' : '✓ No collision';
        
        logger.warn(`  Strategy: ${strategy}`);
        logger.warn(`    A: ${resultA.name} (${resultA.name.length} chars)`);
        logger.warn(`    B: ${resultB.name} (${resultB.name.length} chars)`);
        logger.warn(`    ${collision}\n`);
      }
    }
  }

  // Show collision statistics for each strategy
  logger.warn(`${'-'.repeat(80)}`);
  logger.warn(`Collision Analysis:\n`);
  
  const strategies = [NamingStrategy.Balanced, NamingStrategy.Iterative, NamingStrategy.Hash];
  for (const strategy of strategies) {
    const collisions = detectCollisions(offenders, strategy, maxLength, {
      minParts: options.minParts,
      minLength: options.minLength,
    });
    const collisionCount = Array.from(collisions.values()).reduce((sum, ops) => sum + ops.length - 1, 0);
    
    logger.warn(`  ${strategy}: ${collisionCount} collision(s) among ${offenders.length} names`);
  }
  
  logger.warn(`\n${'-'.repeat(80)}`);
  logger.warn(`How to Fix:\n`);
  logger.warn(`  1. Choose a shortening strategy based on collision analysis above`);
  logger.warn(`  2. Set environment variables:\n`);
  logger.warn(`     export MCP4_TOOLNAME_STRATEGY=balanced      # or: iterative, hash, auto`);
  logger.warn(`     export MCP4_TOOLNAME_WARN_ONLY=false       # Apply shortening`);
  logger.warn(`     export MCP4_TOOLNAME_MAX=45                # Optional: adjust limit`);
  logger.warn(`     export MCP4_TOOLNAME_MIN_PARTS=3           # Optional: min parts (for balanced)`);
  logger.warn(`     export MCP4_TOOLNAME_MIN_LENGTH=20         # Optional: min length (for balanced)\n`);
  logger.warn(`  Example for balanced strategy:`);
  logger.warn(`     export MCP4_TOOLNAME_STRATEGY=balanced MCP4_TOOLNAME_WARN_ONLY=false\n`);
  logger.warn(`${'-'.repeat(80)}`);
  logger.warn(`Summary: ${offenders.length} names need shortening. Choose strategy and restart.\n`);
}
