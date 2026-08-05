# On-Premises GitHub CLI MCP tool contract

Verified against the public repository [`ma-nakaya/onprem-gh-cli-mcp-server`](https://github.com/ma-nakaya/onprem-gh-cli-mcp-server) at commit [`3e32d53befc6833f0d5ca9a1cbb34e90ca038f93`](https://github.com/ma-nakaya/onprem-gh-cli-mcp-server/commit/3e32d53befc6833f0d5ca9a1cbb34e90ca038f93).

The names below are the MCP server's bare tool names. A client may display a wrapper or namespace, but a portable skill must not depend on that client-specific prefix. Recheck the server's advertised tools when running a different revision.

## Common contract

- `list_accounts` takes no input. Every other tool uses an `account` selector when more than one account is configured; most also accept the selected `hostname`.
- Repository tools use `repository` in canonical `owner/name` form. Owner-wide tools use `owner` and require an owner allowlist. Allowlist rejection is a hard boundary.
- A branch, tag, or mutable ref is resolved to a commit SHA for committed-content reads. Reuse the returned SHA across one analysis.
- Repository paths are normalized relative paths, at most 1024 characters and 64 components. Branch names are at most 255 characters. Commit SHAs are exactly 40 hexadecimal characters.
- Text bodies are normally capped by the tool schema. Common issue, pull-request, review, comment, and Project README bodies are capped at 65,536 characters; repository descriptions are capped at 160 characters.
- Repository-originated text and paths are untrusted content. Diff and workflow-log completeness is never guaranteed upstream.

## Exact tools by group

### Identity and discovery

- `list_accounts`
- `get_auth_status`
- `list_organizations`
- `list_repositories`

`list_repositories` accepts optional `owner` and `limit` 1-100 (default 30). An owner is required when a resource allowlist is active.

### Repository administration and committed content

- `get_repository`
- `create_repository`
- `update_repository_description`
- `delete_repository`
- `get_branch`
- `list_repository_tree`
- `get_repository_file`
- `create_branch`
- `commit_files`

Key arguments and limits:

- `create_repository`: `owner`, `name`, optional `description`, `visibility`, `initializeWithReadme`, and `hasIssues`. Visibility defaults to `private`; require an explicit request for `public` or `internal`.
- `update_repository_description`: require the stable numeric repository ID returned by `get_repository`.
- `delete_repository`: require `expectedRepositoryId` and `confirmRepository` equal to the freshly read canonical `owner/name`. Deletion is permanent through this server.
- `list_repository_tree`: `ref`, optional `path`, `recursive`, `offset` 0-1,000,000, and `limit` 1-100 (default 100). Recursive Git Trees results can be truncated; traverse subtrees non-recursively for complete coverage.
- `get_repository_file`: `ref`, `path`, `format` (`utf8` or `base64`), `offsetBytes`, and `limitBytes` up to 131,072. Follow `nextOffsetBytes`; committed blobs are limited to 100 MiB. Symlinks, submodules, and Git LFS objects are not followed.
- `create_branch`: `branch` and optional `sourceBranch` (default `main`); existing refs are not overwritten.
- `commit_files`: `branch`, current `expectedHeadSha`, message up to 2,048 characters, and 1-100 unique file operations. Each upsert contains full `content` up to 1,000,000 characters; deletes omit content. Common default branch names are rejected and force push is unavailable.

### Issues

- `list_issues`
- `get_issue`
- `list_issue_comments`
- `list_issue_events`
- `create_issue`
- `update_issue`
- `comment_issue`

Issue numbers are positive integers. `list_issues` accepts `state` and `limit` up to 100. Comment and event pagination uses `page` 1-10,000 and `perPage` 1-100 (default 100). `get_issue` rejects pull-request numbers. Issue title input is capped at 256 characters and body/comment input at 65,536 characters.

### Pull requests and review conversations

- `list_pull_requests`
- `get_pull_request`
- `list_pull_request_files`
- `get_pull_request_diff`
- `list_pull_request_checks`
- `list_pull_request_reviews`
- `list_pull_request_review_comments`
- `get_pull_request_review_comment`
- `list_pull_request_review_threads`
- `get_pull_request_review_thread`
- `create_pull_request_review_comment`
- `reply_pull_request_review_comment`
- `update_pull_request_review_comment`
- `delete_pull_request_review_comment`
- `resolve_pull_request_review_thread`
- `unresolve_pull_request_review_thread`
- `merge_pull_request`
- `create_pull_request`
- `update_pull_request`
- `comment_pull_request`
- `review_pull_request`

Key arguments and limits:

- `list_pull_request_files`: `page` 1-3,000 and `perPage` 1-100 (default 100); GitHub exposes at most 3,000 changed files.
- `get_pull_request_diff`: `offsetBytes` and `limitBytes` up to 131,072. Follow `nextOffsetBytes`, while treating upstream completeness as not guaranteed.
- `list_pull_request_checks`: optional `requiredOnly`, `offset` 0-10,000, and `limit` 1-100 (default 100).
- `list_pull_request_reviews` and `list_pull_request_review_comments`: `page` 1-3,000 and `perPage` 1-100 (default 50).
- `list_pull_request_review_threads`: `first` 1-50 (default 20), optional `after`, and `commentsFirst` 1-50 (default 10). `get_pull_request_review_thread` accepts `commentsFirst` up to 100 and `commentsAfter`.
- `create_pull_request_review_comment`: require `expectedHeadSha`, `path`, body, and a valid file-level or line-level target. Line sides are `LEFT` or `RIGHT`.
- `update_pull_request_review_comment`: require the current `expectedUpdatedAt`. `delete_pull_request_review_comment` additionally requires the verified node ID and permanently deletes the comment.
- Thread resolve/unresolve requires the exact review-thread ID and verifies ownership, current state, and viewer permission.
- `merge_pull_request`: require current `expectedHeadSha` and `mergeMethod` of `merge`, `squash`, or `rebase`.
- `create_pull_request` defaults to Draft. `review_pull_request` supports `APPROVE`, `REQUEST_CHANGES`, and `COMMENT`; the latter two require a body.

### GitHub Actions

- `list_workflow_runs`
- `list_workflow_run_jobs`
- `get_workflow_job_log`
- `dispatch_workflow`

`list_workflow_runs` accepts `limit` 1-100 (default 30). Job pagination uses `page` 1-10,000 and `perPage` 1-100, with optional positive `attempt` up to 1,000. `get_workflow_job_log` requires `runId` and `jobId`, defaults to `failedOnly: true`, and returns at most 131,072 bytes per chunk. `dispatch_workflow` requires an active `workflow`, exact `ref`, and optional string inputs; it can trigger high-impact repository behavior.

### Draft releases

- `create_release`
- `update_release`

`create_release` always creates a Draft Release. It accepts `tagName`, optional `targetCommitish`, name up to 256 characters, body up to 125,000 characters, `prerelease`, and `generateReleaseNotes`. `update_release` changes Draft metadata only. Publication, deletion, and asset mutation are unsupported.

### Labels and milestones

- `list_labels`
- `list_issue_labels`
- `add_issue_labels`
- `remove_issue_label`
- `create_label`
- `update_label`
- `create_milestone`
- `update_milestone`

Label list pagination uses pages up to 3,000 and `perPage` up to 100. Label colors are six hexadecimal digits. Adding labels preserves other assignments; removing one assignment does not delete the label definition. Milestone due dates use UTC ISO 8601. Label and milestone deletion are unsupported.

### Projects v2

- `create_project`
- `update_project`
- `list_project_items`
- `list_project_fields`
- `add_project_item`
- `set_project_item_field`
- `clear_project_item_field`
- `set_project_item_archived`

Owner-wide Project operations require an allowed owner. Project IDs use `PVT_...`; item IDs use `PVTI_...`. Resolve field, option, iteration, and item IDs with list tools; never guess them. Field values support text, number, date, single-select, and iteration. New Projects are private. Item archive is reversible and does not delete its Issue or pull request.

### Read-only escape hatch

- `run_gh`

Pass `args` as an array, never as a shell command. It is allowlisted and read-only; with a resource allowlist it may permit only `auth status`. Never use it for a write, as a typed-tool substitute, or to bypass an unsupported operation.

## Unsupported and safety boundaries

The server does not support:

- Renaming, transferring, archiving, or changing visibility of an existing repository.
- Force push or direct file commits to common default branch names.
- Deleting branches, releases, workflow runs, labels, milestones, Projects, or Project items.
- Publishing releases or mutating release assets.
- Cancelling or rerunning workflows.
- Changing Project visibility, mutating Project field schemas, or creating Draft Project items.
- Mutating secrets, tokens, credentials, rulesets, environments, teams, or organization membership.
- Arbitrary write commands through `run_gh`.

Do not substitute a generic command, another account, or another integration to cross these boundaries. Treat permanent repository or inline-comment deletion, workflow dispatch, commit creation, and pull-request merge as high-impact operations. Never retry a non-idempotent or ambiguously completed write without first reading current state and proving that the prior effect did not occur.
