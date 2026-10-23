# Unslopifying audit

Baseline: `origin/master` at `4803503b533b70de62f42e604c087ba68df39f66`.
The library version at this baseline is **valvejs 0.6.0**, including its managed
runtime quota implementation. Older versions appear only in release history.
The audit used a clean worktree, excluding the original checkout's local edits.

## Scope and method

- Reviewed the published library, memory and Redis/Lua backends, unit and
  integration tests, private performance harness, website, examples, root
  tooling, release scripts and CI workflows.
- Traced imports and callers across the repository, including MDX bindings,
  framework entry points, worker subprocesses and documented dormant scaffolds.
  An exported symbol with no local caller is not automatically dead public API.
- Ran TypeScript with `noUnusedLocals`, `noUnusedParameters` and
  `allowUnreachableCode: false` for the library, performance harness and website.
  The website had one unused callback parameter; the other two projects passed.
- Compared parsed function bodies with identifiers normalized to find clones,
  then inspected candidates for semantic differences. Similar token sequences
  alone do not establish interchangeable behavior.
- Used delegated reviews for core, website/tooling, tests and performance code,
  then verified actionable findings against callers. A second website review
  corrected the first review's mistaken conclusion that no UI files were unused.
  Requested Opus 5.5 medium and Haiku reviews on Claude Second account failed
  with an API rate limit; Codex reviews supplied the remaining evidence.
- This worktree had no `.codegraph/` index. No index was created, and generated
  files, dependencies and archived research were excluded from clone analysis.

## Changes made

### Dead website code

- Deleted the unreferenced registry `card`, `button`, `badge` and `tooltip`
  modules. No app route, MDX mapping, script or blog scaffold imported them.
  Documentation's `<Card>` comes from `fumadocs-ui/mdx`, so its styles remain.
- Removed the site's direct `class-variance-authority` dependency: only the
  deleted button and badge imported it. Its transitive lockfile entries remain
  where other dependencies still require them.
- Removed unused `TabsSubtlePanel`, `nestedRadius`, `surfaceHoverClasses` and
  its hover lookup tables, `POPUP_NAV_KEYS`, and `latestPublished`.
- Dropped the unused worker binding in the deterministic hero simulation.

### Redundant library work

- Reused the admission context builder for immutable and managed requests,
  including global lease ownership. Each admission still increments the lease
  sequence once.
- Retained all managed numeric precision checks. An attempted removal of the
  scoped and per-batch guards was reverted after the follow-up review reproduced
  a public request getter changing authoritative limits after `resolve()`.
  A regression test now preserves the baseline rejection behavior.
- Assigned the largest configured burst once when applying a patch. The expiry
  calculation still sees the updated maximum, matching the Lua implementation.
- Removed impossible-cost retry resets already guaranteed by the loop's initial
  reset. Skipped the scoped Lua retry loop entirely for impossible jobs, keeping
  pause and lease precedence unchanged.
- Regenerated the shipped Lua and SHA1 digest through the package build. Added
  a patch changeset and regenerated website content through its sync command.

### Duplicate and unused helpers

- Reused the performance harness's `mulberry32` for Monte Carlo sign-flip tests.
  A fixed historical result checks that the seeded sequence is preserved.
- Reused the scoped fixture's identical `job` builder in the scoped unit tests.
- Removed private performance exports with no callers anywhere in the repository:
  `consoleSummary`, `decisionPlan`, and `coversAllPairs`. Their active console
  reporting, decision-plan construction and pairwise generation remain.

## Remaining findings and decisions

- **Registry UI customization:** unused shape/icon providers, setter hooks and
  optional dropdown APIs remain in otherwise active registry modules. A focused
  simplification could remove that flexibility, with dedicated focus, ref and
  popup lifecycle coverage. This PR removes isolated dead modules and helpers.
- **Ref and focus clones:** accordion, dropdown, menu-item and tabs contain
  repeated ref forwarding and focus-index discovery. Some also reset different
  hover state or register different primitives. Consolidate only after specifying
  React ref cleanup and keyboard behavior; a token clone is not that contract.
- **Scoped fingerprint overhead:** `prepareScoped(request, true)` constructs an
  immutable fingerprint its managed callers discard. Keep separate validation
  caches; a future split should make the managed/immutable return contract
  explicit rather than introduce a sentinel fingerprint.
- **Repeated percentile sorting:** `startTimeSummary` sorts started waits for
  conditional percentiles and again for each `failureRanked` query. A batch
  quantile interface could share sorting. No profiling was performed here, and
  percentile conventions and validation should stay consistent.
- **Test-only statistics:** Kaplan-Meier, Benjamini-Hochberg and MDE helpers have
  reference-fixture tests but no active reporting callers. Retained with their
  scientific fixtures; decide whether these belong in test support or a future
  analysis interface before deleting them.
- **Intentional duplication:** the browser hero and private harness both use
  Mulberry32. Sharing it would couple the website to benchmark internals. The
  tiny deferred-promise helpers in unit and fault-injection suites likewise do
  not justify a shared test framework.
- **Backend differences:** immutable/managed and static/scoped admission share
  structure but differ in precision, expiry, impossible-cost handling and timing.
  The independent performance model and Lua implementation are parity oracles,
  not candidates for delegating their math to the implementation under test.
- **Dormant blog:** the unrouted blog scaffolds and collection are explicitly
  documented in `apps/web/README.md`. Kept as intentional dormant functionality.
- **Public API:** package entry points, store capabilities, headers and declared
  types remain supported even when this repository has no internal consumer.
  No additional unused dependency or whole library module was verified.

## Verification

Use Node 24.21.0 (the default shell's Node 24.5.0 is too old for the locked
build tooling). Commands are run from the repository root:

- `pnpm lint` and `pnpm typecheck`
- `pnpm test:coverage` and `pnpm test:types`
- `pnpm --filter @valve/perf test`
- `node --test scripts/*.test.mjs`
- `pnpm --filter @valve/web test`, `pnpm --filter @valve/web sync` and
  `pnpm docs:build`
- `REDIS_URL=redis://127.0.0.1:16479 pnpm test:integration` against an isolated
  disposable Redis 7.4 container

All checks above passed: 510 library tests, 5 type tests, 221 performance tests,
28 tooling tests, 26 website tests, and 94 Redis integration tests. The performance
suite skipped one external archive check; the integration suite skipped 12 tests
requiring a Redis Cluster endpoint or a local Redis server binary.

The independent Redis model parity suite also passed all 16 tests. All 32 website
browser tests passed on desktop and mobile, including the homepage changelog and
published release ordering. The default Playwright browser was unavailable, so
the existing Chromium 154 executable was supplied through a temporary external
config; no browser configuration change is included in the PR. Generated
changelog order was also checked against the package notes, including grouped
historical previews.

Source conventions, package publishing checks and bundle-size budgets passed.
The website rebuild passed on retry; Next.js reported an advisory for the
existing 16.4.0 dependency. That dependency was not changed by this cleanup.
The initial differential review matched 8,000 baseline/current state transitions
plus 10 seeded statistical samples. A subsequent targeted review found the
request-getter counterexample missed by those samples; the precision guards
were restored and the counterexample was added as a regression test.

This audit is evidence for the listed findings, not proof that every possible
dead branch or future maintenance issue has been eliminated.
