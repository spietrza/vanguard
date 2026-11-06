# Skills

Taskcell supports Claude Code skills (the `SKILL.md`-per-directory format used by collections like [obra/superpowers](https://github.com/obra/superpowers), [mattpocock/skills](https://github.com/mattpocock/skills), and [cursor-team-kit](https://github.com/cursor/plugins/tree/main/cursor-team-kit/skills)). Point a registry at a directory of skills and Taskcell injects the whole set into the agent's `~/.claude/skills` inside the sandbox. The agent auto-discovers and selects the relevant ones at runtime, so there is no per-run list to maintain.

```ts
import { skillRegistryFromDirectory, run } from 'vanguard';

// Clone a skills collection into ./skills (each subdir with a SKILL.md is one skill).
const skills = await skillRegistryFromDirectory('./skills');
await run(opts, { skills });
```

For targeted injection instead of the whole set, construct `new SkillRegistry({ id: '/host/path' })` and call `inject(['id'], sandbox)`.

The repo bundles five skills in `skills/`: `code-review` and `simplify` (used by the loop's review pass), `tech-spec` (specs for under-specified tasks), `caveman` (cut tokens on long runs), and `ponytail` (avoid over-engineering: climb the laziness ladder, stop at the first rung that works). `tech-spec` reaches only the spec pass: the CLI's and the factory's implement, revise and review runs never load it, because it forbids editing source files. An SDK caller that points `skillRegistryFromDirectory` at the bundled dir loads it too and should drop it from non-spec runs itself.

## Custom skills (bring your own)

A skill is a directory with a `SKILL.md` (frontmatter `name` + `description`, then the body), the standard Claude Code format. `--skills <dir>` injects every subdirectory in that dir, and the agent picks the right one per task by matching each skill's `description`. A migration task pulls in `db-migrations`, a release task `release`, and `ponytail` fires on everything. You curate the set, the model chooses per task. There is no per-issue flag.

Keep your domain skills in the target repo under `.github/vanguard-skills/`:

```
.github/vanguard-skills/
  db-migrations/SKILL.md
  release/SKILL.md
```

That is the whole setup. Taskcell injects every skill in the `--skills` dir plus every skill in the target repo's `.github/vanguard-skills/` into `run` and `watch` on every source (GitHub, GitLab, Projects, Linear), the spec pass (`spec`, and `watch` loop-v1), `revise-pr`, and the reviewers (`review-pr`, `watch-prs`, `review-mr`, `watch-mrs`). `research` runs without skills. Reviewers take repo skills from the PR's base branch, so a PR cannot change the skills of its own review. The implement workflow passes the bundled `skills/`, so the agent keeps `ponytail`/`code-review`/`simplify` and gains yours. A thin `uses: spietrza/taskcell/.github/workflows/implement.yml@v1` caller needs no extra step or input. Leave the workflow's `skills` input at its default: pointing it at `.github/vanguard-skills` would drop the bundled skills the review and simplify stages use.

A repo skill with the same directory name as a bundled one replaces it, so a repo can ship its own `code-review`; the run log names every skill replaced this way. Skill directories that are symlinks are skipped, and so are `SKILL.md` files that are symlinks, with a warning in the run log. A `.github/vanguard-skills` that is not a directory, or that resolves outside the repo, fails the run.

Skills are injected per-provider in the format each CLI auto-discovers:

| Provider | Target | Format |
|---|---|---|
| `claude-code`, `zai`, `openrouter`, `meridian`, custom endpoints | `~/.claude/skills/<id>/` | Full skill directory |
| `codex` | `$CODEX_HOME/AGENTS.md` (`~/.codex/AGENTS.md` by default) | Pointer index: name + description + path to `.vanguard/skills/<id>/SKILL.md` |
| `cursor` | `.cursor/rules/<id>.mdc` | One `.mdc` per skill with `description`/`globs` frontmatter + pointer |

Codex receives only a pointer index (not the full skill bodies) in its always-on `AGENTS.md` to avoid inflating every turn with N full skill texts; the model reads the body from `.vanguard/skills/<id>/SKILL.md` when the description matches the task. Cursor rules use `alwaysApply: false` so they are description-attached, not always-on, for the same reason. Neither `.cursor/rules/` nor `.vanguard/skills/` is copied back into the PR diff.

**Cross-provider runs:** skills are injected for every CLI family that may run in the sandbox: the implementer (`--provider`), the reviewer (`--review-provider`) and the implementer fallback (`--fallback-provider`). With `--provider claude --review-provider codex`, the Claude stages get `~/.claude/skills/` and the Codex reviewer gets the `AGENTS.md` pointer index.

Two checks before a skill goes in. It must be self-contained: `SKILL.md` plus plain text, no MCP or browser, since the sandbox has neither. It must allow model invocation: skip any with `disable-model-invocation: true`, because the agent never triggers those itself. Only the `description`s load up front, so curate about a dozen, not a whole collection.

## When a skill is worth adding

A skill is worth adding when it carries knowledge the model lacks: how to drive an unfamiliar CLI (the linear-cli skill below), a repo-specific procedure such as writing a migration or cutting a release, or long instructions that only some tasks need.

Generic expert skills such as `docker-expert` or `python-expert` add little, because the model already knows Docker and Python. Put your stack rules and conventions in the target repo's `CLAUDE.md` (Codex reads `AGENTS.md`), which the agent CLI loads on every stage.

An instruction that a stage must follow on every run belongs in the stage prompt, since the model decides whether to open a skill. Taskcell's review prompt says "If a code-review skill is available, use it.", and the simplify prompt says the same for `simplify`. Both prompts also state their core instructions directly, so a stage that skips the skill still follows them. The skills add the detailed checks, and `code-review` adds the severity rules for blocking a merge.

To see which skills a run used, search its transcripts in `.vanguard/runs/<taskId>/`. A Claude-family stage logs each Skill tool call as `"skill":"<id>"`. Codex and Cursor read the body from `.vanguard/skills/<id>/SKILL.md`, so search for that path instead.

## Example: the linear-cli skill

[schpet/linear-cli](https://github.com/schpet/linear-cli) ships a skill at `skills/linear-cli/` that teaches the agent to drive the `linear` CLI directly. The sandbox image already includes the `linear` CLI, so you only inject the skill and forward `LINEAR_API_KEY`:

```bash
git clone --depth 1 https://github.com/schpet/linear-cli /tmp/linear-cli
```

```ts
const skills = await skillRegistryFromDirectory('/tmp/linear-cli/skills'); // registers the linear-cli skill
const sandbox = new DockerSandboxProvider({ secrets: { ...authSecrets(auth), LINEAR_API_KEY: process.env.LINEAR_API_KEY! } });
await run({ ...opts, sandbox }, { skills });
```

The agent then auto-discovers the skill and can read or update Linear from inside the sandbox.
