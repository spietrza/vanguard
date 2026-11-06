# PR notes: comment author trust

Autonomous revision, manifest, readiness and research decisions now reject unauthorised comment authors. GitHub associations OWNER/MEMBER/COLLABORATOR, explicit allowlists and (for issue specifications) the issue author establish trust. Bot comments supply specifications and iteration markers but are excluded from actionable revision feedback.

The shared bot matcher uses an exact `vanguard` login rather than a substring: an outsider can choose a username such as `mallory-vanguard`. Custom bot logins can be supplied explicitly. Research iteration markers are gated on trust rather than on a bot login, so the white-label/PAT configuration (findings posted under a human-looking name) still advances the iteration counter.

GitHub issue comments retain the existing `gh issue view --json comments` source: GitHub CLI's [Comment definition](https://github.com/cli/cli/blob/trunk/api/queries_comments.go) includes `authorAssociation`, and a live `gh issue view --json comments` returns it (checked 2026-10-23). GitHub models an association on every comment, so `toTask` maps a missing one to `''`, which fails closed; it also warns when an issue has comments and none carries an association, since a future `gh` that drops the field would turn every non-bot comment untrusted.

## Providers that model no association

GitLab notes carry no association at all. The fetcher stamps notes written by the user glab runs as (GET /user, Vanguard's own spec, research and manifest notes) MEMBER; every other note keeps an *absent* association. With no identity signal configured, an absent association classifies as `no-association` and stays trusted, so GitLab keeps its pre-gate behaviour. Once `--feedback-authors` (or a bot login) is set, an unlisted author with no association fails closed: the allowlist is the GitLab boundary. The built-in GitHub bot names (`vanguard`, `github-actions`, `*[bot]`) grant nothing on GitLab, since anyone can register them there; only explicit bot logins count. If the glab user cannot be read, no note is stamped and Vanguard's own notes fail closed under an allowlist too (a warning is logged). A *supplied* association fails closed, including the empty string GitHub's GraphQL omission maps to.

A Linear comment is treated as MEMBER only when Linear attributes it to a workspace `user`. Comments an integration posts (Slack thread sync, Intercom, Asks) carry `externalUser` or no user at all; they get an empty author and association and fail closed. Vanguard's own comments are posted under the API key owner's user, so they stay trusted.

## Residual trust widening

- `linear-cli.ts` stamps every comment by a workspace user MEMBER, so any workspace user (guests included) is trusted on Linear.
- `issue-author` trust means an outsider who opens an issue stays trusted for that issue's `<spec_manifest>` and acceptance criteria — they already control the description those gates read, so the comment adds no reach. It never lets the reporter *suppress* work: the "spec already posted" check and the research iteration markers require bot, association or allowlist trust.

Both are defensible because runs are human-triggered, but they are trust, not verification.

## Manual workflow edits

Workflow files are deliberately unchanged. Until these edits land, allowlisted non-members must pass `--feedback-authors` themselves or their comments will be ignored.

In `revise.yml`'s **Revise the PR from review comments** step, add this to `env:`:

```yaml
IN_ALLOWED_ACTORS: ${{ inputs.allowed-actors }}
```

In the step's `run:` body, add these lines next to the existing `args+=` lines, before the `node …` call (no expression interpolation inside `run:`; `if` rather than `&&`, so an empty allowlist does not fail the step under `bash -e`):

```bash
AUTHORS=$(printf '%s' "$IN_ALLOWED_ACTORS" | tr -d '[]" ' )
if [ -n "$AUTHORS" ]; then args+=(--feedback-authors "$AUTHORS"); fi
```

Apply the identical environment entry and two shell lines in `implement.yml`'s **Run Vanguard loop** step. No trigger, permissions or actor-gate change is required.

## Follow-up

Track narrowing comment context separately: `taskToVariables`'s COMMENTS variable and the difficulty probe still receive all comments as escaped, untrusted context. This change gates autonomous decisions but does not eliminate model influence from contextual text.
