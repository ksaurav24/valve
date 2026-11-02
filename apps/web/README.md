# valve website

One statically exported Next.js app. Marketing pages use shadcn/ui with
[Fluid Functionalism](https://www.fluidfunctionalism.com/) components (Base UI
flavor); `/docs` uses Fumadocs. Both read the same theme tokens. Dark is the
default theme.

| URL               | Purpose                                  | Source                                      |
| ----------------- | ---------------------------------------- | ------------------------------------------- |
| `/`               | Install, features, usage, recent changes | `app/(marketing)/page.tsx`                  |
| `/docs`           | Guides and reference                     | `content/docs/*.mdx` and subdirectories     |
| `/articles`       | Article index and individual articles    | `content/articles/*.mdx` and subdirectories |
| `/changelog`      | Changes for plain-numbered versions      | `packages/valve/CHANGELOG.md`               |
| `/releases`       | Versions npm lists, with release notes   | CHANGELOG + npm + GitHub Releases           |
| `/contributors`   | Contributors and the contribution guide  | GitHub API + root `CONTRIBUTING.md`         |
| `/api/index.html` | Generated TypeDoc declarations           | Generated during the build                  |

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

Nothing in this app hardcodes a version, star count, download count, or contributor list.

- `scripts/sync-content.mjs` copies the version from
  `packages/valve/package.json` into `.generated/release.json`, the package
  changelog’s plain-version entries into `content/changelog/` (and parsed
  entries into `.generated/changelog.json`), and the root `CONTRIBUTING.md` into
  `content/contributing/`. All outputs are gitignored. Edit the sources.
- `scripts/sync-metadata.mjs` fetches the npm packument, download count, stars, contributors,
  and GitHub Releases into `.generated/metadata.json`. Set `GITHUB_TOKEN` to
  raise the API limit. Failed or suspicious answers (errors, rate limits, a
  zero or empty answer when the snapshot has data) keep the committed
  snapshot in `content/data/metadata.json`, so API failures never break a
  build. Refresh the committed fallback explicitly with
  `pnpm --filter @valve/web sync:snapshot`; version PRs do not refresh it.
- `lib/releases.ts` treats a version as released only when npm lists it.
  Other changelog entries are development versions: they appear on
  `/changelog`, never on `/releases`. In MDX, wrap text in `<Unpublished>` or
  `<Published>` when it depends on that state. Publication labels (`latest`,
  `published`, `historical notes`, or `dev · unreleased`) come from npm. A separate `beta` label
  describes API maturity for all 0.x versions, independently of publication.
  Install commands use the unqualified package name, `valvejs`.
- The navigation star count refreshes in the browser with SWR against the
  public GitHub API, cached for an hour in `localStorage`, falling back to the
  build value. No token reaches the browser.
- The npm counter links to the package and counts downloads in the last 30
  available days. It refreshes with SWR against npm's public downloads API,
  with requests deduplicated for an hour. Failed requests keep the build value;
  a valid zero replaces an older count. npm updates statistics daily, so a new
  package may show `-` until data is available. No count is invented for a 404.

Run both syncs with `pnpm --filter @valve/web sync`. The merge rules live in
`scripts/merge-metadata.mjs` and are covered by `pnpm --filter @valve/web test`.

## Releases and rebuilds

Merging a version PR runs the publish jobs in `.github/workflows/version.yml`:
npm trusted publishing, then the git tag and GitHub Release. Versions use
plain `x.y.z` numbers and npm's default `latest` channel. GitHub releases are
named `valvejs@x.y.z` and are ordinary releases; beta is the project's maturity
label until 1.0, rather than a prerelease suffix or separate install channel.
The website groups preview-only series under plain version headings on
`/changelog` and the homepage, marked as historical notes. Once a plain release
has its own changelog entry, that entry replaces the preview series in these
lists. `/releases` includes only versions actually published to npm. Original
build names and notes remain in the full package changelog and on GitHub. If the
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

## Add articles

Articles use MDX and the same code highlighting and components as the docs.
Follow the [engineering article checklist](editorial/STYLE.md) for voice,
technical evidence, and publication review.
Add `content/articles/your-article.mdx` with this frontmatter, followed by the
article body:

```mdx
---
title: Your article title
description: A short description for the index and social previews.
date: '2026-10-29'
author: Your name
draft: true
---

## First section

Write the article here. Markdown, fenced code blocks, and the shared MDX
components are supported.
```

`title`, `description`, and a valid `YYYY-MM-DD` date are required. Quote the
date as shown. `author` is optional. `draft` is a boolean and defaults to
`false`; remove it or set it to `false` to publish. Drafts are excluded from
the index, detail routes, and sitemap, including in development. Dates control
display and newest-first sorting, not scheduled publication. Equal dates sort
by URL for a stable order.

The filename becomes the URL: `your-article.mdx` is
`/articles/your-article/`. Nested files work too:
`content/articles/engineering/shared-budgets.mdx` becomes
`/articles/engineering/shared-budgets/`. Do not create a root `index.mdx`;
the article index is provided by the page template.

The index shows an empty state until the first published article. Individual
pages render the MDX body, title, description, date, optional author, and a
desktop table of contents generated from headings. Canonical/social metadata
and the sitemap use only published articles. There is no `/blog` route or
separate blog collection.

Run `pnpm docs:dev` after adding content. For publication, commit the MDX file
and rebuild with `pnpm docs:build`; article routes are statically exported.
The optional catch-all route at `app/(marketing)/articles/[[...slug]]/page.tsx`
exports the index even when the collection is empty. The index and reading
templates live in `components/articles/`.

## Preserve old links

`app/[...slug]/page.tsx` exports a client redirect for each former docs URL,
keeping query strings and anchors. These pages are `noindex`. On a host with
HTTP redirects, add permanent redirects for former docs paths to `/docs`,
excluding `/`, `/articles`, `/changelog`, `/releases`, `/contributors`, and `/api`.
