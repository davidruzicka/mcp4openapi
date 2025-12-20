import { http, HttpResponse, delay, RequestHandler } from 'msw';
import { setupServer, SetupServerApi } from 'msw/node';
import { OpenAPIParser } from '../openapi-parser.js';
import { MockDefinition } from './test-schema.js';

export class DynamicMockEngine {
  private parser: OpenAPIParser;
  private server: SetupServerApi;
  private baseUrl: string;

  constructor(parser: OpenAPIParser, baseUrl: string) {
    this.parser = parser;
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Ensure no trailing slash
    this.server = setupServer();
  }

  start() {
    // We warn on unhandled requests to help debug missing mocks
    this.server.listen({ onUnhandledRequest: 'warn' });
  }

  stop() {
    this.server.close();
  }

  reset() {
    this.server.resetHandlers();
  }

  configureMocks(mocks: MockDefinition[]) {
    const handlers: RequestHandler[] = [];

    for (const mock of mocks) {
      let method: string | undefined;
      let fullUrl: string | undefined;

      if (mock.operationId) {
        const opInfo = this.parser.getOperation(mock.operationId);
        if (!opInfo) {
          console.warn(`Warning: Operation ID '${mock.operationId}' not found in OpenAPI spec. Skipping mock.`);
          continue;
        }
        method = opInfo.method.toLowerCase();
        // Convert OpenAPI path parameters {param} to MSW format :param
        const mswPath = opInfo.path.replace(/{([^}]+)}/g, ':$1');
        fullUrl = `${this.baseUrl}${mswPath}`;
      } else if (mock.path && mock.method) {
        method = mock.method.toLowerCase();
        if (mock.path.startsWith('http://') || mock.path.startsWith('https://')) {
          fullUrl = mock.path;
        } else {
          // If relative path, prepend base URL
          // Ensure strictly one slash
          const safePath = mock.path.startsWith('/') ? mock.path : `/${mock.path}`;
          fullUrl = `${this.baseUrl}${safePath}`;
        }
      }

      if (!method || !fullUrl) {
        continue;
      }

      // Only support standard HTTP methods that MSW supports
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        console.warn(`Warning: Unsupported HTTP method '${method}'.`);
        continue;
      }

      // MSW http methods are typed as http.get, http.post, etc.
      // We cast to any to access dynamic method name
      const handlerGenerator = (http as any)[method];

      const handler = handlerGenerator(fullUrl, async () => {
        if (mock.response?.delay) {
          await delay(mock.response.delay);
        }

        const body = mock.response?.body;
        const headers = mock.response?.headers || {};
        const status = mock.response?.status ?? 200;

        // If body is an object or array, treat as JSON
        if (body !== undefined && typeof body === 'object') {
           return HttpResponse.json(body, { status, headers });
        }

        // Otherwise treat as raw response (string, null, etc.)
        if (body === undefined) {
             // 204 No Content must have empty body
             if (status === 204) {
                 return new HttpResponse(null, { status, headers });
             }
             return HttpResponse.json({}, { status, headers });
        }

        return new HttpResponse(body, { status, headers });
      });

      handlers.push(handler);
    }

    this.server.use(...handlers);
  }
}
