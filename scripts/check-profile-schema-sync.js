#!/usr/bin/env node

import { buildSyncedProfileSchema, readProfileSchemaFile, stableStringify } from './profile-schema-sync-utils.js';

async function main() {
  try {
    const current = await readProfileSchemaFile();
    const synced = await buildSyncedProfileSchema();

    if (stableStringify(current) !== stableStringify(synced)) {
      console.error('❌ profile-schema.json is out of sync with src/types/profile.ts');
      console.error('Run: npm run sync-profile-schema');
      process.exit(1);
    }

    console.log('✅ profile-schema.json is synchronized');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to check profile schema synchronization: ${message}`);
    process.exit(1);
  }
}

main();
