import { http, HttpResponse, RequestHandler } from 'msw';
import { setupServer } from 'msw/node';

const DEFAULT_BASE_URL = 'http://localhost/api';

export interface RequestLogEntry {
  method: string;
  url: string;
  query: Record<string, string | string[]>;
}

const baseIssue = {
  id: 'YT-123',
  idReadable: 'YT-123',
  summary: 'Mock issue summary',
  description: 'Mock issue description',
  resolved: false,
};

const baseArticle = {
  id: 'article-1',
  title: 'Mock article',
  summary: 'Mock summary',
  content: 'Mock content',
};

const baseTag = { id: 'tag-1', name: 'Bug', color: '#ff0000' };
const baseUser = { id: 'user-1', login: 'mock-user', fullName: 'Mock User', email: 'user@example.com' };
const baseProject = { id: 'PROJ', shortName: 'PROJ', name: 'Mock Project', description: 'Mock project description' };
const baseProjectCustomField = {
  id: 'pcf-1',
  $type: 'ProjectCustomField',
  canBeEmpty: true,
  emptyFieldText: '',
  ordinal: 1,
  isPublic: true,
  field: { id: 'cf-1', name: 'Priority', fieldType: { id: 'ft-1', $type: 'FieldType' } },
};

function queryToRecord(searchParams: URLSearchParams): Record<string, string | string[]> {
  const entries: Record<string, string | string[]> = {};
  for (const [key, value] of searchParams.entries()) {
    if (entries[key]) {
      const existing = entries[key];
      entries[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      entries[key] = value;
    }
  }
  return entries;
}

function createEchoResponse(
  request: Request,
  payload: unknown = {},
  requestLog?: RequestLogEntry[]
): Record<string, unknown> {
  const url = new URL(request.url);
  const query = queryToRecord(url.searchParams);
  if (requestLog) {
    requestLog.push({
      method: request.method,
      url: url.toString(),
      query,
    });
  }
  return {
    path: url.pathname,
    query,
    method: request.method,
    data: payload,
  };
}

export function createYoutrackHandlers(
  baseUrl: string = DEFAULT_BASE_URL,
  requestLog?: RequestLogEntry[]
): RequestHandler[] {
  const withBase = (path: string | RegExp) =>
    typeof path === 'string' ? `${baseUrl}${path}` : new RegExp(`${baseUrl}${path.source}`);

  const issueAttachment = {
    id: 'att-1',
    name: 'issue.txt',
    mimeType: 'text/plain',
    size: 12,
  };

  const articleAttachment = {
    id: 'aat-1',
    name: 'article.txt',
    mimeType: 'text/plain',
    size: 18,
  };

  const handlers: RequestHandler[] = [
    // Content retrieval
    http.get(withBase('/issues'), ({ request }) => HttpResponse.json([createEchoResponse(request, baseIssue, requestLog)])),
    http.get(withBase('/issues/:id'), ({ request, params }) =>
      HttpResponse.json({ ...createEchoResponse(request, { ...baseIssue, id: params.id }, requestLog), comments: [], attachments: [] })
    ),
    http.get(withBase('/issues/:id/comments'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, { id: 'c-1', text: 'mock comment', attachments: [] }, requestLog)])
    ),
    http.get(withBase('/issues/:id/comments/:commentId'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { id: params.commentId, text: 'comment detail', attachments: [] }, requestLog))
    ),
    http.get(withBase('/issues/:id/attachments'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, issueAttachment, requestLog)])
    ),
    http.get(withBase('/issues/:id/attachments/:attachmentId'), ({ request, params }) =>
      HttpResponse.json({
        ...createEchoResponse(request, { ...issueAttachment, id: params.attachmentId }, requestLog),
        url: `${baseUrl}/downloads/issues/${params.id}/${params.attachmentId}`,
      })
    ),
    http.get(withBase('/issues/:id/tags'), ({ request }) => HttpResponse.json([createEchoResponse(request, baseTag, requestLog)])),
    http.get(withBase('/issues/:id/links'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, { id: 'link-1', direction: 'OUTWARD' }, requestLog)])
    ),
    http.get(withBase('/issues/:id/links/:linkId'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { id: params.linkId, direction: 'OUTWARD' }, requestLog))
    ),
    http.get(withBase('/issues/:id/links/:linkId/issues'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, baseIssue, requestLog)])
    ),
    http.get(withBase('/workItems'), ({ request }) => HttpResponse.json([createEchoResponse(request, { id: 'work-1' }, requestLog)])),
    http.get(withBase('/articles'), ({ request }) => HttpResponse.json([createEchoResponse(request, baseArticle, requestLog)])),
    http.get(withBase('/articles/:id'), ({ request, params }) =>
      HttpResponse.json({ ...createEchoResponse(request, { ...baseArticle, id: params.id }, requestLog), comments: [], attachments: [] })
    ),
    http.get(withBase('/articles/:id/comments'), ({ request, params }) =>
      HttpResponse.json([createEchoResponse(request, { id: `ac-${params.id}`, text: 'article comment' }, requestLog)])
    ),
    http.get(withBase('/articles/:id/attachments'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, articleAttachment, requestLog)])
    ),
    http.get(withBase('/articles/:id/attachments/:attachmentId'), ({ request, params }) =>
      HttpResponse.json({
        ...createEchoResponse(request, { ...articleAttachment, id: params.attachmentId }, requestLog),
        url: `data:text/plain;base64,${Buffer.from('article attachment content').toString('base64')}`,
      })
    ),
    http.get(withBase('/tags'), ({ request }) => HttpResponse.json([createEchoResponse(request, baseTag, requestLog)])),
    http.get(withBase('/tags/:id'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { ...baseTag, id: params.id }, requestLog))
    ),
    http.get(withBase('/admin/projects'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, baseProject, requestLog)])
    ),
    http.get(withBase('/admin/projects/:id'), ({ request, params }) =>
      HttpResponse.json({ ...createEchoResponse(request, { ...baseProject, id: params.id }, requestLog), customFields: [baseProjectCustomField] })
    ),
    http.get(withBase('/admin/projects/:id/customFields'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, baseProjectCustomField, requestLog)])
    ),
    http.get(withBase('/admin/projects/:id/customFields/:projectCustomFieldId'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { ...baseProjectCustomField, id: params.projectCustomFieldId }, requestLog))
    ),
    http.get(withBase('/savedQueries'), ({ request }) => HttpResponse.json([createEchoResponse(request, { id: 'q-1' }, requestLog)])),
    http.get(withBase('/agiles'), ({ request }) => HttpResponse.json([createEchoResponse(request, { id: 'agile-1' }, requestLog)])),
    http.get(withBase('/agiles/:id'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { id: params.id, name: 'Agile Board' }, requestLog))
    ),
    http.get(withBase('/agiles/:id/sprints'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, { id: 'sprint-1', name: 'Sprint' }, requestLog)])
    ),
    http.get(withBase('/users'), ({ request }) => HttpResponse.json([createEchoResponse(request, baseUser, requestLog)])),
    http.get(withBase('/users/:id'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { ...baseUser, id: params.id }, requestLog))
    ),
    http.get(withBase('/groups'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, { id: 'group-1', name: 'Mock Group' }, requestLog)])
    ),

    // Activity/history endpoints
    http.get(withBase('/activities'), ({ request }) => HttpResponse.json([createEchoResponse(request, { id: 'act-1' }, requestLog)])),
    http.get(withBase('/activities/:id'), ({ request, params }) =>
      HttpResponse.json(createEchoResponse(request, { id: params.id, category: 'update' }, requestLog))
    ),
    http.get(withBase('/activitiesPage'), ({ request }) => HttpResponse.json([createEchoResponse(request, { id: 'page-1' }, requestLog)])),
    http.get(withBase('/issues/:id/activities'), ({ request }) =>
      HttpResponse.json([createEchoResponse(request, { id: 'act-issue-1' }, requestLog)])
    ),

    // Mutations
    http.post(new RegExp(`${baseUrl}/.*`), async ({ request }) => {
      const body = await request.json().catch(() => ({}));
      return HttpResponse.json(createEchoResponse(request, body, requestLog), { status: 201 });
    }),
    http.put(new RegExp(`${baseUrl}/.*`), async ({ request }) => {
      const body = await request.json().catch(() => ({}));
      return HttpResponse.json(createEchoResponse(request, body, requestLog));
    }),
    http.patch(new RegExp(`${baseUrl}/.*`), async ({ request }) => {
      const body = await request.json().catch(() => ({}));
      return HttpResponse.json(createEchoResponse(request, body, requestLog));
    }),
    http.delete(new RegExp(`${baseUrl}/.*`), ({ request }) => HttpResponse.json(createEchoResponse(request, {}, requestLog))),

    // Download endpoints (for proxy_download operations)
    http.get(withBase('/downloads/issues/:id/:attachmentId'), () =>
      HttpResponse.text('issue attachment content', {
        headers: {
          'content-type': 'text/plain',
          'content-length': '24',
        },
      })
    ),
    http.get(withBase('/downloads/articles/:id/:attachmentId'), () =>
      HttpResponse.text('article attachment content', {
        headers: {
          'content-type': 'text/plain',
          'content-length': '27',
        },
      })
    ),
  ];

  // Generic GET fallback to avoid 404s for any missing endpoint
  handlers.push(
    http.get(new RegExp(`${baseUrl}/.*`), ({ request }) => HttpResponse.json(createEchoResponse(request, {}, requestLog)))
  );

  return handlers;
}

export function createYoutrackMockServer(baseUrl: string = DEFAULT_BASE_URL, requestLog?: RequestLogEntry[]) {
  const handlers = createYoutrackHandlers(baseUrl, requestLog);
  return setupServer(...handlers);
}

export { DEFAULT_BASE_URL as YOU_TRACK_DEFAULT_BASE_URL };
