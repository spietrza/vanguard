# Changelog

## [1.13.0](https://github.com/spietrza/taskcell/compare/v1.12.0...v1.13.0) (2026-11-07)


### Features

* **desktop:** desktop: list_runs/read_run forward to core run-store over the sidecar pipe; delete the runs.rs reader (spietrza/taskcell[#511](https://github.com/spietrza/taskcell/issues/511)) ([#614](https://github.com/spietrza/taskcell/issues/614)) ([82fcea4](https://github.com/spietrza/taskcell/commit/82fcea465e48f55fbc76a8de3dfe2e75c1e2dae2))
* **desktop:** review verdict as a run record; Task Board shows the pipeline stage and per-stage verdict chips (spietrza/taskcell[#512](https://github.com/spietrza/taskcell/issues/512)) ([#613](https://github.com/spietrza/taskcell/issues/613)) ([d0710f8](https://github.com/spietrza/taskcell/commit/d0710f82a70144ef65713a9bd3e3031cf8080e30))
* Factory runs that hit a provider rate limit (429) stay stuck until someone re-labels the PR (spietrza/taskcell[#615](https://github.com/spietrza/taskcell/issues/615)) ([#639](https://github.com/spietrza/taskcell/issues/639)) ([50d7b7e](https://github.com/spietrza/taskcell/commit/50d7b7ef96298b03608322bcd9270e958c0d4757))
* hub: always run with the LLM proxy (spietrza/vanguard[#584](https://github.com/spietrza/taskcell/issues/584)) ([#587](https://github.com/spietrza/taskcell/issues/587)) ([dde684b](https://github.com/spietrza/taskcell/commit/dde684b5065ccacf39d398f398c28c369cb1457b))
* hub: Host allowlist and per-launch token (DNS rebinding) (spietrza/vanguard[#583](https://github.com/spietrza/taskcell/issues/583)) ([#588](https://github.com/spietrza/taskcell/issues/588)) ([a083269](https://github.com/spietrza/taskcell/commit/a0832699326d44b8d37d4ab4b688c70278248323))
* hub: Host allowlist follow-ups (port-forward, --host, SSE wording, docs) (spietrza/vanguard[#591](https://github.com/spietrza/taskcell/issues/591)) ([#594](https://github.com/spietrza/taskcell/issues/594)) ([552830a](https://github.com/spietrza/taskcell/commit/552830aea99ed21448bd7035eac3612b029a086b))
* hub: watch.test.ts T-72/T-73 fail on macOS (fs.watch timing), pass on Linux CI (spietrza/taskcell[#528](https://github.com/spietrza/taskcell/issues/528)) ([#612](https://github.com/spietrza/taskcell/issues/612)) ([0ee1f6a](https://github.com/spietrza/taskcell/commit/0ee1f6a51a4311419db0566180729139607de74b))
* landing: remove the PR counter and fix spacing, scene labels and touch targets from the design review (spietrza/taskcell[#624](https://github.com/spietrza/taskcell/issues/624)) ([#626](https://github.com/spietrza/taskcell/issues/626)) ([b2ebb34](https://github.com/spietrza/taskcell/commit/b2ebb34c9d57de1b92a17e6d70d233e67d177962))
* PR reviewer ends without a verdict despite spending tokens (spietrza/taskcell[#598](https://github.com/spietrza/taskcell/issues/598)) ([#609](https://github.com/spietrza/taskcell/issues/609)) ([2b28883](https://github.com/spietrza/taskcell/commit/2b288835968ebe4ccef112b500335fdfcc015b32))
* **runners:** PR review worktree is cut from the PR's base branch, so reviewer instruction files (CLAUDE.md, AGENTS.md, skills/) come from that branch (spietrza/taskcell[#463](https://github.com/spietrza/taskcell/issues/463)) ([#610](https://github.com/spietrza/taskcell/issues/610)) ([666dec9](https://github.com/spietrza/taskcell/commit/666dec91615740b6f5ce1afb10e25703284d2252))
* secret-scan: bearer rule flags prose like "bearer token" (spietrza/taskcell[#635](https://github.com/spietrza/taskcell/issues/635)) ([#637](https://github.com/spietrza/taskcell/issues/637)) ([e986fd0](https://github.com/spietrza/taskcell/commit/e986fd0cc5c110180ad19be79bf1d3e9690cf42c))
* sidecar: LLM-proxy follow-ups (real credential test, docs scope, warning dedup) (spietrza/taskcell[#592](https://github.com/spietrza/taskcell/issues/592)) ([#611](https://github.com/spietrza/taskcell/issues/611)) ([8843eef](https://github.com/spietrza/taskcell/commit/8843eefc96e9030f9789260ad84feb54ca5941f8))
* sidecar: LLM-proxy follow-ups (real credential test, docs scope, warning dedup) (spietrza/vanguard[#592](https://github.com/spietrza/taskcell/issues/592)) ([#593](https://github.com/spietrza/taskcell/issues/593)) ([c163f37](https://github.com/spietrza/taskcell/commit/c163f379878e318d2af29f282c3f4d2f057bdb31))
* spike: can the Codex ChatGPT-plan credential stay on the host behind the LLM proxy (spietrza/taskcell[#625](https://github.com/spietrza/taskcell/issues/625)) ([#638](https://github.com/spietrza/taskcell/issues/638)) ([2df156a](https://github.com/spietrza/taskcell/commit/2df156a982921b0ffad1d9782a217e14403455c2))


### Bug Fixes

* argv spawn for desktop runs and chat origin allowlist ([#600](https://github.com/spietrza/taskcell/issues/600)) ([5fe4dea](https://github.com/spietrza/taskcell/commit/5fe4dea6ac61f1398e9f4b1bfa33fbb7f2298f5d))
* harden hub endpoints ([#605](https://github.com/spietrza/taskcell/issues/605)) ([983029b](https://github.com/spietrza/taskcell/commit/983029b9ce50113956afe91e9b8595150ace68a4))
* harden prompt context and trust checks ([#608](https://github.com/spietrza/taskcell/issues/608)) ([aa3adfc](https://github.com/spietrza/taskcell/commit/aa3adfcef6c6fc1da90e4643a1f293790182695e))
* harden sandbox egress and delivery ([#607](https://github.com/spietrza/taskcell/issues/607)) ([62f76c1](https://github.com/spietrza/taskcell/commit/62f76c172ba5a4d95f5cc7d4044a40c1274030a5))
* ignore worktree hooks in host git ([#596](https://github.com/spietrza/taskcell/issues/596)) ([39a3fe7](https://github.com/spietrza/taskcell/commit/39a3fe710269354af1586f6f8f9442876285a9d4))
* pass hub token via launch url ([#597](https://github.com/spietrza/taskcell/issues/597)) ([40204e6](https://github.com/spietrza/taskcell/commit/40204e6b17e82aeef731a483b3ee09ab69c27a3e))
* redact injected secrets on every publish path ([#602](https://github.com/spietrza/taskcell/issues/602)) ([2204948](https://github.com/spietrza/taskcell/commit/2204948e10fc5f06725e467a2487dcbe3b60a7b7))
* tighten tracker comment trust and board scope ([#599](https://github.com/spietrza/taskcell/issues/599)) ([6b0383d](https://github.com/spietrza/taskcell/commit/6b0383d00558d29a3ef99331744224e80a75f9e8))
* validate session ids and guard .vanguard paths ([#601](https://github.com/spietrza/taskcell/issues/601)) ([e94c778](https://github.com/spietrza/taskcell/commit/e94c7787aa23ce3c03696e85ff2e496c8a5873d8))


### Documentation

* add security policy ([#590](https://github.com/spietrza/taskcell/issues/590)) ([23c886f](https://github.com/spietrza/taskcell/commit/23c886fe7b5cf04873fc2f3980d8b1e985f7f21c))
* product README and OWASP self-assessment ([#606](https://github.com/spietrza/taskcell/issues/606)) ([230d9f4](https://github.com/spietrza/taskcell/commit/230d9f4278e844cd41b838fdc2b39f682ae138de))
* rename repo to spietrza/taskcell ([#595](https://github.com/spietrza/taskcell/issues/595)) ([504affe](https://github.com/spietrza/taskcell/commit/504affee1b941c9e378c97acaa2e8d949b0890f5))
* self-hosted security review ([#582](https://github.com/spietrza/taskcell/issues/582)) ([408b751](https://github.com/spietrza/taskcell/commit/408b75191c59ec5c64fa01c8ecbf369b5dfbf57e))

## [1.12.0](https://github.com/spietrza/vanguard/compare/v1.11.0...v1.12.0) (2026-10-24)


### Features

* **approver:** deterministic APPROVE/ESCALATE for factory PRs, shadow mode ([#557](https://github.com/spietrza/vanguard/issues/557)) ([44196c5](https://github.com/spietrza/vanguard/commit/44196c50d0bd5464763ab8bf448122848fcea529))
* **approver:** the `Vanguard Approver (shadow)` workflow runs the approver after the factory PR review and comments APPROVE/ESCALATE; it never merges, approves or labels ([#564](https://github.com/spietrza/vanguard/issues/564)) ([b4fca07](https://github.com/spietrza/vanguard/commit/b4fca07eb2a7268fc6ecd94526fb8343932d57a2))
* **hub:** show how many tasks wait for the factory (spietrza/vanguard[#560](https://github.com/spietrza/vanguard/issues/560)) ([#562](https://github.com/spietrza/vanguard/issues/562)) ([ed440ef](https://github.com/spietrza/vanguard/commit/ed440efd2be76111f4052f6602ae082a1a6887d0))
* **review:** risk level line after the review verdict (spietrza/vanguard[#559](https://github.com/spietrza/vanguard/issues/559)) ([#561](https://github.com/spietrza/vanguard/issues/561)) ([340425a](https://github.com/spietrza/vanguard/commit/340425a695339c722b786517a8325f49ca11fcd8))
* revise: refuse fork PRs instead of pushing to a same-named base-repo branch (spietrza/vanguard[#567](https://github.com/spietrza/vanguard/issues/567)) ([#571](https://github.com/spietrza/vanguard/issues/571)) ([c889c81](https://github.com/spietrza/vanguard/commit/c889c81823b061aa08b1b8005f23ebbe135c23f7))
* revise: trust PR feedback and spec manifests only from authorised authors (spietrza/vanguard[#566](https://github.com/spietrza/vanguard/issues/566)) ([#569](https://github.com/spietrza/vanguard/issues/569)) ([bc92f5f](https://github.com/spietrza/vanguard/commit/bc92f5f32cfe23e799f624fc182d9e554f894133))
* secret-scan: check injected secret values regardless of path or allowlist marker (spietrza/vanguard[#568](https://github.com/spietrza/vanguard/issues/568)) ([#570](https://github.com/spietrza/vanguard/issues/570)) ([18b69c5](https://github.com/spietrza/vanguard/commit/18b69c599105c0df317152ebe0d890a32d8bc2ff))


### Bug Fixes

* **factory:** no double conventional prefix in the factory commit headline ([#553](https://github.com/spietrza/vanguard/issues/553)) ([d4ef178](https://github.com/spietrza/vanguard/commit/d4ef1780bae93534695d3d8caf9cf3430e503729))
* **revise:** mark the PR ready with VANGUARD_PUSH_TOKEN so the automatic review runs ([#572](https://github.com/spietrza/vanguard/issues/572)) ([0b30b77](https://github.com/spietrza/vanguard/commit/0b30b776d574c999a0ec79c6ddc20449b77d9336))


### Documentation

* diagrams show the shadow approver ([#565](https://github.com/spietrza/vanguard/issues/565)) ([f54ee87](https://github.com/spietrza/vanguard/commit/f54ee871047b1b105b28919efea16e8978bf00ee))
* PR review also fires on ready factory PRs ([#558](https://github.com/spietrza/vanguard/issues/558)) ([7a9def2](https://github.com/spietrza/vanguard/commit/7a9def29cb75e5c83393c72a178209e287d12058))
* README hero flow as a diagram ([#554](https://github.com/spietrza/vanguard/issues/554)) ([d7b1b8a](https://github.com/spietrza/vanguard/commit/d7b1b8ac7b5a233d8c4315240e5a0d807307b374))

## [1.11.0](https://github.com/spietrza/vanguard/compare/v1.10.1...v1.11.0) (2026-10-22)


### Features

* **decision-model:** default to clef instead of clef-flash ([#541](https://github.com/spietrza/vanguard/issues/541)) ([024cefe](https://github.com/spietrza/vanguard/commit/024cefead604baad844cb566ac0f637b7008522c))
* **factory:** open the PR ready for review when every gate passed ([#549](https://github.com/spietrza/vanguard/issues/549)) ([dcf0334](https://github.com/spietrza/vanguard/commit/dcf03341904f224240d189833e8fac7020523c4d))
* **pr-review:** `watch-prs` also takes the PR from `opened` / `ready_for_review` events, so a caller can review a factory PR as soon as it is ready; Vanguard's own caller now does that without a label, and CI's `build` runs `pnpm verify` ([#550](https://github.com/spietrza/vanguard/issues/550)) ([8e1e412](https://github.com/spietrza/vanguard/commit/8e1e412ffb3e9f413fb22f5db24c9139b897ff8e))
* **verify:** run the repo's verify script so the gate matches CI ([#548](https://github.com/spietrza/vanguard/issues/548)) ([21d81d0](https://github.com/spietrza/vanguard/commit/21d81d03644f0cbf5cace9f273daadd74cc57bf4))


### Bug Fixes

* **ci:** gate on spietrza, open factory PRs with the push token ([#543](https://github.com/spietrza/vanguard/issues/543)) ([7755fa8](https://github.com/spietrza/vanguard/commit/7755fa810f92f012b02e22b0b74a67717834fefc))
* **deps:** bump vite from 7.3.6 to 7.3.7 in apps/desktop ([#544](https://github.com/spietrza/vanguard/issues/544)) ([5443487](https://github.com/spietrza/vanguard/commit/5443487ad16d0735e855675ad132240f8d596667))


### Documentation

* add flow diagrams to README ([#542](https://github.com/spietrza/vanguard/issues/542)) ([6663df3](https://github.com/spietrza/vanguard/commit/6663df36cf0e788a652eae6922fe4246ea49e072))
* **cursor:** GitHub Actions does not support cursor yet ([#539](https://github.com/spietrza/vanguard/issues/539)) ([05e6a46](https://github.com/spietrza/vanguard/commit/05e6a46944064dd8cb5feaa008b515e8227570ca))
* diagrams cover GitLab and Linear, not just GitHub ([#545](https://github.com/spietrza/vanguard/issues/545)) ([bb7cfa0](https://github.com/spietrza/vanguard/commit/bb7cfa010026381cdaaf0aba62a22c684a2213d3))
* diagrams show ready PRs and the automatic review ([#551](https://github.com/spietrza/vanguard/issues/551)) ([1d0e5dd](https://github.com/spietrza/vanguard/commit/1d0e5ddfddbc5e17eefb6d3dc90f4536baaccd2c))


### Upgrade notes (callers on `@v1`)

* **Ready PRs:** a factory PR now opens ready for review when every gate passed. It stays a draft only when a gate or the visual proof failed, or no verify command ran ([#549](https://github.com/spietrza/vanguard/issues/549)).
* **CI on factory PRs:** map `VANGUARD_PUSH_TOKEN` in your implement caller's `secrets:`, with Contents and Pull requests: Read and write. Without it nothing changes: the PR opens with `GITHUB_TOKEN` and gets no CI until a push ([#543](https://github.com/spietrza/vanguard/issues/543)).
* **`verify` script:** a `verify` script in your `package.json` now takes precedence over the typecheck/test auto-detect ([#548](https://github.com/spietrza/vanguard/issues/548)).
* **Repository name:** the repository is `spietrza/vanguard`. Change `uses: SebaBoler/vanguard/...` to `uses: spietrza/vanguard/...`, because the old owner name only resolves through GitHub's rename redirect ([#543](https://github.com/spietrza/vanguard/issues/543)).

## [1.10.1](https://github.com/SebaBoler/vanguard/compare/v1.10.0...v1.10.1) (2026-10-20)


### Bug Fixes

* **ci:** pass bundled skills to review and revise runs ([#538](https://github.com/SebaBoler/vanguard/issues/538)) ([c4f21a6](https://github.com/SebaBoler/vanguard/commit/c4f21a69fa69d95f38cbe2ee6f0105b363285af8))


### Documentation

* **hub:** README Hub section, prerequisites and usage paths; docs/refactor in the changelog ([#536](https://github.com/SebaBoler/vanguard/issues/536)) ([4b2d172](https://github.com/SebaBoler/vanguard/commit/4b2d1724b6ce36a68111512cc03d9e5b222f60d8))

## [1.10.0](https://github.com/SebaBoler/vanguard/compare/v1.9.0...v1.10.0) (2026-10-20)


### Features

* **hub:** Add project by repository URL — clone into a chosen folder, then register it ([#534](https://github.com/SebaBoler/vanguard/issues/534)) ([440a27c](https://github.com/SebaBoler/vanguard/commit/440a27c3ca79995311f1263bbbeb35ed92b1e440)), closes [#532](https://github.com/SebaBoler/vanguard/issues/532)

## [1.9.0](https://github.com/SebaBoler/vanguard/compare/v1.8.1...v1.9.0) (2026-10-19)


### Features

* **cursor:** make the Cursor CLI provider work in the factory ([#519](https://github.com/SebaBoler/vanguard/issues/519)) ([16c2cec](https://github.com/SebaBoler/vanguard/commit/16c2cec1cfecbabfdfa52374824258b1e1919bdf))


### Bug Fixes

* **skills:** keep tech-spec out of implement, revise and review runs ([#526](https://github.com/SebaBoler/vanguard/issues/526)) ([56899cc](https://github.com/SebaBoler/vanguard/commit/56899cc9df7b1733fec7bb9fe0b5df1c9a1c0d0e))
* **skills:** warn on a dropped repo tech-spec, no override noise ([#531](https://github.com/SebaBoler/vanguard/issues/531)) ([9fbc5c6](https://github.com/SebaBoler/vanguard/commit/9fbc5c68b6e5cf113991152357112062d5eb06bd))

## [1.8.1](https://github.com/SebaBoler/vanguard/compare/v1.8.0...v1.8.1) (2026-10-19)


### Bug Fixes

* **deps:** dependabot bumps for root and apps/desktop in one verified PR ([#527](https://github.com/SebaBoler/vanguard/issues/527)) ([a11ced6](https://github.com/SebaBoler/vanguard/commit/a11ced6036e0206c1444bd3437d0e4e023604ee9))

## [1.8.0](https://github.com/SebaBoler/vanguard/compare/v1.7.0...v1.8.0) (2026-10-18)


### Features

* **desktop:** typed command catalogue in src/wire.ts for the Tauri, hub and mock adapters ([#509](https://github.com/SebaBoler/vanguard/issues/509)) ([63d5c67](https://github.com/SebaBoler/vanguard/commit/63d5c67a720e54b63bd855cb5b5b56f7fcc5c0ce)), closes [#498](https://github.com/SebaBoler/vanguard/issues/498)
* **factory:** conventional-commit prefix on factory PR titles ([#502](https://github.com/SebaBoler/vanguard/issues/502)) ([212e135](https://github.com/SebaBoler/vanguard/commit/212e1355ed43556dbc2ebb513b2ffaf13850b735)), closes [#495](https://github.com/SebaBoler/vanguard/issues/495)
* **hub:** one wire codec for the RPC envelope, SSE frames and the hub marker ([#503](https://github.com/SebaBoler/vanguard/issues/503)) ([3fa1748](https://github.com/SebaBoler/vanguard/commit/3fa1748508aee33d350169b9eb690d8db6c9ab61)), closes [#496](https://github.com/SebaBoler/vanguard/issues/496) [#491](https://github.com/SebaBoler/vanguard/issues/491)
* **inspector:** one address for a CI run's records on both backends ([#516](https://github.com/SebaBoler/vanguard/issues/516)) ([626b278](https://github.com/SebaBoler/vanguard/commit/626b278942ddb8c5cd5b3f5363c620d627d2b35c)), closes [#499](https://github.com/SebaBoler/vanguard/issues/499)
* **skills:** inject skills into the spec, revise and review runs ([#517](https://github.com/SebaBoler/vanguard/issues/517)) ([74055e0](https://github.com/SebaBoler/vanguard/commit/74055e00138f7b5ef34cbc4dd2b1dfb12cefdcd1))
* **skills:** merge the repo's .github/vanguard-skills into every run ([#515](https://github.com/SebaBoler/vanguard/issues/515)) ([6fbbc39](https://github.com/SebaBoler/vanguard/commit/6fbbc39364758a21fd76bafc997e8f4b8bccafef))


### Bug Fixes

* **desktop:** run-record types from src/wire.ts, diffOmitted and visualProof in the UI, RemoteRun.cached on the hub ([#505](https://github.com/SebaBoler/vanguard/issues/505)) ([a4919a5](https://github.com/SebaBoler/vanguard/commit/a4919a5c29813105a6ec547dd128908e5c5a6629)), closes [#492](https://github.com/SebaBoler/vanguard/issues/492)
* **hub:** api_create_task runs validateCreateTask; one core-method table behind both dispatchers ([#508](https://github.com/SebaBoler/vanguard/issues/508)) ([d59785e](https://github.com/SebaBoler/vanguard/commit/d59785e7180f7bb12927c7dadb0d2331fe04fd31)), closes [#500](https://github.com/SebaBoler/vanguard/issues/500) [#493](https://github.com/SebaBoler/vanguard/issues/493)
* **hub:** same-origin check compares host, not scheme ([#506](https://github.com/SebaBoler/vanguard/issues/506)) ([1ef03d4](https://github.com/SebaBoler/vanguard/commit/1ef03d43129f0a6a94e7669bfa4edc75bd44e579)), closes [#490](https://github.com/SebaBoler/vanguard/issues/490)

### Code Refactoring

* **core:** one run-record store (`src/core/run-store.ts`, `beginRun()` returns a `RunWriter` that owns the run timestamp); `persistStageOutcomes`/`persistRunRecord` stay exported one release as deprecated wrappers (SebaBoler/vanguard[#497](https://github.com/SebaBoler/vanguard/issues/497)) ([#510](https://github.com/SebaBoler/vanguard/issues/510)) ([119fd6e](https://github.com/SebaBoler/vanguard/commit/119fd6e207a386406b4e0fd8c3cab1270cf571f6))

## [1.7.0](https://github.com/SebaBoler/vanguard/compare/v1.6.0...v1.7.0) (2026-10-17)


### Features

* test(hub): browse/rpc tests compare un-realpathed tmp paths and fail on macOS (SebaBoler/vanguard[#477](https://github.com/SebaBoler/vanguard/issues/477)) ([#486](https://github.com/SebaBoler/vanguard/issues/486)) ([4b8aafb](https://github.com/SebaBoler/vanguard/commit/4b8aafb83328f7be1bb70986c30c3534373d93b6))


### Bug Fixes

* **hub:** RPC result envelope + Remote fetch wiring (browser smoke) ([#484](https://github.com/SebaBoler/vanguard/issues/484)) ([c6e9f24](https://github.com/SebaBoler/vanguard/commit/c6e9f2407815c5d8de2c07cebbfae7a4ba1d9789))
* **hub:** run detail shows proof-of-work again: proof.json shares the run timestamp and the reader falls back to the closest earlier proof (SebaBoler/vanguard[#487](https://github.com/SebaBoler/vanguard/issues/487)) ([#488](https://github.com/SebaBoler/vanguard/issues/488)) ([b42d646](https://github.com/SebaBoler/vanguard/commit/b42d6464d472d190efd50c4fed1c0f02fc9d3ee1))
* **hub:** serve the Tauri app icon as the web UI favicon ([#489](https://github.com/SebaBoler/vanguard/issues/489)) ([c02c443](https://github.com/SebaBoler/vanguard/commit/c02c443a626f038731abb48715a85b62b6fd3399))

## [1.6.0](https://github.com/SebaBoler/vanguard/compare/v1.5.0...v1.6.0) (2026-10-17)


### Features

* **ci:** opt-in upload of .vanguard/runs as a workflow artifact ([#481](https://github.com/SebaBoler/vanguard/issues/481)) ([3e9439d](https://github.com/SebaBoler/vanguard/commit/3e9439d8180ea19e6037a59a1d44c28364031cfb))

## [1.5.0](https://github.com/SebaBoler/vanguard/compare/v1.4.2...v1.5.0) (2026-10-17)


### Features

* **hub:** Vanguard Hub slice 1 — `vanguard hub` serves the Inspector screens in a browser over HTTP + SSE against a real `.vanguard/` directory, with a Docker image for self-hosting ([#472](https://github.com/SebaBoler/vanguard/issues/472)): hub modules ([#473](https://github.com/SebaBoler/vanguard/pull/473)) ([35c14b6](https://github.com/SebaBoler/vanguard/commit/35c14b6)), server entrypoint and CLI ([#479](https://github.com/SebaBoler/vanguard/pull/479)) ([0cba718](https://github.com/SebaBoler/vanguard/commit/0cba718)), browser transport and hub-mode UI in `apps/desktop` ([#480](https://github.com/SebaBoler/vanguard/pull/480)) ([fdc2df9](https://github.com/SebaBoler/vanguard/commit/fdc2df9))
* **ci:** write run summary to GITHUB_STEP_SUMMARY ([#469](https://github.com/SebaBoler/vanguard/issues/469)) ([ab83663](https://github.com/SebaBoler/vanguard/commit/ab836633ecb9622ff9edc74b8b2ff0adfed7fdd5))
* **desktop:** pull CI run records into the Inspector ([#470](https://github.com/SebaBoler/vanguard/issues/470)) ([0206248](https://github.com/SebaBoler/vanguard/commit/0206248890f3c5e20c094f6735f6f3be5ed1ecce))
* **metrics:** opt-in OTLP trace export for Langfuse ([#471](https://github.com/SebaBoler/vanguard/issues/471)) ([4e3bd43](https://github.com/SebaBoler/vanguard/commit/4e3bd434a02e4c37cfef206c0becd5f2c9035c3c))


### Bug Fixes

* **run-record:** redact transcripts, drop diff and bundle for secret-blocked runs ([#478](https://github.com/SebaBoler/vanguard/issues/478)) ([cdf79e0](https://github.com/SebaBoler/vanguard/commit/cdf79e0a4f289413d04af2242d7d1c4373f49186))

## [1.4.2](https://github.com/SebaBoler/vanguard/compare/v1.4.1...v1.4.2) (2026-10-15)


### Bug Fixes

* **deps:** clear every open dependabot alert ([#467](https://github.com/SebaBoler/vanguard/issues/467)) ([28442f2](https://github.com/SebaBoler/vanguard/commit/28442f224a796127ed1a885399572143728e525b))

## [1.4.1](https://github.com/SebaBoler/vanguard/compare/v1.4.0...v1.4.1) (2026-10-14)


### Bug Fixes

* **verify:** detect check-types as the typecheck step ([#465](https://github.com/SebaBoler/vanguard/issues/465)) ([2656072](https://github.com/SebaBoler/vanguard/commit/265607230105536a46a73605d181637bb5442c0c))

## [1.4.0](https://github.com/SebaBoler/vanguard/compare/v1.3.0...v1.4.0) (2026-10-13)


### Bug Fixes

* **cli:** watch and doctor reject --fork and --spec-file instead of ignoring them; one parseRunOptions for run and watch ([#459](https://github.com/SebaBoler/vanguard/issues/459)) ([80b3589](https://github.com/SebaBoler/vanguard/commit/80b35893fdf7486911a86ad135dd4788663979ca))
* **watch:** hold a secret-blocked run for a human instead of reverting the claim ([#460](https://github.com/SebaBoler/vanguard/issues/460)) ([2aa7a35](https://github.com/SebaBoler/vanguard/commit/2aa7a35589b84d6eca07c954369c844ee129df94))

## [1.3.0](https://github.com/SebaBoler/vanguard/compare/v1.2.0...v1.3.0) (2026-10-09)


### Features

* --fallback-provider — the implementer retries on another provider when its own fails ([#453](https://github.com/SebaBoler/vanguard/issues/453)) ([474974a](https://github.com/SebaBoler/vanguard/commit/474974a4ba9c091c5a4ad97d2e4f73b251cf64a7))
* Flow editor: project switch discards unsaved flow edits without a confirm (SebaBoler/vanguard[#339](https://github.com/SebaBoler/vanguard/issues/339)) ([#435](https://github.com/SebaBoler/vanguard/issues/435)) ([009c860](https://github.com/SebaBoler/vanguard/commit/009c860610c0fc9d91fc4a88813c7c37189df10a))


### Bug Fixes

* **codex:** pass the prompt on stdin, not argv ([#454](https://github.com/SebaBoler/vanguard/issues/454)) ([9c88b41](https://github.com/SebaBoler/vanguard/commit/9c88b413c1c9974e3cc2cf68f4598d83651fc28c))
* retry the base fetch when a concurrent fetch holds the ref lock ([#434](https://github.com/SebaBoler/vanguard/issues/434)) ([#438](https://github.com/SebaBoler/vanguard/issues/438)) ([026d2ff](https://github.com/SebaBoler/vanguard/commit/026d2ffdee957d047386a10edaf981252a87c6e9))
* **review:** omit generated files from the review diff ([#455](https://github.com/SebaBoler/vanguard/issues/455)) ([f98f1b1](https://github.com/SebaBoler/vanguard/commit/f98f1b123429b3b73faa58a6294b1555619ae2fc))
* **security:** revise-pr scans the revision diff for secrets before commit and push ([#440](https://github.com/SebaBoler/vanguard/issues/440)) ([9d64f06](https://github.com/SebaBoler/vanguard/commit/9d64f069c183f7efa7f9022a0caa7bbe2c66441e))

## [1.2.0](https://github.com/SebaBoler/vanguard/compare/v1.1.1...v1.2.0) (2026-10-08)


### Features

* deps: migrate to execa 10 (SebaBoler/vanguard[#397](https://github.com/SebaBoler/vanguard/issues/397)) ([#432](https://github.com/SebaBoler/vanguard/issues/432)) ([3eb4fa9](https://github.com/SebaBoler/vanguard/commit/3eb4fa9b8fadcffc3856c99b413761abc1db498d))


### Bug Fixes

* cut the task worktree from origin/&lt;base&gt; when it is ahead of the local base ([#429](https://github.com/SebaBoler/vanguard/issues/429)) ([#431](https://github.com/SebaBoler/vanguard/issues/431)) ([50cf147](https://github.com/SebaBoler/vanguard/commit/50cf147736e394a687f40b77262ff53815e5fe02))

## [1.1.1](https://github.com/SebaBoler/vanguard/compare/v1.1.0...v1.1.1) (2026-10-08)


### Bug Fixes

* rebase the task branch onto the remote base before publishing ([#423](https://github.com/SebaBoler/vanguard/issues/423)) ([#426](https://github.com/SebaBoler/vanguard/issues/426)) ([16d70d1](https://github.com/SebaBoler/vanguard/commit/16d70d1918e8a46bf2e9003a16673208c1823217))

## [1.1.0](https://github.com/SebaBoler/vanguard/compare/v1.0.0...v1.1.0) (2026-10-08)


### Features

* --escalate-model — resume the 2nd+ gate repair on a stronger model ([#407](https://github.com/SebaBoler/vanguard/issues/407)) ([5f4dcd9](https://github.com/SebaBoler/vanguard/commit/5f4dcd93faa51c35b2698ed1895b87aa4f9580ff))
* current-generation models — 5.5/Fable 5.1 prices, aliases repointed, alias resolution not a swap ([#417](https://github.com/SebaBoler/vanguard/issues/417)) ([8c37e59](https://github.com/SebaBoler/vanguard/commit/8c37e5952592fc890240a256cd0c7393a51a6a9a))
* decision model as fork scorer and eval judge ([#413](https://github.com/SebaBoler/vanguard/issues/413)) ([f12f011](https://github.com/SebaBoler/vanguard/commit/f12f0117ee2fb3d7bda85adc832bb1200d962409))
* **desktop:** collapsible icon sidebar + shell alignment + single @/ui seam ([#312](https://github.com/SebaBoler/vanguard/issues/312)) ([4cb02fa](https://github.com/SebaBoler/vanguard/commit/4cb02fa4ff4d8c975d233ccd2400a34de2914500))
* **desktop:** Kanban board glow-up + project-color hover + rail collapse fix ([#315](https://github.com/SebaBoler/vanguard/issues/315)) ([7591793](https://github.com/SebaBoler/vanguard/commit/75917934348810229f3346c7f314eb08b17d9177))
* **desktop:** live cost/budget strip on the run viewer ([#317](https://github.com/SebaBoler/vanguard/issues/317)) ([b9bc59e](https://github.com/SebaBoler/vanguard/commit/b9bc59ebccd73c56effa57c7193baf3f613d8dba))
* **desktop:** show in-flight runs as rows in the Runs table, not a card ([#320](https://github.com/SebaBoler/vanguard/issues/320)) ([5ec052a](https://github.com/SebaBoler/vanguard/commit/5ec052a4302a5ad8e9e164f0ffb57ca2f9a1c250))
* Editor chrome: indent guides, bracket matching, status bar (Editor UX 2/7) (SebaBoler/vanguard[#357](https://github.com/SebaBoler/vanguard/issues/357)) ([#365](https://github.com/SebaBoler/vanguard/issues/365)) ([1c04130](https://github.com/SebaBoler/vanguard/commit/1c04130fab0e4ead3cd9b0669a70d6f6ab9873ea))
* Editor interaction: multi-cursor and VSCode keybindings (Editor UX 3/7) (SebaBoler/vanguard[#358](https://github.com/SebaBoler/vanguard/issues/358)) ([#367](https://github.com/SebaBoler/vanguard/issues/367)) ([619ea42](https://github.com/SebaBoler/vanguard/commit/619ea42863b00b2f7eebed7d7a3f3bdcccb7efc3))
* Editor UX upgrade (SebaBoler/vanguard[#352](https://github.com/SebaBoler/vanguard/issues/352)) ([#363](https://github.com/SebaBoler/vanguard/issues/363)) ([0dd0c8c](https://github.com/SebaBoler/vanguard/commit/0dd0c8cc139d6cc69b13b6b1c6657bf0325a6d4d))
* Linear tasks open GitLab MRs; review-mr skips reviewed heads ([#398](https://github.com/SebaBoler/vanguard/issues/398)) ([8cd4eea](https://github.com/SebaBoler/vanguard/commit/8cd4eea99404a1e2a7d98705e7dc971433b4e441))
* log-only difficulty probe via a decision model (Clef / System One API) ([#410](https://github.com/SebaBoler/vanguard/issues/410)) ([d95a353](https://github.com/SebaBoler/vanguard/commit/d95a35352a4be9f41c8a4799fde757f5e789e567))
* **review:** let review-mr and review-pr take --max-turns ([#402](https://github.com/SebaBoler/vanguard/issues/402)) ([39e503c](https://github.com/SebaBoler/vanguard/commit/39e503cbf0a1d66b89e4bbe186fbba7a28266386))
* **s10:** task drafts — the Docs page dies, authoring becomes task-first ([#349](https://github.com/SebaBoler/vanguard/issues/349)) ([f682b78](https://github.com/SebaBoler/vanguard/commit/f682b7828f1aa50dbf3bab08fef7745be230b5fd))
* **s4.3:** create a task from a doc — the app's first irreversible write ([#335](https://github.com/SebaBoler/vanguard/issues/335)) ([9c8050a](https://github.com/SebaBoler/vanguard/commit/9c8050a7d54c8ca16a214cf953d781b19f0ad945))
* **s5.1:** flows go live — .vanguard/flows/*.hcl discoverable, runnable, writable ([#336](https://github.com/SebaBoler/vanguard/issues/336)) ([d4272a2](https://github.com/SebaBoler/vanguard/commit/d4272a23b3bc3f7a79453aa95ccab84696970ef9))
* **s5.2:** visual flow editor — Workflow screen reads and writes real flow HCL ([#338](https://github.com/SebaBoler/vanguard/issues/338)) ([6ab753e](https://github.com/SebaBoler/vanguard/commit/6ab753e3686b641aa8b8f76d8fe82c00cb639b92))
* **s6.1:** custom providers go live — repo-configured Anthropic-compatible endpoints ([#340](https://github.com/SebaBoler/vanguard/issues/340)) ([89320fe](https://github.com/SebaBoler/vanguard/commit/89320fe0821a45852d840c39dc32935def39eaed))
* **s6.2:** custom providers in the app — NewRunForm merge, Settings editor, config data-safety ([#341](https://github.com/SebaBoler/vanguard/issues/341)) ([b93b195](https://github.com/SebaBoler/vanguard/commit/b93b19513272611ed973efb048ba43db87f5eb8f))
* **s7:** shared-types seam — one generated wire contract, mirror class deleted ([#342](https://github.com/SebaBoler/vanguard/issues/342)) ([828fe3c](https://github.com/SebaBoler/vanguard/commit/828fe3c168c5a41ab3d199c91d141e9d6503f374))
* **s8.1:** hygiene bundle — double-scroll, drag cancel, input feedback, strip bleed, nav guard ([#339](https://github.com/SebaBoler/vanguard/issues/339)) ([#343](https://github.com/SebaBoler/vanguard/issues/343)) ([62c4fbe](https://github.com/SebaBoler/vanguard/commit/62c4fbe2e1f941769821b3e732800892094e7f62))
* **s8.2:** in-app flow rename + delete (additive deleteFlow method) ([#345](https://github.com/SebaBoler/vanguard/issues/345)) ([fac70ff](https://github.com/SebaBoler/vanguard/commit/fac70ff001b3228f6df885ec9e6febcba0a39067))
* **s9.1:** board read path in core — listTasks/fetchSpec sidecar methods ([#346](https://github.com/SebaBoler/vanguard/issues/346)) ([45ea16a](https://github.com/SebaBoler/vanguard/commit/45ea16a1f631ab2c9969ecb19e13aad0c49b25fe))
* **s9.2:** the Rust board dies — one brain ([#348](https://github.com/SebaBoler/vanguard/issues/348)) ([5ca0227](https://github.com/SebaBoler/vanguard/commit/5ca02278a459ceb56ff919d945ca386f9948e670))
* **sidecar:** give short calls their own pipe; keep cancel pointed at the run child ([#334](https://github.com/SebaBoler/vanguard/issues/334)) ([69162fb](https://github.com/SebaBoler/vanguard/commit/69162fbfeaf095dbc7084230e5b408f0b18da293))
* **spec:** --base flag + auto-fetch origin baseline for the spec pass ([#311](https://github.com/SebaBoler/vanguard/issues/311)) ([5936a56](https://github.com/SebaBoler/vanguard/commit/5936a56f58f1f374c9438ba2a51bb92c361f8828))
* **task-page:** full-page editor with a tabbed chat drawer ([#350](https://github.com/SebaBoler/vanguard/issues/350)) ([24d0122](https://github.com/SebaBoler/vanguard/commit/24d012263c577e28453bdad99890c5b04884a8b9))
* vanguard metrics push + stats --branch — durable run metrics on an orphan branch ([#419](https://github.com/SebaBoler/vanguard/issues/419)) ([e8c76ef](https://github.com/SebaBoler/vanguard/commit/e8c76efe7c742a79638b7a8af592361db37b4b9a))
* vanguard:model=&lt;m&gt; issue label pins the implementer model per task ([#409](https://github.com/SebaBoler/vanguard/issues/409)) ([16f7481](https://github.com/SebaBoler/vanguard/commit/16f7481ef5d35895addb98a55c07dd2554589d21))
* **watch:** add --spec-only to run the loop-v1 spec pass alone ([#400](https://github.com/SebaBoler/vanguard/issues/400)) ([0155ebc](https://github.com/SebaBoler/vanguard/commit/0155ebc14a76c124d52042d80e6e3c3cd9003eae))


### Bug Fixes

* codex/cursor-only review needs no Anthropic credential; log why a watched item failed ([#422](https://github.com/SebaBoler/vanguard/issues/422)) ([abe3256](https://github.com/SebaBoler/vanguard/commit/abe3256e46512ccadf8061d45ae1b92031cf48d9))
* **desktop:** default runs to claude, drop dead zai/--llm-proxy hardcode ([#321](https://github.com/SebaBoler/vanguard/issues/321)) ([57d0669](https://github.com/SebaBoler/vanguard/commit/57d06694a7ecc7bc76f5c415c31bf9cd6220339e))
* **desktop:** Fleet watch-loop toggle falsely reads 'stopped' after navigating away (SebaBoler/vanguard[#318](https://github.com/SebaBoler/vanguard/issues/318)) ([#319](https://github.com/SebaBoler/vanguard/issues/319)) ([4d14e2b](https://github.com/SebaBoler/vanguard/commit/4d14e2bc9804547853b06a58e0f7a76fe576c731))
* **dogfood:** proxy EPIPE crash-loop killed run [#352](https://github.com/SebaBoler/vanguard/issues/352) again; live-run strip trapped the Runs page ([#354](https://github.com/SebaBoler/vanguard/issues/354)) ([e016ec0](https://github.com/SebaBoler/vanguard/commit/e016ec07b26bf6aa53d7489f6c9dd35ad8d98a38))
* fail fast when every assistant turn is a synthetic API error ([#392](https://github.com/SebaBoler/vanguard/issues/392)) ([eed565a](https://github.com/SebaBoler/vanguard/commit/eed565a82a478068a490933f21b837c3857a6b4b))
* follow-ups from the last [#398](https://github.com/SebaBoler/vanguard/issues/398) review ([#399](https://github.com/SebaBoler/vanguard/issues/399)) ([2315cfa](https://github.com/SebaBoler/vanguard/commit/2315cfa4b8879b9d6dea41e6784e449c602bee7d))
* gate runs on the pinned sandbox claude CLI, add doctor --fix ([#393](https://github.com/SebaBoler/vanguard/issues/393)) ([70729db](https://github.com/SebaBoler/vanguard/commit/70729db40875d1bcc21c2e5bdc61b858147c6cb1))
* keep truncations visible after repair, annotate gateway swaps in stats, map Claude aliases on openrouter ([#406](https://github.com/SebaBoler/vanguard/issues/406)) ([6d37155](https://github.com/SebaBoler/vanguard/commit/6d37155ac7b1aef9eace5279efa4829b45db3bcc))
* **linear:** list over GraphQL — `vanguard watch --linear` was broken on every poll ([#333](https://github.com/SebaBoler/vanguard/issues/333)) ([4203660](https://github.com/SebaBoler/vanguard/commit/4203660d382f60a15c44624ab225dd705db50544))
* log a self-contradicting review verdict (clean verdict, high finding) ([#412](https://github.com/SebaBoler/vanguard/issues/412)) ([48a485c](https://github.com/SebaBoler/vanguard/commit/48a485c0b44d593fa7a9c4ff6b8627ed8e71c337))
* loop-v1 spec pass researches against --base ([#401](https://github.com/SebaBoler/vanguard/issues/401)) ([e50d60b](https://github.com/SebaBoler/vanguard/commit/e50d60b237d37902a457b2704979fac3b33a862e))
* **pipeline:** an incomplete implementer fails the quality gate — no more residue PRs ([#356](https://github.com/SebaBoler/vanguard/issues/356)) ([d83c3d7](https://github.com/SebaBoler/vanguard/commit/d83c3d7a80b52aea3623e97d0c91f4805a0930aa))
* **pr-review:** failed reviews retry instead of posing as success; pin event PR past stale label scan ([#344](https://github.com/SebaBoler/vanguard/issues/344)) ([727a00a](https://github.com/SebaBoler/vanguard/commit/727a00a074f2dd660c344a1c9ce8a78d71b86b9a))
* review verdict first — accept a stated verdict without the completion signal, stop calling small diffs too large ([#411](https://github.com/SebaBoler/vanguard/issues/411)) ([a23f663](https://github.com/SebaBoler/vanguard/commit/a23f66345479e377c4d371496579616892d6af1a))
* route repair loops on the implementer model, keep all-attempt cost, stats by model ([#404](https://github.com/SebaBoler/vanguard/issues/404)) ([45975c1](https://github.com/SebaBoler/vanguard/commit/45975c11bf167d5ead1c779581f76367fe5b66cf))
* **sandbox:** coerce undefined execa streams in ExecResult ([#382](https://github.com/SebaBoler/vanguard/issues/382)) ([194bb6f](https://github.com/SebaBoler/vanguard/commit/194bb6fb808404a48e9da4259a1f1a41276547ca))
* **sandbox:** supervise the egress proxy — proxy death bricked run [#352](https://github.com/SebaBoler/vanguard/issues/352) ([#353](https://github.com/SebaBoler/vanguard/issues/353)) ([6ba7c86](https://github.com/SebaBoler/vanguard/commit/6ba7c860e7c4a83746a4709041d71de4e089d797))
* **spec:** resume incomplete tech-spec, keep text on empty result ([#380](https://github.com/SebaBoler/vanguard/issues/380)) ([39bd9d5](https://github.com/SebaBoler/vanguard/commit/39bd9d517eb06b8b743a638b30428dfdcd2982f6))
* **spec:** tech-spec turn cap 15→30, wire --max-turns, planner 10→15 ([#347](https://github.com/SebaBoler/vanguard/issues/347)) ([a61940d](https://github.com/SebaBoler/vanguard/commit/a61940d3426e106b745dc1a77c95f999459e2d21))
* **task-page:** dogfood r3 — unbreak doc chat, split conversation/doc naming into InlineEdits ([#351](https://github.com/SebaBoler/vanguard/issues/351)) ([e68db34](https://github.com/SebaBoler/vanguard/commit/e68db34f83aa0056150479aa1ab8d06c021612a2))
* **watch:** carry the stack into failure comments ([#381](https://github.com/SebaBoler/vanguard/issues/381)) ([5ea9006](https://github.com/SebaBoler/vanguard/commit/5ea900634a756e0f353106b0456217d22d853851))
