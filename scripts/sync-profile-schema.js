#!/usr/bin/env node

import { writeSyncedProfileSchemaFile } from './profile-schema-sync-utils.js';

async function main() {
  try {
    await writeSyncedProfileSchemaFile();
    console.log('✅ profile-schema.json synchronized from src/types/profile.ts');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Failed to synchronize profile-schema.json: ${message}`);
    process.exit(1);
  }
}

main();
