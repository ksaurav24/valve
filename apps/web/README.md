# valve website

One statically exported Next.js app. Marketing pages use shadcn/ui with
[Fluid Functionalism](https://www.fluidfunctionalism.com/) components (Base UI
flavor); `/docs` uses Fumadocs. Both read the same theme tokens. Dark is the
default theme.

| URL               | Purpose                                  | Source                                  |
| ----------------- | ---------------------------------------- | --------------------------------------- |
| `/`               | Install, features, usage, recent changes | `app/(marketing)/page.tsx`              |
| `/docs`           | Guides and reference                     | `content/docs/*.mdx` and subdirectories |
| `/changelog`      | Every recorded package change            | `packages/valve/CHANGELOG.md`           |
| `/releases`       | Versions npm lists, with release notes   | CHANGELOG + npm + GitHub Releases       |
| `/contributors`   | Contributors and the contribution guide  | GitHub API + root `CONTRIBUTING.md`     |
| `/api/index.html` | Generated TypeDoc declarations           | Generated during the build              |

## Work locally

From the repository root:

```sh
pnpm docs:dev
pnpm --filter @valve/web typecheck
pnpm --filter @valve/web test
pnpm docs:build
pnpm --filter @valve/web test:browser
```

The dev server and static preview use `http://127.0.0.1:4321`. The build
writes deployable files to `apps/web/out`. Hosting needs no Node.js server.

## Data and sources of truth

Nothing in this app hardcodes a version, star count, or contributor list.

- `scripts/sync-content.mjs` copies the version from
  `packages/valve/package.json` into `.generated/release.json`, the package
  changelog into `content/changelog/` (and parsed entries into
  `.generated/changelog.json`), and the root `CONTRIBUTING.md` into
  `content/contributing/`. All outputs are gitignored. Edit the sources.
- `scripts/sync-metadata.mjs` fetches the npm packument, stars, contributors,
  and GitHub Releases into `.generated/metadata.json`. Set `GITHUB_TOKEN` to
  raise the API limit. Failed or suspicious answers (errors, rate limits, a
  zero or empty answer when the snapshot has data) keep the committed
  snapshot in `content/data/metadata.json`, so API failures never break a
  build. Refresh the committed fallback explicitly with
  `pnpm --filter @valve/web sync:snapshot`; version PRs do not refresh it.
- `lib/releases.ts` treats a version as released only when npm lists it.
  Other changelog entries are development versions: they appear on
  `/changelog`, never on `/releases`. In MDX, wrap text in `<Unpublished>` or
  `<Published>` when it depends on that state. Published beta versions display a
  `beta` badge even if npm's `latest` tag happens to point at a prerelease. Stable
  `latest` and `beta` metadata remain separate; install commands follow the
  package's configured npm tag (`valvejs@beta` during the beta series).
- The navigation star count refreshes in the browser with SWR against the
  public GitHub API, cached for an hour in `localStorage`, falling back to the
  build value. No token reaches the browser.

Run both syncs with `pnpm --filter @valve/web sync`. The merge rules live in
`scripts/merge-metadata.mjs` and are covered by `pnpm --filter @valve/web test`.

## Releases and rebuilds

Merging a version PR runs the publish jobs in `.github/workflows/version.yml`:
npm trusted publishing, then the git tag and GitHub Release. Beta versions use
`0.3.0-beta.N`, the npm `beta` tag, and GitHub prereleases named
`valvejs@0.3.0-beta.N`. If the
`VERCEL_DEPLOY_HOOK` secret exists, the workflow then triggers a rebuild so
`/releases` picks up the new npm data. Pushes to `master` rebuild through the
host's Git integration.

## Components and motion

`components/ui` holds registry components; add more with
`pnpm dlx shadcn@latest add https://www.fluidfunctionalism.com/r/base/<name>.json`
(use the `base/` path, or a plain path for primitive-free components). The
registry may add the unrelated `cn` npm package; keep `lib/utils.ts` on `clsx`
and `tailwind-merge`.

Motion follows `lib/springs.ts`: button feedback 120ms, dropdowns, popovers,
and tab indicators 180ms. Pages have no entrance animation. `MotionConfig`
and a CSS media query honor `prefers-reduced-motion`. No parallax, scroll
hijacking, or WebGL.

## Add documentation

Create an MDX file in `content/docs` with a `title` and `description` in
frontmatter, and add it to the directory's `meta.json`. Use `/docs/...` for
documentation links and `/api/...` for the TypeDoc reference.

## Enable the blog later

The blog has no route. The empty `content/blog` collection and page scaffolds
in `scaffolds/blog` remain: move `scaffolds/blog/index.tsx` to
`app/(marketing)/blog/page.tsx` and `scaffolds/blog/article.tsx` to
`app/(marketing)/blog/[slug]/page.tsx`, add posts, then add `blog` to
`lib/nav.ts`.

## Preserve old links

`app/[...slug]/page.tsx` exports a client redirect for each former docs URL,
keeping query strings and anchors. These pages are `noindex`. On a host with
HTTP redirects, add permanent redirects for former docs paths to `/docs`,
excluding `/`, `/changelog`, `/releases`, `/contributors`, and `/api`.
