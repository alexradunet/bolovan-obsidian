# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`, including labels and comments.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from the configured GitHub remote. Pull requests are not a triage request surface.

## Skill operations

- When a skill says to publish to the issue tracker, create a GitHub issue.
- When a skill says to fetch a ticket, read the complete issue and its comments.
- Create dependent issues after their blockers so bodies can reference real issue numbers.
- Apply the configured `ready-for-agent` label to agent-grabbable tickets.

## Blocking edges

Use GitHub's native issue dependencies when available. Add a blocking edge with:

```text
gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>
```

The blocker database id comes from:

```text
gh api repos/<owner>/<repo>/issues/<number> --jq .id
```

If native dependencies are unavailable, add a `Blocked by: #<number>` line to the dependent issue body. A ticket is unblocked when every referenced blocker is closed.
