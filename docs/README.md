# valve website

The website is one statically exported Next.js app. Regular React pages and
MDX documentation share a root provider, local fonts, and theme tokens.

| URL               | Purpose                                             | Source                                  |
| ----------------- | --------------------------------------------------- | --------------------------------------- |
| `/`               | Introduce valve and help readers choose a next step | `app/(site)/page.tsx`                   |
| `/docs`           | Learn, configure, and look up valve behavior        | `content/docs/*.mdx` and subdirectories |
| `/changelog`      | Review recorded package changes                     | `../packages/valve/CHANGELOG.md`        |
| `/api/index.html` | Look up generated TypeDoc declarations              | Generated during the build              |

`app/(site)/layout.tsx` owns the public navigation and footer. The route group
does not appear in URLs. `app/docs/[[...slug]]/layout.tsx` owns the Fumadocs
sidebar and table of contents. `lib/source.ts` sets `/docs` as the MDX base
URL, including search results.

## Work locally

From the repository root:

```sh
pnpm docs:dev
pnpm --filter @valve/docs typecheck
pnpm docs:build
pnpm --filter @valve/docs preview
```

The dev server and static preview use `http://127.0.0.1:4321`. The build
writes deployable files to `docs/out`. Hosting needs no Node.js server.

## Add documentation

Create an MDX file in `content/docs` with a `title` and `description` in
frontmatter. Update the containing directory’s `meta.json` to place it in
the sidebar. Use `/docs/...` for documentation links; reserve `/api/...`
for the generated TypeDoc reference. The docs index is `/docs`.

## Enable the blog later

The blog is not a live route and has no navigation links or published posts.
The empty `content/blog` MDX collection and `blogSource` loader remain, with
page scaffolds in `scaffolds/blog`. Adding content alone does not publish it.

For future release announcements and library updates, following the pattern
of [Valibot’s blog](https://valibot.dev/blog/):

1. Move `scaffolds/blog/index.tsx` to `app/(site)/blog/page.tsx`.
2. Move `scaffolds/blog/article.tsx` to `app/(site)/blog/[slug]/page.tsx`.
3. Add top-level MDX posts to `content/blog`, with `title` and `description`
   frontmatter. Add explicit publication dates and version metadata to the
   collection schema when needed; do not infer release dates from Git history.
4. Add Blog links to the public navigation and docs layout once posts are ready.

Use announcements to explain what a new version changes, why the changes
matter, and how to adopt them. Put exact package changes in the changelog,
configuration steps in docs, and broader library decisions in the blog.

## Update the changelog

Use the repository’s Changesets workflow. `scripts/sync-changelog.mjs`
copies the package changelog into ignored `.generated/changelog/index.mdx`
before development, type checking, installation, and builds. Edit the package
changelog, never the generated file. The script also writes ignored
`.generated/release.json`; the latest changelog heading supplies the website’s
latest recorded version. This does not change the local library version in
`packages/valve/package.json`.

The package is currently unpublished. When publication is confirmed, update
the notices on the landing and changelog pages and the installation and status
docs together.

## Preserve old links

`app/[...slug]/page.tsx` exports a compatibility page for each former docs
URL. It uses a client redirect that retains query strings and heading anchors,
with a visible link when JavaScript is unavailable. These pages are marked
`noindex`. The root URL now serves the landing page.

Static export cannot use Next.js server redirects. On a host that supports
HTTP redirects, configure permanent redirects for the former docs paths to
their `/docs` equivalents. Keep `/`, `/blog`, `/changelog`, and `/api` out of
those redirect rules.

## Review the interface

The public pages use Geist for text and code, and a system serif for page
headings. Ink blue marks links, ochre identifies rate and queue behavior, and
burgundy marks guarantees and version history. Colors have separate light
and dark values. The header uses the project name as plain text, with no logo.

Navigation, focus indicators, touch targets, and narrow-screen layouts are
in `app/(site)/site.css`. The landing page contains technical text and a code
sample, with no simulations or promotional feature cards.

After building, review the static preview at desktop and phone widths in
both themes. Check the landing page, docs navigation, search, changelog,
and a former docs URL with a heading anchor.

## Magic UI components

`components/magicui` contains MIT-licensed adaptations of Magic UI’s
[Animated Theme Toggler](https://magicui.design/docs/components/animated-theme-toggler)
and [Code Comparison](https://magicui.design/docs/components/code-comparison).
The upstream license is retained alongside the components.

The theme control uses a circular View Transition and next-themes persistence
on both public and docs pages. Browsers without View Transitions and users
who prefer reduced motion receive an immediate theme change.

Code examples use Fumadocs `ServerCodeBlock`: Shiki highlights them during
static generation, while the copy controls run in the browser. The comparison
uses container queries to stack examples when its available space narrows.
The layout uses fluid spacing and type tokens in `app/(site)/site.css`.
