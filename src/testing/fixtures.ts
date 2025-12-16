/**
 * Mock response fixtures for GitLab API
 * 
 * Why: Realistic test data based on actual GitLab API responses.
 * Enables integration tests without real API calls.
 */

export const mockBadge = {
  id: 1,
  name: 'Coverage',
  link_url: 'https://example.com/coverage',
  image_url: 'https://shields.io/badge/coverage-95%25-green',
  rendered_link_url: 'https://example.com/coverage',
  rendered_image_url: 'https://shields.io/badge/coverage-95%25-green',
  kind: 'project',
};

export const mockBadgesList = [
  mockBadge,
  {
    id: 2,
    name: 'Pipeline',
    link_url: 'https://gitlab.com/my-org/my-project/pipelines',
    image_url: 'https://gitlab.com/my-org/my-project/badges/main/pipeline.svg',
    rendered_link_url: 'https://gitlab.com/my-org/my-project/pipelines',
    rendered_image_url: 'https://gitlab.com/my-org/my-project/badges/main/pipeline.svg',
    kind: 'project',
  },
];

export const mockBranch = {
  name: 'main',
  commit: {
    id: '2695effb5807a22ff3d138d593fd856244e155e7',
    short_id: '2695effb',
    created_at: '2017-07-26T11:08:53+02:00',
    parent_ids: ['2a4b78934375d7f53875269ffd4f45fd83a84ebe'],
    title: 'Initial commit',
    message: 'Initial commit',
    author_name: 'John Smith',
    author_email: 'john@example.com',
    authored_date: '2012-05-28T04:42:42-07:00',
    committer_name: 'Jack Smith',
    committer_email: 'jack@example.com',
    committed_date: '2012-05-28T04:42:42-07:00',
  },
  merged: false,
  protected: true,
  developers_can_push: false,
  developers_can_merge: true,
  can_push: true,
  default: true,
  web_url: 'https://gitlab.com/my-org/my-project/-/tree/main',
};

export const mockBranchesList = [
  mockBranch,
  {
    name: 'feature/new-feature',
    commit: {
      id: '3695effb5807a22ff3d138d593fd856244e155e8',
      short_id: '3695effb',
      title: 'Add new feature',
      message: 'Add new feature',
      author_name: 'Jane Doe',
      author_email: 'jane@example.com',
    },
    merged: false,
    protected: false,
    default: false,
  },
];

export const mockJob = {
  id: 1234,
  name: 'test:unit',
  status: 'success',
  stage: 'test',
  created_at: '2016-01-11T10:13:33.506Z',
  started_at: '2016-01-11T10:14:33.506Z',
  finished_at: '2016-01-11T10:15:33.506Z',
  commit: {
    id: '2695effb5807a22ff3d138d593fd856244e155e7',
    short_id: '2695effb',
    title: 'Initial commit',
  },
  archived: false,
  allow_failure: false,
  duration: 60,
  queued_duration: 1.5,
  ref: 'main',
  artifacts: [],
  tag: false,
  web_url: 'https://gitlab.com/my-org/my-project/-/jobs/1234',
  project: {
    ci_job_token_scope_enabled: false,
  },
  user: {
    id: 1,
    username: 'admin',
    name: 'Administrator',
    state: 'active',
    avatar_url: 'https://gravatar.com/avatar/1',
    web_url: 'https://gitlab.com/admin',
  },
};

export const mockJobsList = [
  mockJob,
  {
    id: 1235,
    name: 'test:integration',
    status: 'failed',
    stage: 'test',
    created_at: '2016-01-11T10:13:33.506Z',
    started_at: '2016-01-11T10:14:33.506Z',
    finished_at: '2016-01-11T10:16:33.506Z',
    allow_failure: false,
  },
];

export const mockAccessRequest = {
  id: 1,
  username: 'raymond_smith',
  name: 'Raymond Smith',
  state: 'active',
  created_at: '2012-10-22T14:13:35Z',
  requested_at: '2012-10-22T14:13:35Z',
  access_level: 30,
};

export const mockAccessRequestsList = [
  mockAccessRequest,
  {
    id: 2,
    username: 'john_doe',
    name: 'John Doe',
    state: 'active',
    created_at: '2012-10-23T14:13:35Z',
    requested_at: '2012-10-23T14:13:35Z',
  },
];

export const mockMergeRequest = {
  id: 1,
  iid: 1,
  title: 'Implement new feature',
  description: 'This implements the new feature requested by the team.',
  state: 'opened',
  web_url: 'https://gitlab.com/my-org/my-project/-/merge_requests/1',
  author: {
    id: 1,
    name: 'John Smith',
    username: 'john_smith',
  },
  source_branch: 'feature/new-feature',
  target_branch: 'main',
  created_at: '2017-07-26T11:08:53+02:00',
  updated_at: '2017-07-26T11:08:53+02:00',
};

export const mockMergeRequestsList = [
  mockMergeRequest,
  {
    id: 2,
    iid: 2,
    title: 'Fix bug in authentication',
    description: 'Fixes critical authentication bug reported by QA.',
    state: 'merged',
    web_url: 'https://gitlab.com/my-org/my-project/-/merge_requests/2',
    author: {
      id: 2,
      name: 'Jane Doe',
      username: 'jane_doe',
    },
    source_branch: 'bugfix/auth-fix',
    target_branch: 'main',
    created_at: '2017-07-25T10:08:53+02:00',
    updated_at: '2017-07-26T09:08:53+02:00',
  },
];

export const mockMergeRequestChanges = {
  ...mockMergeRequest,
  changes: [
    {
      old_path: 'README.md',
      new_path: 'README.md',
      a_mode: '100644',
      b_mode: '100644',
      diff: '@@ -1,4 +1,4 @@\n-Old README\n+New README\n',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      too_large: false,
      collapsed: false,
    },
    {
      old_path: 'src/index.js',
      new_path: 'src/index.js',
      a_mode: '100644',
      b_mode: '100644',
      diff: '@@ -10,7 +10,7 @@\n-const oldValue = true;\n+const newValue = false;\n',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
      too_large: false,
      collapsed: false,
    },
  ],
};

export const mockMergeRequestVersions = [
  {
    id: 101,
    short_commit_id: 'abc1234',
    created_at: '2024-06-01T10:00:00Z',
    created_by: {
      id: 1,
      name: 'John Smith',
      username: 'john_smith',
    },
    description: 'Initial diff',
    merge_request_id: 1,
    state: 'collected',
    real_size: 'small',
    head_commit_sha: 'abc1234567890',
    base_commit_sha: '0000000000000',
    start_commit_sha: '1111111111111',
    commits_count: 1,
  },
  {
    id: 102,
    short_commit_id: 'def5678',
    created_at: '2024-06-02T12:00:00Z',
    created_by: {
      id: 2,
      name: 'Jane Doe',
      username: 'jane_doe',
    },
    description: 'Follow-up changes',
    merge_request_id: 1,
    state: 'collected',
    real_size: 'medium',
    head_commit_sha: 'def5678123456',
    base_commit_sha: 'abc1234567890',
    start_commit_sha: '1111111111111',
    commits_count: 2,
  },
];

export const mockMergeRequestVersionDetails = {
  id: 101,
  head_commit_sha: 'abc1234567890',
  base_commit_sha: '0000000000000',
  start_commit_sha: '1111111111111',
  state: 'collected',
  real_size: 'small',
  created_at: '2024-06-01T10:00:00Z',
  description: 'Initial diff',
  commits: [
    {
      id: 'abc1234567890',
      short_id: 'abc1234',
      title: 'Initial commit',
      author_name: 'John Smith',
      author_email: 'john.smith@example.com',
      created_at: '2024-06-01T10:00:00Z',
    },
  ],
  diffs: mockMergeRequestChanges.changes,
};

export const mockRepositoryFileContent = "console.log('hello world');\n";

export const mockRepositoryFileBase64 = 'Y29uc29sZS5sb2coJ2hlbGxvIHdvcmxkJyk7Cg==';

export const mockRepositoryFile = {
  file_name: 'index.js',
  file_path: 'src/index.js',
  size: mockRepositoryFileContent.length,
  encoding: 'base64',
  content: mockRepositoryFileBase64,
  ref: 'main',
  blob_id: '123abc',
  commit_id: 'commit123',
  last_commit_id: 'commit123',
};

export const mockDiscussion = {
  id: 'disc-1',
  resolved: false,
  notes: [
    {
      id: 11,
      body: 'Discussion note 1',
      author: mockMergeRequest.author,
      created_at: '2024-06-01T10:00:00Z',
      updated_at: '2024-06-01T10:00:00Z',
      system: false,
      resolved: false,
    },
  ],
};

export const mockApproval = {
  approvals_required: 2,
  approvals_left: 1,
  approved_by: [
    {
      user: mockMergeRequest.author,
    },
  ],
};

export const mockPipeline = {
  id: 501,
  status: 'running',
  ref: 'main',
  sha: 'abc123',
  web_url: 'https://gitlab.com/my-org/my-project/-/pipelines/501',
};

export const mockJobWithArtifacts = {
  ...mockJob,
  artifacts_file: 'data:application/octet-stream;base64,YXJ0aWZhY3QgZGF0YQo=',
};

export const mockArtifactsContent = 'artifact data\n';

export const mockLabels = [
  { id: 1, name: 'bug', color: '#FF0000', description: 'Bugfix' },
  { id: 2, name: 'feature', color: '#00FF00', description: 'Feature' },
];

export const mockMilestones = [
  { id: 1, iid: 1, title: 'M1', state: 'active', description: 'First milestone' },
];

export const mockReleases = [
  { name: 'v1.0', tag_name: 'v1.0', description: 'Initial release', released_at: '2024-06-01T00:00:00Z' },
];

export const mockTags = [
  { name: 'v1.0', message: 'Initial tag', target: 'abc123' },
];

export const mockMembers = [
  { id: 1, username: 'john_smith', name: 'John Smith', access_level: 40 },
  { id: 2, username: 'jane_doe', name: 'Jane Doe', access_level: 30 },
];

export const mockHooks = [
  { id: 1, url: 'https://example.com/hook', push_events: true, issues_events: true, merge_requests_events: false },
];

export const mockSnippets = [
  { id: 1, title: 'Snippet one', file_name: 'snippet1.txt', description: 'Test snippet', visibility: 'private', raw_url: 'data:text/plain;base64,c25pcHBldCBjb250ZW50Cg==' },
];

export const mockSnippetRawContent = 'snippet content\n';

export const mockIssue = {
  id: 1,
  iid: 1,
  project_id: 3,
  title: 'Bug in authentication',
  description: 'There is a bug in the authentication system',
  state: 'opened',
  created_at: '2016-01-11T10:13:33.506Z',
  updated_at: '2016-01-11T10:14:33.506Z',
  closed_at: null,
  closed_by: null,
  labels: ['bug', 'backend'],
  milestone: null,
  assignees: [],
  author: {
    id: 1,
    username: 'john_doe',
    name: 'John Doe',
    avatar_url: 'https://www.gravatar.com/avatar/johndoe',
  },
  web_url: 'https://gitlab.com/my-org/my-project/-/issues/1',
  confidential: false,
  discussion_locked: false,
};

export const mockIssuesList = [
  mockIssue,
  {
    ...mockIssue,
    id: 2,
    iid: 2,
    title: 'Feature request: Dark mode',
    description: 'Add dark mode to the application',
    state: 'opened',
    labels: ['feature', 'frontend'],
    created_at: '2017-07-25T10:08:53+02:00',
    updated_at: '2017-07-26T09:08:53+02:00',
  },
];

export const mockNote = {
  id: 1,
  body: 'This looks good to me!',
  author: {
    id: 1,
    username: 'john_doe',
    name: 'John Doe',
    avatar_url: 'https://www.gravatar.com/avatar/johndoe',
  },
  created_at: '2017-07-26T11:08:53+02:00',
  updated_at: '2017-07-26T11:08:53+02:00',
  system: false,
  noteable_id: 1,
  noteable_type: 'MergeRequest',
  confidential: false,
};

export const mockNotesList = [
  mockNote,
  {
    ...mockNote,
    id: 2,
    body: 'Please see attached log file',
    created_at: '2017-07-27T10:08:53+02:00',
    updated_at: '2017-07-27T10:08:53+02:00',
    attachment: 'https://gitlab.com/api/v4/uploads/attachments/note-2.txt',
    mimeType: 'text/plain',
    size: 27,
  },
];

export const mockGroup = {
  id: 36173,
  web_url: 'https://gitlab.com/groups/davidruzicka',
  name: 'AI Adoption',
  path: 'davidruzicka',
  full_name: 'AI Adoption',
  full_path: 'davidruzicka',
  description: 'Group for AI adoption projects',
  visibility: 'private',
  share_with_group_lock: false,
  require_two_factor_authentication: false,
  two_factor_grace_period: 48,
  project_creation_level: 'developer',
  auto_devops_enabled: null,
  subgroup_creation_level: 'maintainer',
  emails_disabled: false,
  mentions_disabled: false,
  lfs_enabled: true,
  default_branch_protection: 2,
  avatar_url: null,
  request_access_enabled: true,
  parent_id: null,
  created_at: '2020-01-15T10:00:00.000Z',
};

export const mockGroupsList = [
  mockGroup,
  {
    id: 36174,
    web_url: 'https://gitlab.com/groups/devops',
    name: 'DevOps',
    path: 'devops',
    full_name: 'DevOps',
    full_path: 'devops',
    description: 'DevOps tools and automation',
    visibility: 'internal',
    parent_id: null,
    created_at: '2020-02-20T10:00:00.000Z',
  },
];

export const mockSubgroup = {
  id: 36175,
  web_url: 'https://gitlab.com/groups/davidruzicka/llm-projects',
  name: 'LLM Projects',
  path: 'llm-projects',
  full_name: 'AI Adoption / LLM Projects',
  full_path: 'davidruzicka/llm-projects',
  description: 'Large Language Model projects',
  visibility: 'private',
  parent_id: 36173,
  created_at: '2021-03-10T10:00:00.000Z',
};

export const mockSubgroupsList = [
  mockSubgroup,
  {
    id: 36176,
    web_url: 'https://gitlab.com/groups/davidruzicka/cv-projects',
    name: 'CV Projects',
    path: 'cv-projects',
    full_name: 'AI Adoption / CV Projects',
    full_path: 'davidruzicka/cv-projects',
    description: 'Computer Vision projects',
    visibility: 'private',
    parent_id: 36173,
    created_at: '2021-04-15T10:00:00.000Z',
  },
];

export const mockProject = {
  id: 12345,
  name: 'mcp4openapi',
  path: 'mcp4openapi',
  path_with_namespace: 'davidruzicka/mcp4openapi',
  description: 'MCP server for OpenAPI specifications',
  visibility: 'private',
  web_url: 'https://gitlab.com/davidruzicka/mcp4openapi',
  created_at: '2023-06-01T10:00:00.000Z',
  last_activity_at: '2024-11-28T15:30:00.000Z',
  star_count: 42,
  forks_count: 5,
  avatar_url: null,
  namespace: {
    id: 36173,
    name: 'AI Adoption',
    path: 'davidruzicka',
    kind: 'group',
    full_path: 'davidruzicka',
  },
  default_branch: 'main',
  archived: false,
  empty_repo: false,
  ssh_url_to_repo: 'git@gitlab.com:davidruzicka/mcp4openapi.git',
  http_url_to_repo: 'https://gitlab.com/davidruzicka/mcp4openapi.git',
};

export const mockProjectsList = [
  mockProject,
  {
    id: 12346,
    name: 'openapi-generator',
    path: 'openapi-generator',
    path_with_namespace: 'davidruzicka/openapi-generator',
    description: 'OpenAPI schema generator',
    visibility: 'internal',
    web_url: 'https://gitlab.com/davidruzicka/openapi-generator',
    created_at: '2023-07-15T10:00:00.000Z',
    last_activity_at: '2024-11-25T12:00:00.000Z',
    star_count: 18,
    forks_count: 2,
    avatar_url: null,
    namespace: {
      id: 36173,
      name: 'AI Adoption',
      path: 'davidruzicka',
      kind: 'group',
      full_path: 'davidruzicka',
    },
    default_branch: 'main',
    archived: false,
  },
];
