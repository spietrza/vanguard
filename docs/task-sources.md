# Task sources

Taskcell reads work from GitHub Issues, GitHub Projects v2, GitLab Issues or Linear. From the CLI you pick the source per command:

```bash
vanguard run --github owner/repo#123        # one GitHub issue
vanguard run --gitlab group/project#45      # one GitLab issue
vanguard run --linear ENG-7                 # one Linear issue
vanguard run --project 3                    # every item on a GitHub Projects v2 board
vanguard watch --source <linear|github|project|gitlab> ...   # poll a source (see autonomous-loop.md)
```

Setup guides: [GitHub Actions](onboarding-another-repo.md) and [Linear](onboarding-linear.md).

## In code

`TaskFetcher` abstracts the source, so one deployment uses a single source of truth.

```ts
const fetcher = new LinearCliTaskFetcher({ team: 'ENG' });          // Linear (via the linear CLI)
const fetcher = new GitHubTaskFetcher('owner/repo');                    // GitHub Issues
const fetcher = new GitHubProjectFetcher({ owner, projectNumber, repo });// GitHub Projects v2
```

GitHub is also the review surface: `publishForReview` opens a PR, and `linkPullRequest` / `linkLinearIssue` comment the PR link back onto the source issue.

A Linear task in a repo whose `origin` is on gitlab.com, or on the self-hosted host named by `GITLAB_HOST`, opens a GitLab MR through `glab` instead (draft only when a gate or configured visual proof failed, or no verify command ran), and the review verdict lands as an MR note. A self-hosted host needs `GITLAB_HOST` even when `glab auth login` already knows it; preflight stops a run whose origin host glab is logged in to but `GITLAB_HOST` does not name. That check never sends `GITLAB_TOKEN` to the origin host, so a job with only a token relies on `GITLAB_HOST`. Host detection reads the hostname in `origin` as written, so a remote that uses an SSH config alias is not recognised: `git@gitlab.com-work:group/project.git` takes the GitHub route on the Linear path, and `--source gitlab` accepts an alias such as `github.com-work` as a GitLab host and fails later in `glab`. Use the real hostname in `origin`. Agent runs never write CI config: `.github/workflows/`, local actions under `.github/actions/` (an action kept elsewhere is not covered), `.gitlab-ci.yml` and every `.yml`/`.yaml` under `.gitlab/`, including insights, dashboards and Kubernetes agent config, are dropped on copy-back with a warning, so a task that only edits those files ends with no changes; make such edits by hand. When a run changed any of them, the PR or MR description (or the `revise-pr` summary comment) lists those files under **Not included**. `vanguard review-mr` skips an MR head it already reviewed, so a CI retry after a completed review posts no second review. Two runs on the same head that overlap can both post, since the check runs before the review and the note is posted after it. Only a marker in a note by the user `glab` runs as counts, so another participant cannot suppress the review by posting a marker. An MR author who can change the job definition can still suppress it, as [External PR review](autonomous-loop.md#external-pr-review) explains. After a switch to a token of another user, earlier reviews stop counting and each open MR head is reviewed once more. A running `watch-mrs` keeps the user it read first, so restart it after such a switch. When it cannot read that user (the token needs `GET /user`) or the MR notes, it fails and posts nothing, and the error says which. The reviewer states a `Verdict:` line first, so a reply cut off before its completion signal still counts as a review (posted with a truncation note). A reply with no verdict is retried once with a larger budget and a verdict-first triage instruction; if the retry has no verdict either, `review-mr` posts nothing and exits non-zero, so the head is never marked as reviewed, and both discarded replies' tails are in the job log.

`LinearCliTaskFetcher` drives Linear entirely through the `linear` CLI (from schpet/linear-cli; authenticate with `linear auth login` or set `LINEAR_API_KEY`), covering fetch/list/comment with no SDK dependency. The CLI's skill (SKILL.md in that repo) can be injected via `skillRegistryFromDirectory` so the agent uses it directly. Confirm the `linear issue query --json` field shape against your workspace before relying on it.
