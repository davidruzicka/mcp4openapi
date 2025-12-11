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
  | CompositeResult
  | { status: string };

