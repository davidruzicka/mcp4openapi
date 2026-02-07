#!/usr/bin/env node

/**
 * Generate Zod schemas from TypeScript types
 *
 * Single source of truth: src/types/profile.ts
 * Generated:
 * - src/generated-schemas.ts (for runtime validation)
 * - profile-schema.json (for IDE autocomplete and schema validation)
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('🔄 Generating schemas from TypeScript types...');

// Generate Zod schemas
console.log('🔧 Generating Zod schemas...');
const zodOutputPath = 'src/generated-schemas.ts';

try {
  execSync(`npx ts-to-zod src/types/profile.ts ${zodOutputPath} --skipValidation`, {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  console.log(`✅ Zod schemas written to ${zodOutputPath}`);
} catch (error) {
  console.error('❌ Failed to generate Zod schemas:', error.message);
  process.exit(1);
}

// Generate JSON Schema for IDE validation
console.log('🔧 Synchronizing profile-schema.json...');
try {
  execSync('node scripts/sync-profile-schema.js', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
} catch (error) {
  console.error('❌ Failed to synchronize profile-schema.json:', error.message);
  process.exit(1);
}

console.log('🎉 Schema generation completed!');
