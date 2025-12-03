/**
 * Mock Semgrep API server for integration testing
 * 
 * Why: Enables end-to-end testing without real Semgrep instance.
 * Tests actual HTTP flow, parameter handling, error scenarios.
 */

import { http, HttpResponse, RequestHandler } from 'msw';
import { setupServer, SetupServerApi } from 'msw/node';

/** Default BASE_URL for Semgrep API (used by MSW interceptor) */
export const DEFAULT_BASE_URL = 'https://semgrep.dev';

/**
 * Mock Semgrep server configuration
 */
export interface SemgrepServerConfig {
  /** API base URL */
  baseUrl?: string;
  /** Valid API token for auth */
  validToken?: string;
  /** Deployment slug for testing */
  deploymentSlug?: string;
  /** Deployment ID for testing */
  deploymentId?: number;
}

const DEFAULT_CONFIG: Required<SemgrepServerConfig> = {
  baseUrl: DEFAULT_BASE_URL,
  validToken: 'mock-semgrep-token-12345',
  deploymentSlug: 'test-deployment',
  deploymentId: 123,
};

/**
 * Create Semgrep API handlers
 */
export function createSemgrepHandlers(
  config: SemgrepServerConfig = {}
): RequestHandler[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return [
    // GET /api/v1/deployments - List deployments
    http.get(`${cfg.baseUrl}/api/v1/deployments`, ({ request }) => {
      const authHeader = request.headers.get('Authorization');
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return HttpResponse.json(
          { error: 'Unauthorized' },
          { status: 401 }
        );
      }

      const token = authHeader.replace('Bearer ', '');
      if (token !== cfg.validToken) {
        return HttpResponse.json(
          { error: 'Invalid token' },
          { status: 401 }
        );
      }

      return HttpResponse.json({
        deployments: [
          {
            id: cfg.deploymentId,
            slug: cfg.deploymentSlug,
            name: 'Test Deployment',
            findings: {
              url: `${cfg.baseUrl}/api/v1/deployments/${cfg.deploymentSlug}/findings`,
            },
          },
        ],
      });
    }),

    // POST /api/v1/deployments/{deploymentSlug}/triage - Bulk triage
    http.post(
      `${cfg.baseUrl}/api/v1/deployments/:deploymentSlug/triage`,
      async ({ request, params }) => {
        const authHeader = request.headers.get('Authorization');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return HttpResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          );
        }

        const token = authHeader.replace('Bearer ', '');
        if (token !== cfg.validToken) {
          return HttpResponse.json(
            { error: 'Invalid token' },
            { status: 401 }
          );
        }

        const { deploymentSlug } = params;
        if (deploymentSlug !== cfg.deploymentSlug) {
          return HttpResponse.json(
            { error: 'Deployment not found' },
            { status: 404 }
          );
        }

        let body: any;
        try {
          body = await request.json();
        } catch (e) {
          return HttpResponse.json(
            { error: 'Invalid JSON body' },
            { status: 400 }
          );
        }

        // Log the received request for debugging
        console.log('[Mock Semgrep] Received triage request:', {
          url: request.url,
          params,
          body,
          headers: {
            'Content-Type': request.headers.get('Content-Type'),
            'Authorization': authHeader ? '***' : undefined,
          },
        });

        // Validate required fields according to OpenAPI spec
        if (!body.issue_type) {
          return HttpResponse.json(
            { 
              error: 'Validation error',
              details: 'issue_type is required',
            },
            { status: 400 }
          );
        }

        if (!['sast', 'sca', 'secrets'].includes(body.issue_type)) {
          return HttpResponse.json(
            { 
              error: 'Validation error',
              details: 'issue_type must be one of: sast, sca, secrets',
            },
            { status: 400 }
          );
        }

        // Check deploymentSlug in body (as per OpenAPI spec)
        if (!body.deploymentSlug) {
          return HttpResponse.json(
            { 
              error: 'Validation error',
              details: 'deploymentSlug is required in request body',
            },
            { status: 400 }
          );
        }

        if (body.deploymentSlug !== cfg.deploymentSlug) {
          return HttpResponse.json(
            { 
              error: 'Validation error',
              details: 'deploymentSlug in body does not match URL parameter',
            },
            { status: 400 }
          );
        }

        // Validate limit is integer if provided
        if (body.limit !== undefined) {
          if (!Number.isInteger(body.limit)) {
            return HttpResponse.json(
              { 
                error: 'Validation error',
                details: 'limit must be an integer',
              },
              { status: 400 }
            );
          }
          if (body.limit < 1 || body.limit > 3000) {
            return HttpResponse.json(
              { 
                error: 'Validation error',
                details: 'limit must be between 1 and 3000',
              },
              { status: 400 }
            );
          }
        }

        // Validate triage state and reason
        if (body.new_triage_state) {
          const validStates = ['ignored', 'reviewing', 'fixing', 'reopened'];
          if (!validStates.includes(body.new_triage_state)) {
            return HttpResponse.json(
              { 
                error: 'Validation error',
                details: `new_triage_state must be one of: ${validStates.join(', ')}`,
              },
              { status: 400 }
            );
          }

          if (body.new_triage_state === 'ignored' && body.new_triage_reason) {
            const validReasons = ['acceptable_risk', 'false_positive', 'no_time', 'no_triage_reason'];
            if (!validReasons.includes(body.new_triage_reason)) {
              return HttpResponse.json(
                { 
                  error: 'Validation error',
                  details: `new_triage_reason must be one of: ${validReasons.join(', ')}`,
                },
                { status: 400 }
              );
            }
          }
        }

        // Mock successful response
        return HttpResponse.json({
          num_triaged: 3,
          triaged_issues: [123, 456, 789],
        });
      }
    ),

    // GET /api/v1/deployments/{deploymentSlug}/projects - List projects
    http.get(
      `${cfg.baseUrl}/api/v1/deployments/:deploymentSlug/projects`,
      ({ request, params }) => {
        const authHeader = request.headers.get('Authorization');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return HttpResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          );
        }

        const { deploymentSlug } = params;
        if (deploymentSlug !== cfg.deploymentSlug) {
          return HttpResponse.json(
            { error: 'Deployment not found' },
            { status: 404 }
          );
        }

        // Mock projects response
        return HttpResponse.json({
          projects: [
            {
              id: 1,
              name: 'test-org/test-repo',
              url: 'https://github.com/test-org/test-repo',
              default_branch: 'refs/heads/main',
              tags: ['test'],
              latest_scan_at: '2025-12-03T00:00:00Z',
            },
          ],
        });
      }
    ),

    // GET /api/v1/deployments/{deploymentSlug}/findings - List findings
    http.get(
      `${cfg.baseUrl}/api/v1/deployments/:deploymentSlug/findings`,
      ({ request, params }) => {
        const authHeader = request.headers.get('Authorization');
        
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return HttpResponse.json(
            { error: 'Unauthorized' },
            { status: 401 }
          );
        }

        const { deploymentSlug } = params;
        if (deploymentSlug !== cfg.deploymentSlug) {
          return HttpResponse.json(
            { error: 'Deployment not found' },
            { status: 404 }
          );
        }

        const url = new URL(request.url);
        const issueType = url.searchParams.get('issue_type') || 'sast';
        const status = url.searchParams.get('status');

        // Mock findings response
        return HttpResponse.json({
          sastFindings: {
            findings: [
              {
                id: 123,
                severity: 'high',
                status: status || 'open',
                rule: {
                  name: 'test.rule.1',
                  confidence: 'high',
                },
                repository: {
                  name: 'test/repo',
                },
                location: {
                  filePath: 'src/test.ts',
                  line: 10,
                },
              },
            ],
          },
        });
      }
    ),
  ];
}

/**
 * Create and start mock Semgrep server
 */
export function createMockSemgrepServer(
  config: SemgrepServerConfig = {}
): SetupServerApi {
  const handlers = createSemgrepHandlers(config);
  return setupServer(...handlers);
}
