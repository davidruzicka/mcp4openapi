export interface GitHubGraphQlError {
  readonly message: string;
}

export interface GitHubGraphQlErrorResponse {
  readonly errors?: readonly GitHubGraphQlError[];
}

export interface GitHubGraphQlAuthorNode {
  readonly login?: string;
}

export interface GitHubGraphQlReviewCommentNode {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly author?: GitHubGraphQlAuthorNode;
}

export interface GitHubGraphQlReviewCommentConnection {
  readonly nodes?: readonly GitHubGraphQlReviewCommentNode[];
}

export interface GitHubGraphQlReviewThreadNode {
  readonly id: string;
  readonly isResolved: boolean;
  readonly comments?: GitHubGraphQlReviewCommentConnection;
}

export interface GitHubGraphQlReviewThreadConnection {
  readonly nodes?: readonly GitHubGraphQlReviewThreadNode[];
}

export interface GitHubGraphQlPullRequestNode {
  readonly id?: string;
  readonly reviewThreads?: GitHubGraphQlReviewThreadConnection;
}

export interface GitHubGraphQlRepositoryNode {
  readonly pullRequest?: GitHubGraphQlPullRequestNode;
}

export interface GitHubGraphQlReviewThreadsResponse extends GitHubGraphQlErrorResponse {
  readonly data?: {
    readonly repository?: GitHubGraphQlRepositoryNode;
  };
}

export interface GitHubGraphQlPullRequestIdResponse extends GitHubGraphQlErrorResponse {
  readonly data?: {
    readonly repository?: GitHubGraphQlRepositoryNode;
  };
}