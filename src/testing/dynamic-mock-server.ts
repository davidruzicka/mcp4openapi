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
      const opInfo = this.parser.getOperation(mock.operationId);
      if (!opInfo) {
        console.warn(`Warning: Operation ID '${mock.operationId}' not found in OpenAPI spec. Skipping mock.`);
        continue;
      }

      const method = opInfo.method.toLowerCase();
      // Only support standard HTTP methods that MSW supports
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) {
        console.warn(`Warning: Unsupported HTTP method '${opInfo.method}'.`);
        continue;
      }

      // Convert OpenAPI path parameters {param} to MSW format :param
      const mswPath = opInfo.path.replace(/{([^}]+)}/g, ':$1');
      const fullUrl = `${this.baseUrl}${mswPath}`;

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
        // Note: HttpResponse.json(null) is valid, but new HttpResponse(null) is also valid (empty body)
        // If body is undefined/null, use {} for JSON compatibility if content-type says so?
        // Defaulting to JSON {} if body is missing was previous behavior.
        if (body === undefined) {
             return HttpResponse.json({}, { status, headers });
        }

        return new HttpResponse(body, { status, headers });
      });

      handlers.push(handler);
    }

    this.server.use(...handlers);
  }
}
