# Removal justification and dependency verification

Baseline: valvejs **0.6.0**, commit `4803503b533b70de62f42e604c087ba68df39f66`.
Implementation reviewed: `26ef07c` (the cleanup and baseline clarification).
This document covers every removed implementation, helper, dependency and
redundant branch in PR #115.

## How dependencies were checked

The baseline was extracted with `git archive 4803503`, so references were checked
before deletion as well as afterward. The baseline has 443 tracked files,
including 322 JavaScript, TypeScript, JSX and MDX files. Import analysis covered
static imports, re-exports, literal `import()` and `require()` calls, relative
paths and the website's `@/*` alias. Repository-wide searches additionally
covered configuration, scripts, documentation, route discovery and CSS.

TypeScript's language service resolved references to the removed unused named symbols
in the baseline website and performance projects. Each had **zero references
outside its defining module**. Within those modules, references were limited to
declarations, exports, display names or the equally unused hover helper. As a
positive control, the same analysis correctly found the live `TabsSubtleItem`
imports in `components/marketing/code-tabs.tsx` and `install-cli.tsx`.

No computed module loader or framework convention was found that loads the
deleted files. They are not Next route files, generated content inputs or
published package entry points. Both the website and performance workspace are
private packages without public module export maps. The library's package
manifest and all three public entry modules are unchanged.

## Unused modules and symbols

1. **`apps/web/components/ui/card.tsx`:** zero inbound module imports in the
   baseline. It has no route, barrel, script or MDX consumer. Documentation's
   `<Card>` is a different implementation: `mdx-components.tsx` spreads
   `fumadocs-ui/mdx`, whose installed `dist/mdx.js` imports and exposes `Card`
   from Fumadocs' own `components/card.js`. The docs route passes this mapping
   to MDX. Removing the local module does not remove documentation cards.

2. **`apps/web/components/ui/button.tsx`:** zero inbound module imports. Native
   buttons and the primitives used by active dropdowns/tabs are independent.
   The local `Button`, variant builder and its types were not used by the app.

3. **`apps/web/components/ui/badge.tsx`:** zero inbound module imports. None of
   its badge components, variant builders, color maps or types was imported by
   another module. The active version badge is a separate shared component.

4. **`apps/web/components/ui/tooltip.tsx`:** zero inbound module imports. Its
   tooltip, provider, portal wrapper and prop types had no consumers. Tooltips
   supplied internally by Fumadocs do not import this application module.

5. **`TabsSubtlePanel` and `TabsSubtlePanelProps`:** zero outside references;
   baseline references are the declaration, prop annotation, display name and
   export. Actual panels are rendered directly by `code-tabs.tsx` and
   `install-cli.tsx` with `role="tabpanel"`. Their IDs and tab relationships
   remain. `TabsSubtle` and `TabsSubtleItem` remain.

6. **`nestedRadius`:** only its declaration and export existed. No call used its
   calculation. The shape maps, provider and hooks used by active components
   remain.

7. **`surfaceHoverClasses`, `SURFACE_HOVER_BG`, `SURFACE_HOVER_SHADOW`:** the
   function had no caller. Each map's only read was inside that unused function.
   Removing the three together leaves no reference behind. Active
   `surfaceClasses`, `SURFACE_BG` and `SURFACE_SHADOW` remain.

8. **`POPUP_NAV_KEYS`:** the baseline contained its declaration only. No handler
   read this list. Active keyboard handlers and Base UI primitives were not
   removed or redirected.

9. **`latestPublished`:** the baseline contained only the alias declaration
   `npm.latest`. Release filtering, `versionState`, the npm metadata object and
   `current` remain. No consumer was changed to a fallback value.

10. **`consoleSummary`:** its only baseline reference was its own declaration in
    private performance code. Active output uses `tiers/run.ts`'s logger and
    `writeReports`; it never called this formatter. The removed `safetyText`
    import was used only by the removed formatter; `safetyText` itself remains.

11. **`decisionPlan`:** its only baseline reference was its declaration. Active
    planning already constructs `decision: { metrics, looks, alpha: def.alpha }`
    in `tiers/run.ts`. The now-unused `DecisionPlan` type import was removed
    only from `plan/profiles.ts`; the shared type itself remains.

12. **`coversAllPairs`:** its only baseline reference was its declaration. No
    production path or test called it. The active `pairwise` generator and its
    caller in `plan/suites.ts` remain. There was no dedicated pairwise test to
    remove; the earlier audit wording implying such a test was corrected.

13. **Direct `class-variance-authority` dependency:** exactly two baseline
    application imports existed, both in the deleted button and badge modules.
    Its lockfile entries were retained because `fumadocs-ui` still requires it
    transitively. `pnpm --filter @valve/web why class-variance-authority` confirms
    that dependency chain. Only the unnecessary direct dependency was removed.

14. **Unused simulation parameter `w`:** the mapping callback reads only its
    index. Renaming the unused binding to `_` does not alter its input, output,
    random draws, worker count or scheduling logic.

## Implementations replaced by existing equivalents

15. **Local Monte Carlo RNG body:** this was not unused functionality. The
    caller now uses `core/rng.ts`'s existing `mulberry32(seed)`, which has the same
    unsigned 32-bit state update, integer multiplication, xor shifts and
    denominator (`2 ** 32` equals `4294967296`). Seed handling, draw order and
    sign-flip iteration counts are unchanged. The added fixed-result assertion
    preserves the pre-change Monte Carlo result `0.13979301034948252`.

16. **Duplicate scoped-test `job` builder:** both definitions returned
    `{ cost, scopes: { recipient } }` with a default cost of one. The definition
    in `scoped-cases.ts` is now exported and imported by `scoped.test.ts`.
    Fixture callers and test callers use that one implementation; no caller was
    deleted. This helper is test code, not a library export.

17. **Immutable admission request object:** the removed branch duplicated
    `context()`'s ID, rules and global lease fields. `pump()` now calls
    `context()` once and adds `costs`. Immutable valves do not populate the
    managed `limits` cache, so they gain no `known` field. The global lease
    owner still increments `leaseSequence` once per admission request. Scoped
    requests reuse that same lease rather than constructing another one.

## Redundant checks and branches

These removals have callers. Their justification is equivalent behavior, not
an assertion that nobody used the admission paths.

18. **Repeated `precise` checks:** `memory-store.ts`'s `resolve()` still validates
    every authoritative rule before returning. `managedBatch` has only two
    call sites: `managedAcquireSync` and `managedScopedSync`, both after
    `resolve()` using the same `now` and the resolved frames. Admission mutates
    copied usage state, not the frames. The removed scoped and per-job checks
    therefore repeated the same predicate. The boundary check and the separate
    proposed-limit check in `applyPatch()` remain.

19. **Duplicate largest-burst assignment:** the former GCRA rate-change branch
    assigned `ub = max(ub, burst)` and the following statement repeated it.
    One assignment now precedes the branch. `rebase()` reads time and precision
    fields, not `ub`; expiry's `sw` calculation still uses the new maximum.
    The operation is idempotent and matches the Lua patch path.

20. **Impossible-cost retry resets:** both the TypeScript and static Lua loops
    set retry to zero before checking job capacity. A capacity failure sets
    `impossible` and breaks before any retry calculation. Returning the existing
    zero gives the same result as resetting it again afterward. Lease rejection
    branches do not set `impossible`, so their positive retry remains intact.

21. **Lua scoped loop's empty impossible branch:** an impossible job previously
    traversed references and loaded local table values, then executed an empty
    branch for each. The loop now runs only when the job is possible. The
    skipped section made no Redis calls or state changes for impossible jobs.
    Pause/lease precedence and the following rejection decisions remain.

22. **Generated Lua text and SHA:** `redis/scripts.ts` is regenerated by
    `scripts/lua-sha.mjs`, not edited as a separate implementation. Its changed
    managed script and digest represent the reviewed Lua changes. The other
    script constants and hashes remain unchanged.

Removed explanatory comments, prop types and imports belong to the removed
implementations above. No test case, fixture, rate algorithm, lease capability
or public library type was removed.

## API and execution evidence

- Built baseline and head with the same installed toolchain. All **10** generated
  `.d.ts` and `.d.cts` files, including shared declarations, are byte-identical.
- Loaded both builds and compared runtime export names for core, Redis and
  headers in both ESM and CommonJS. All six export sets match.
- The focused recheck passed **221 library tests** covering managed precision,
  patch histories, scoped admission, global leases and scheduling, plus
  **41 performance statistics and CLI tests**. The full-suite, Redis parity,
  build and browser results are recorded in `unslopifying.md`.
- The prior independent differential review matched 8,000 baseline/current state
  transitions and 10 seeded statistical samples. A fresh removal review checks
  the source-level proofs separately from those sampled executions.

Representative searches that can be rerun from the repository root:

```sh
git grep -n -E 'TabsSubtlePanel|nestedRadius|surfaceHoverClasses|SURFACE_HOVER_BG|SURFACE_HOVER_SHADOW|POPUP_NAV_KEYS|latestPublished|consoleSummary|decisionPlan|coversAllPairs' 4803503 -- ':!pnpm-lock.yaml'
git grep -n 'class-variance-authority' 4803503 -- apps/web ':!pnpm-lock.yaml'
git diff 4803503 HEAD -- packages/valve/package.json packages/valve/src/index.ts packages/valve/src/redis/index.ts packages/valve/src/headers/index.ts packages/valve/tsdown.config.ts
pnpm --filter @valve/web why class-variance-authority
```

## Verification boundary

No remaining tracked repository consumer or supported published API was found
to depend on the deleted implementations. Unknown external imports of private
application or benchmark source files are outside the published contract and
cannot be enumerated from this repository. Type checking and sampled tests do
not prove equivalence for every possible input; the branch and caller reasoning
above supplies the justification for each behavior-preserving simplification.
