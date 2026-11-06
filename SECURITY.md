# Security policy

Vanguard runs coding agents on untrusted input: issue text, repository files and dependencies. We treat the agent as hostile, so the controls around it are the core of the product. We appreciate reports that break any of them.

## Supported versions

Only the latest minor release gets security fixes. The `v1` tag used by the reusable GitHub Actions workflows always points at the latest release.

| Version | Supported |
|---|---|
| latest `1.x` minor (`v1` tag) | yes |
| older minors | no, upgrade to the latest |

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub: **Security → Report a vulnerability** on [spietrza/vanguard](https://github.com/spietrza/vanguard/security/advisories/new).

Include:

- the affected version or commit,
- the component (sandbox, egress or LLM proxy, copy-back, secret scan, Hub, GitHub/GitLab workflows, CLI),
- the steps to reproduce with dummy credentials and a dummy repository,
- the impact you observed.

What to expect:

- an acknowledgement within 7 days,
- an assessment and a fix plan within 30 days for confirmed issues,
- a GitHub security advisory and credit in the release notes, unless you prefer to stay anonymous.

## In scope

Anything that crosses one of these boundaries:

- **Sandbox escape:** code running in the agent sandbox affects the host or another run.
- **Credential exposure:** a model, GitHub, GitLab or Linear credential reaches the sandbox, a PR, a log, a transcript or a run record when Vanguard claims it does not (for example under `--llm-proxy`).
- **Egress bypass:** a sandbox under `--egress` reaches a host outside the allowlist.
- **CI-config copy-back bypass:** an agent change to `.github/workflows/`, `.github/actions/`, `.gitlab-ci.yml` or `.gitlab/**.yml` reaches a pushed branch.
- **Secret-scan bypass:** a credential in a diff is pushed without being blocked.
- **Trust bypass in the workflows:** an unauthorised issue author, PR commenter or fork can start a run, steer a revision, or get a push to a base branch.
- **Hub:** unauthenticated access to `/rpc/*` or `/events`, DNS rebinding, or reading private run data from another origin.

## Out of scope

- Attacks that need a malicious repository maintainer or a compromised host account.
- The behaviour of the model providers themselves (Anthropic, OpenAI, Z.ai, OpenRouter, Cursor).
- Findings in a deployment that ignores the documented warnings, for example a Hub bound to a public interface without `--allowed-host` and a reverse proxy.
- Denial of service through the user's own model budget.

## Security model

How the boundaries work: the [Security section of the README](README.md#security) and the [self-hosted security review](docs/plans/2026-11-06-self-hosted-security-review.md).
