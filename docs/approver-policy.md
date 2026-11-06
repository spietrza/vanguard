# Approver policy (`.vanguard/approver.json`)

The approver stage decides `APPROVE` or `ESCALATE` for a factory PR from typed facts only, with no
LLM in the loop. Everything it is allowed to accept is declared in `.vanguard/approver.json`. The
schema lives in `src/approver/policy.ts`, the pure decision function in `src/approver/rules.ts`, and
the committed policy this repo runs under is at the repo root (`.vanguard/approver.json` — tracked on
purpose, see `.gitignore`).

v1 is **shadow mode**: the decision is published as a `neutral` check run plus a PR comment and
appended to `decisions.jsonl` on the `vanguard-metrics` branch. Nothing is ever merged, approved or
labelled. See [Approver (shadow mode)](autonomous-loop.md#approver-shadow-mode) for how to run it.

## Where the file is read from

**The base branch only.** `loadPolicy` resolves `origin/<base>` and reads the file with

```
git show refs/remotes/origin/<base>:.vanguard/approver.json
```

— never the working tree, never a local-only branch, and never the PR head. A PR cannot widen the
policy it is judged by: the bytes that decide it are the bytes already on the branch it targets.

Two consequences:

- **A PR that touches `.vanguard/approver.json` always ESCALATEs.** The file is listed under the
  `review-pipeline` path rule, so the `path:review-pipeline` rule fires on any diff that includes it
  and the verdict can never be `APPROVE`. A policy change is therefore always a human decision.
- **An unreadable or invalid policy fails closed.** A missing file, malformed JSON, or a body that
  fails schema validation yields `ESCALATE` with `rulesFired: ['policy-unreadable']` and
  `policyHash: "none"`, and a decision record is still written.

Every decision record carries `policyHash`: `sha256:<hex>` over the exact file bytes (final newline
included), so a recorded decision can be replayed against the policy that produced it.

Unknown extra keys are tolerated (forward compatibility): a newer policy file can be read by an older
engine, as long as `schemaVersion` still matches.

## Fields

| Field | Required | Default | Value shipped here | Why |
| --- | --- | --- | --- | --- |
| `schemaVersion` | yes | — | `1` | Only `1` is accepted. A file written for another engine version fails validation instead of being half-read under the wrong meaning. |
| `enabled` | yes | — | `true` | In-repo kill switch. `false` short-circuits to `ESCALATE` with `rulesFired: ['stopped']` before any diff or ledger collection — turning the stage off is a one-line PR to the base branch, not a code change. |
| `factoryBranchPrefix` | no | `"chore/vanguard-"` | `"chore/vanguard-"` | A PR only qualifies when its head is a same-repo branch with this prefix. Anything else (a human branch, a fork) fires `not-factory-pr`: the approver judges the factory's own output, nothing else. |
| `requiredChecks[].name` / `.appId` | yes | — | `build` and `dependency-review`, both `appId: 15368` | Each entry must resolve, on the head SHA, to a check run matching **both** name and app id, with conclusion `success`; anything else fires `check-missing:<name>`. The app id is what stops another app — or a raw token — from posting a green check under a trusted name. `15368` is the GitHub Actions app. |
| `reviewAuthors` | yes | — | `["github-actions"]` | Login allow-list for the review the verdict is taken from. Required and non-empty: any GitHub user can post a review, so a missing or empty list would let anyone forge the verdict; instead the policy fails validation and every decision is `ESCALATE` `policy-unreadable`. The shipped value pins the review to the external review workflow's identity (the login `gh pr view --json reviews` reports, with no `[bot]` suffix). |
| `testGlobs` | no | `["**/*.test.ts"]` | `["**/*.test.ts"]` | Which paths count as tests, for the `test-file-deleted` and `test-cases-lost` rules, and which are excluded from the removed-exports count. Matches this repo's co-located Vitest convention. |
| `pathRules` | yes | — | see below | Map of rule id to globs. Any changed path matching a rule's globs fires `path:<id>` — the sensitive-surface escalations. Required with no default: an empty or absent map would silently approve changes to the riskiest files. |
| `shape.maxLines` | yes | — | `150` | Changed lines (added + removed, against the merge base) above which `size-lines` fires. A diff bigger than one sitting's worth of review is escalated regardless of how clean it looks. Boundary is exclusive: 150 passes, 151 fires. |
| `shape.maxFiles` | yes | — | `5` | Changed files above which `size-files` fires, same reasoning and the same exclusive boundary. |
| `ledger.windowDays` | yes | — | `7` | Trailing window, in days, of earlier `APPROVE` records read from `decisions.jsonl` for the velocity rule. One week is short enough to be about current activity and long enough to catch a drip of small changes. |
| `ledger.maxLines` | yes | — | `300` | Per-module ceiling: if the trailing approved lines for any module this PR touches, plus this PR's own lines, exceed it, `velocity` fires. Caps how much unreviewed change can accumulate in one area even when every single PR looks small. |
| `auditSample.p` | yes | — | `0.1` | Probability that an otherwise-clean decision is escalated anyway as `audit-sample`, so a share of approvals still gets human eyes. The draw is deterministic — `sha256(repo:pr:headSha:policyHash)` read as a fraction, overridable for replay with `VANGUARD_APPROVER_AUDIT_SEED` — so a decision is reproducible, never a coin flip at run time. `0` disables sampling, `1` escalates everything. |

### `pathRules` as shipped

| Rule id | Covers | Why it escalates |
| --- | --- | --- |
| `ci-config` | `.github/**`, `.gitlab-ci.yml`, `.gitlab/**` | CI config runs with the repo's secrets; the autonomous run is not allowed to change it at all (see `CLAUDE.md`). |
| `dependencies` | `**/package.json`, `**/pnpm-lock.yaml`, `**/Cargo.*`, `apps/desktop/src-tauri/**` | Supply chain: a new or moved dependency is a human call. |
| `migration-deploy` | `docker/**`, `**/*migration*` | Deploy and data-shape changes are not safely reversible by a revert. |
| `security-surface` | `src/sandbox/**`, `src/core/vanguard.ts`, `src/core/secret-scan.ts`, `src/context/**`, `src/agents/**` | The isolation and secret-handling boundaries. |
| `review-pipeline` | the review/revise runners, the publish and gate pipeline, `src/approver/**`, `.vanguard/approver.json` | The machinery that produces and checks the factory's own output, including this policy — it must never approve a change to itself. |
| `gate-config` | `vitest.config.ts`, `eslint.config.js`, `tsconfig*.json` | Loosening a gate would invalidate every later green check. |
| `agent-instructions` | `skills/**`, `CLAUDE.md`, `AGENTS.md` | The prompts and constraints the agents run under. |
| `release-config` | `release-please-config.json`, `.release-please-manifest.json` | Publishing behaviour. |

Globs are matched case-sensitively against the repo-relative POSIX path git prints, by the small
pathspec-like matcher in `src/approver/policy.ts`: leading `**/` means zero or more directories, `**`
elsewhere crosses `/`, `*` and `?` do not, everything else is literal. A trailing `/**` therefore
matches everything under a directory but not the bare directory name.

## Rules that need no configuration

These fire from the facts alone and have no policy knob: `not-open` (the PR is closed or merged), `draft`, `review-missing`, `review-stale`,
`review-blocking`, `review-incomplete`, `merge-conflict`, `head-moved`, `git-facts-failed`,
`new-dependency` (a manifest key the base branch does not have), `public-api-changed` (a removed
export outside test files), plus the two short-circuits `stopped` and `policy-unreadable`. Any single
rule firing makes the verdict `ESCALATE`; `APPROVE` means the rule list came back empty.

## Changing the policy

Edit `.vanguard/approver.json` and open a PR. That PR escalates by construction (`path:review-pipeline`),
and the new values only take effect once it is merged into the base branch — the run deciding a PR
reads the policy from `origin/<base>`, so nothing takes effect mid-flight.
