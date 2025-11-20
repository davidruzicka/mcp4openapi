#!/usr/bin/env node

/**
 * CLI entry point
 * 
 * Why: Reads env vars, initializes server, handles errors gracefully.
 */

import 'dotenv/config';
import { MCPServer } from './mcp-server.js';
import { ConsoleLogger, JsonLogger } from './logger.js';

async function main() {
  // Create logger based on env
  const logFormat = process.env.MCP4_LOG_FORMAT || 'console';
  const logger = logFormat === 'json'
    ? new JsonLogger()
    : new ConsoleLogger();

  const specPath = process.env.MCP4_OPENAPI_SPEC_PATH;
  if (!specPath) {
    logger.error('MCP4_OPENAPI_SPEC_PATH environment variable is required');
    process.exit(1);
  }

  const profilePath = process.env.MCP4_PROFILE_PATH;
  const transport = process.env.MCP4_TRANSPORT || 'stdio';
  
  try {
    const server = new MCPServer(logger);
    await server.initialize(specPath, profilePath);

    if (transport === 'http') {
      const host = process.env.MCP4_HOST || '127.0.0.1';
      const port = parseInt(process.env.MCP4_PORT || '3003', 10);

      if (isNaN(port)) {
        throw new Error('Invalid MCP4_PORT');
      }

      await server.runHttp(host, port);
    } else {
      await server.runStdio();
    }

    // Graceful shutdown handlers
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully...`);
      try {
        await server.stop();
        logger.info('Server stopped successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error as Error);
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Fatal error', error as Error);
    process.exit(1);
  }
}

main();

