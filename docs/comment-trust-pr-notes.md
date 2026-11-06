# PR notes: comment author trust

Autonomous revision, manifest, readiness and research decisions now reject unauthorised comment authors. GitHub associations OWNER/MEMBER/COLLABORATOR, explicit allowlists and (for issue specifications) the issue author establish trust. Bot comments supply specifications and iteration markers but are excluded from actionable revision feedback.

The shared bot matcher uses an exact `vanguard` login rather than a substring: an outsider can choose a username such as `mallory-vanguard`. Custom bot logins can be supplied explicitly. Research iteration markers are gated on trust rather than on a bot login, so the white-label/PAT configuration (findings posted under a human-looking name) still advances the iteration counter.

GitHub issue comments retain the existing `gh issue view --json comments` source: GitHub CLI's [Comment definition](https://github.com/cli/cli/blob/trunk/api/queries_comments.go) includes `authorAssociation`, and a live `gh issue view --json comments` returns it (checked 2026-10-23). GitHub models an association on every comment, so `toTask` maps a missing one to `''`, which fails closed; it also warns when an issue has comments and none carries an association, since a future `gh` that drops the field would turn every non-bot comment untrusted.

## Providers that model no association

GitLab notes carry no association at all, so there is no signal to gate on. A comment whose association field is *absent* therefore classifies as `no-association` and stays trusted: failing closed there would reject Vanguard's own `<tech_spec>`/research notes, parking ready tickets as "needs info", re-posting specs and shipping every MR as a declared-partial PR. GitLab consequently keeps its pre-gate behaviour and gains a boundary only through `--feedback-authors`. A *supplied* association fails closed, including the empty string GitHub's GraphQL omission maps to.

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
