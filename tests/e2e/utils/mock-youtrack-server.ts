import { createServer as createMswServer } from '@mswjs/http-middleware';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createYoutrackHandlers, type RequestLogEntry } from '../../../src/testing/mock-youtrack-server.js';

export interface YoutrackMockServerInstance {
  server: Server;
  port: number;
  youtrackApiUrl: string;
  requests: RequestLogEntry[];
  stop: () => Promise<void>;
}

export interface YoutrackMockConfig {
  port?: number;
  apiBasePath?: string;
}

export async function startStandaloneYoutrackMockServer(
  config: YoutrackMockConfig = {}
): Promise<YoutrackMockServerInstance> {
  const { port = 0, apiBasePath = '/api' } = config;
  const tempBaseUrl = `http://localhost${apiBasePath}`;
  const requests: RequestLogEntry[] = [];
  const handlers = createYoutrackHandlers(tempBaseUrl, requests);
  const httpServer = createMswServer(...handlers);

  return new Promise((resolve, reject) => {
    const server = httpServer.listen(port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const actualPort = address.port;
      const baseUrl = `http://127.0.0.1:${actualPort}${apiBasePath}`;
      const finalHandlers = createYoutrackHandlers(baseUrl, requests);

      server.close(() => {
        const finalServer = createMswServer(...finalHandlers);
        const newServer = finalServer.listen(actualPort, '127.0.0.1', () => {
          resolve({
            server: newServer,
            port: actualPort,
            youtrackApiUrl: baseUrl,
            requests,
            stop: () =>
              new Promise<void>((res, rej) => {
                newServer.close((err) => {
                  if (err) rej(err);
                  else res();
                });
              }),
          });
        });

        newServer.on('error', reject);
      });
    });

    server.on('error', reject);
  });
}

export { getAvailablePort } from './mock-server.js';
