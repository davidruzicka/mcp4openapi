/**
 * Type definitions for test data
 * 
 * Why: Avoid 'as any' casts in tests, improve type safety
 */

export interface Badge {
  id: number;
  name: string;
  link_url: string;
  image_url: string;
  rendered_link_url?: string;
  rendered_image_url?: string;
}

export interface Branch {
  name: string;
  default: boolean;
  protected: boolean;
  can_push?: boolean;
  developers_can_push?: boolean;
  developers_can_merge?: boolean;
}

export interface AccessRequest {
  id: number;
  username: string;
  name: string;
  state: string;
  created_at: string;
  requested_at: string;
  access_level?: number;
}

export interface Job {
  id: number;
  status: string;
  stage: string;
  name: string;
  ref: string;
  created_at: string;
  started_at?: string;
  finished_at?: string;
  duration?: number;
  user?: {
    id: number;
    name: string;
    username: string;
  };
}

export interface MergeRequest {
  id: number;
  iid: number;
  title: string;
  description?: string;
  state: string;
  web_url: string;
  author: {
    id: number;
    name: string;
    username: string;
  };
  source_branch: string;
  target_branch: string;
  created_at: string;
  updated_at: string;
}

export interface MergeRequestChange {
  old_path: string;
  new_path: string;
  a_mode?: string;
  b_mode?: string;
  diff: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}

export interface MergeRequestChangesResponse extends MergeRequest {
  changes: MergeRequestChange[];
}

export interface MergeRequestVersion {
  id: number;
  short_commit_id: string;
  created_at: string;
  created_by?: {
    id: number;
    name: string;
    username: string;
  };
  description?: string;
  merge_request_id: number;
  state: string;
  real_size?: string;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  commits_count?: number;
}

export interface MergeRequestVersionDetails {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  state: string;
  real_size?: string;
  created_at: string;
  description?: string;
  commits: Array<{
    id: string;
    short_id: string;
    title: string;
    author_name: string;
    author_email: string;
    created_at: string;
  }>;
  diffs: MergeRequestChange[];
}

export interface ProxyDownloadResult {
  metadata: Record<string, unknown>;
  content: string;
  mimeType: string;
  size: number;
  fileName?: string;
}

export interface Discussion {
  id: string;
  notes: Array<Record<string, unknown>>;
  resolved: boolean;
}

export interface Approval {
  approvals_required: number;
  approvals_left: number;
  approved_by: Array<{ user: { id: number; username: string; name: string } }>;
}

export interface Pipeline {
  id: number;
  status: string;
  ref: string;
  sha: string;
  web_url: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description?: string;
}

export interface Milestone {
  id: number;
  iid: number;
  title: string;
  state: string;
  description?: string;
}

export interface Release {
  name: string;
  tag_name: string;
  description?: string;
  released_at?: string;
}

export interface Tag {
  name: string;
  message?: string;
  target?: string;
}

export interface Member {
  id: number;
  username: string;
  name: string;
  access_level: number;
}

export interface Hook {
  id: number;
  url: string;
  push_events?: boolean;
  issues_events?: boolean;
  merge_requests_events?: boolean;
}

export interface RepositoryFile {
  file_name: string;
  file_path: string;
  size: number;
  encoding: string;
  content: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
}

export interface Issue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: string;
  created_at: string;
  updated_at: string;
  closed_at: null;
  closed_by: null;
  labels: string[];
  milestone: null;
  assignees: any[];
  author: {
    id: number;
    username: string;
    name: string;
    avatar_url: string;
  };
  web_url: string;
  confidential: boolean;
  discussion_locked: boolean;
}

export interface CompositeResult {
  data: Record<string, unknown>;
  completed_steps: number;
  total_steps: number;
  errors?: Array<{ step_index: number; step_call: string; error: string }>;
}

export type McpToolResult =
  | Badge[]
  | Badge
  | Branch[]
  | Branch
  | AccessRequest[]
  | AccessRequest
  | Job[]
  | Job
  | MergeRequest[]
  | MergeRequest
  | MergeRequestChangesResponse
  | MergeRequestChange[]
  | MergeRequestVersion[]
  | MergeRequestVersion
  | MergeRequestVersionDetails
  | RepositoryFile
  | ProxyDownloadResult
  | Discussion[]
  | Discussion
  | Approval
  | Pipeline
  | Label[]
  | Label
  | Milestone[]
  | Milestone
  | Release[]
  | Release
  | Tag[]
  | Tag
  | Member[]
  | Member
  | Hook[]
  | Hook
  | CompositeResult
  | { status: string };
