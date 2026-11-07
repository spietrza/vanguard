# Architecture

How Taskcell is put together: the design principles, the run pipeline, the layers in `src/`, and how to drive it as a library.

## Design philosophy

Taskcell treats autonomous coding as an engineering system, not a prompt-and-pray script. Five principles separate it from "run an agent in a loop":

- **Harness over code.** Every agent failure is a *harness* failure. Instead of hand-fixing the agent's output, you fix the instruction, skill, tool, or sandbox limit so the system is immune to that failure class next time. Real cases this codebase hardened against: a macOS worktree-path mismatch, a dangling-symlink copy-back crash, and a NAS kernel with no CPU CFS scheduler — each became a permanent fix, not a one-off patch.
- **Trade-off reasoning.** System prompts state the *business cost* of decisions — a wrong or sloppy change costs reviewer trust and rework far more than the seconds a typecheck or test run takes — so the model spends "effort" (adaptive thinking) where it matters and escalates when it should, via the `<tradeoffs>` section of the default system prompt.
- **Token-efficiency by construction.** Sessions are captured to the host and resumed/forked to reuse cached context instead of paying twice for it; `cacheReadInputTokens` and a derived `cacheEfficiency` are first-class on every `RunResult` and tracked per stage. Real runs sit at 97–99% cache, which is what makes always-on AFK economical.
- **Evals-first.** A judge-scored eval suite over control (ambiguous), edge, and refusal/hand-off cases guards against regressions when a model or prompt changes (corpus seeded; run `vanguard eval` for pass-rate and verdict scores — `--judge-model clef-flash` judges with a decision model, calibrated and parse-free; it does not gate CI yet).
- **Verifiable run artifacts.** Every run leaves an auditable trail under `.vanguard/runs/`: a per-stage transcript, a **git bundle of the exact changes**, the diff, one `run_complete` metric line (cost, tokens, cache efficiency, duration, exit reason), and optional host-driven Proof of Work with a SHA-256 over verification output. `vanguard stats` rolls it up across the fleet. This is what makes an AFK-generated PR trustworthy. The run also carries an optional host-driven Visual Proof for UI artifacts (see Visual proof below). *(Retrospective memory is also implemented: a deterministic host-side digest of prior failures and reviewer notes, fed back into later runs as advisory context.)*

## One run

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="diagrams/run-pipeline-dark.svg" />
    <img src="diagrams/run-pipeline-light.svg" width="100%" alt="One Taskcell run: on the host (a CI job or a watch loop), claim and triage (no model call; too vague goes to needs info). In the Docker sandbox: implement, review (Codex, fresh context, fixes), simplify (fresh context), then verify with the repo's verify script (else its detected test scripts); red sends it to repair (at most 2, the second on a stronger model) and back to verify. Green, or repairs used up, goes back to the host: secret scan (a hit pushes nothing), then push and open a PR, or an MR on GitLab: ready for review when green, a draft with verify-failed when still red, and also a draft when no verify command ran or the visual proof failed." />
  </picture>
</p>

The agent runs inside the sandbox. The host owns all file sync (`copyIn` / `copyFileOut`) and secrets. A run stops when the agent emits `<promise>COMPLETE</promise>`.

## Layers

- **Sandbox** (`IsolatedSandboxProvider`): `DockerSandboxProvider` for local and Linux hosts, `FirecrackerSandboxProvider` for microVMs on a KVM host. Resource limits, tmpfs secrets, streaming exec.
- **Worktree** (`WorktreeManager`): one git worktree per task. Cleanup keeps a worktree that still has uncommitted changes.
- **Agent** (`AgentProvider`): `ClaudeCodeProvider` runs the in-sandbox `claude` CLI (effort levels, stream-json, usage and cost). `PiProvider` is a stub.
- **Context**: a prompt engine (`{{KEY}}` placeholders and `` !`cmd` `` expansion run in the sandbox), `buildXmlPrompt` for XML-tagged prompts, and `SkillRegistry` for injecting tools.
- **Pipeline**: `runStages` chains stages over one shared worktree and session. Built-in stage sets: Implementer/Reviewer/Simplifier, Generate/Evaluate/Repair, and Plan/Implement/Adversary (a red-team reviewer that reports `<findings>` without editing). `commitStage` and `publishForReview` are the Merger.
- **Guardrails**: `runBudgetedStages` enforces a hard cost ceiling and freezes the run (`budget_exceeded`) for resume after a raise; `runJudgedRepair` freezes to `needs_human` after three rejected repairs, leaving the sandbox live for `shellCommand()` entry.
- **Evals**: `runEvals` scores cases (control, edge, refusal) with a programmatic or LLM judge.

## Library use (end to end)

```ts
const task = await fetcher.fetch('123');
const ctx = await prepareContext({ taskId: task.id, localRepoPath, baseBranch: 'main', start: 'base', sandbox });
try {
  await runStages(ctx, implementReviewSimplifyStages(), { agent, variables: taskToVariables(task) });
  const commit = await commitStage(ctx, { message: `feat: ${task.title}` });
  if (commit.committed) await publishForReview(ctx, { title: task.title });
} finally {
  await disposeContext(ctx);
}
```

`fetcher` is any `TaskFetcher` ([task-sources.md](task-sources.md)). [`examples/from-github-issue.ts`](../examples/from-github-issue.ts) runs this whole loop from a GitHub issue.
