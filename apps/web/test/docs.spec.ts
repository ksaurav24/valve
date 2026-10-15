// Verify the MDX site, navigation, search, and layout.
import { expect, test } from '@playwright/test';
import release from '../.generated/release.json' with { type: 'json' };
import metadata from '../.generated/metadata.json' with { type: 'json' };
import changelog from '../.generated/changelog.json' with { type: 'json' };
test('introduction renders without horizontal overflow', async ({
  page,
}, info) => {
  await page.goto('/docs/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Introduction',
  );
  await expect(
    page.getByRole('link', { name: /Migrate from Bottleneck/ }).first(),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: `/tmp/valve-docs-${info.project.name}.png`,
    fullPage: true,
  });
});
test('every page and the generated reference resolve', async ({
  page,
  request,
}) => {
  for (const route of [
    '/docs/installation/',
    '/docs/quickstart/',
    '/docs/concepts/',
    '/docs/choosing-an-algorithm/',
    '/docs/guarantees/',
    '/docs/guides/share-a-quota/',
    '/docs/guides/scoped-rate-limits/',
    '/docs/guides/global-concurrency/',
    '/docs/guides/respect-retry-after/',
    '/docs/guides/priorities-and-shutdown/',
    '/docs/guides/error-handling/',
    '/docs/guides/observability/',
    '/docs/examples/',
    '/docs/examples/http-clients/',
    '/docs/examples/batch-scripts/',
    '/docs/examples/queue-workers/',
    '/docs/examples/request-handlers/',
    '/docs/examples/per-tenant-budgets/',
    '/docs/examples/layered-quotas/',
    '/docs/migration/from-bottleneck/',
    '/docs/reference/api/',
    '/docs/reference/redis-store/',
    '/docs/reference/feedback/',
    '/docs/reference/errors/',
    '/docs/reference/events/',
    '/docs/reference/custom-stores/',
    '/docs/reference/implementation-status/',
    '/docs/reference/testing/',
    '/docs/faq/',
    '/api/index.html',
  ]) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(200);
  }
  await page.goto('/docs/guarantees/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Guarantees',
  );
  await expect(
    page.getByRole('heading', { name: /^Grants and cancellation/, level: 2 }),
  ).toBeVisible();
});
test('built search finds the Bottleneck migration guide', async ({ page }) => {
  await page.goto('/docs/');
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await page.getByRole('combobox').fill('bottleneck');
  await expect(
    page
      .getByRole('option')
      .filter({ hasText: 'Migrate from Bottleneck' })
      .first(),
  ).toBeVisible();
});

test('home page leads with install, usage, and documentation', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Shared rate limits for outbound API calls.',
  );
  await expect(
    page.getByRole('link', { name: 'Get started', exact: true }),
  ).toHaveAttribute('href', '/docs/quickstart/');
  await expect(
    page.getByRole('link', { name: 'valve home' }).locator('svg, img'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: /^v\d+\.\d+\.\d+/ }).first(),
  ).toContainText(release.version);
  await expect(
    page.locator('#changelog > ol > li > div > span:first-child'),
  ).toHaveText(changelog.slice(0, 3).map((entry) => `v${entry.version}`));
  const published = Object.hasOwn(metadata.npm.versions, release.version);
  await expect(
    page.getByRole('tab', { name: published ? 'pnpm' : 'source', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  if (published) {
    await expect(page.getByRole('tabpanel').first()).toContainText(
      'pnpm add valvejs',
    );
  }
  await expect(
    page.getByText('Beta until 1.0. APIs may change between releases.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'shared.ts' }).click();
  await expect(page.getByRole('tabpanel', { name: 'shared.ts' })).toContainText(
    'redisStore',
  );
  await page.getByRole('tab', { name: 'scoped.ts', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'scoped.ts' })).toContainText(
    "scopes: { recipient: 'contact-A' }",
  );
  await expect(
    page.getByRole('link', { name: 'Shared and scoped budgets.' }),
  ).toHaveAttribute('href', /^\/docs\/guides\/scoped-rate-limits\/?$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  for (const route of [
    '/docs/',
    '/changelog/',
    '/releases/',
    '/contributors/',
  ]) {
    expect((await request.get(route)).status(), route).toBe(200);
  }
  expect((await request.get('/blog/')).status()).toBe(404);
  await page.goto('/changelog/');
  await expect(
    page
      .getByRole('heading', { level: 2 })
      .getByRole('link', { name: release.version, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).not.toContainText([
    '-beta',
  ]);
  await expect(
    page
      .getByRole('heading', { level: 2 })
      .getByRole('link', { name: '0.3.0', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByText('Keep admitting jobs through a healthy store', {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page
      .getByText('Detect incompatible shared Redis/Valkey quota settings', {
        exact: false,
      })
      .first(),
  ).toBeVisible();
});

test('releases list only published versions', async ({ page }) => {
  await page.goto('/releases/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Releases');
  const published = changelog.filter((entry) =>
    Object.hasOwn(metadata.npm.versions, entry.version),
  );
  if (published.length === 0) {
    await expect(
      page.getByRole('heading', { name: 'No plain-version releases yet' }),
    ).toBeVisible();
    await expect(page.locator('main')).not.toContainText('latest');
  } else {
    await expect(
      page.getByRole('heading', { name: 'No plain-version releases yet' }),
    ).toHaveCount(0);
    for (const entry of published) {
      await expect(
        page.getByRole('heading', { name: `v${entry.version}`, exact: true }),
      ).toBeVisible();
    }
  }
  await expect(page.locator('main article h2')).toHaveText(
    published.map((entry) => `v${entry.version}`),
  );
});

test('npm downloads render beside GitHub and accept a zero count', async ({
  page,
}) => {
  await page.route(
    'https://api.npmjs.org/downloads/point/last-month/valvejs',
    (route) => route.fulfill({ json: { package: 'valvejs', downloads: 0 } }),
  );
  await page.goto('/');
  const npm = page.getByRole('banner').getByRole('link', {
    name: 'valvejs on npm, 0 downloads in the last 30 days',
  });
  await expect(npm).toBeVisible();
  await expect(npm).toHaveAttribute(
    'href',
    'https://www.npmjs.com/package/valvejs',
  );
  await expect(npm.locator('svg').first()).toBeVisible();
  await expect(
    page.getByRole('banner').getByRole('link', { name: /on GitHub/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.goto('/docs/');
  const docsNpm = page.getByRole('link', { name: /valvejs on npm/ });
  // Fumadocs places secondary links in the sidebar on mobile.
  if (!(await docsNpm.first().isVisible())) {
    await page
      .getByRole('button', { name: 'Open Sidebar', exact: true })
      .click();
  }
  await expect(
    page
      .getByRole('link', {
        name: 'valvejs on npm, 0 downloads in the last 30 days',
      })
      .first(),
  ).toBeVisible();
});

test('download API failures preserve the build-time count', async ({
  page,
}) => {
  await page.route(
    'https://api.npmjs.org/downloads/point/last-month/valvejs',
    (route) =>
      route.fulfill({ status: 404, json: { error: 'package not found' } }),
  );
  await page.goto('/');
  const initialDownloads = metadata.downloads as number | null;
  const label =
    initialDownloads === null
      ? 'valvejs on npm, download count unavailable'
      : `valvejs on npm, ${initialDownloads.toLocaleString('en')} downloads in the last 30 days`;
  await expect(
    page.getByRole('banner').getByRole('link', { name: label, exact: true }),
  ).toBeVisible();
});

test('header keeps npm downloads visible on narrow phones and tablets', async ({
  page,
}) => {
  await page.route(
    'https://api.npmjs.org/downloads/point/last-month/valvejs',
    (route) =>
      route.fulfill({ json: { package: 'valvejs', downloads: 1234567 } }),
  );
  await page.route('https://api.github.com/repos/ksaurav24/valve', (route) =>
    route.fulfill({ json: { stargazers_count: 1234567 } }),
  );
  await page.goto('/');
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(
      page.getByRole('banner').getByRole('link', {
        name: 'valvejs on npm, 1,234,567 downloads in the last 30 days',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      `width ${width}`,
    ).toBe(false);
  }
});

test('contributors page renders people and the root guide', async ({
  page,
}) => {
  await page.goto('/contributors/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Built in the open',
  );
  await expect(
    page.getByRole('link', { name: /contribution/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Commit conventions', level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'the Code of Conduct' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/ksaurav24/valve/blob/master/CODE_OF_CONDUCT.md',
  );
});

test('former docs URLs preserve query strings and heading anchors', async ({
  page,
}) => {
  await page.goto('/guarantees/?from=bookmark#store-failures');
  await page.waitForURL('**/docs/guarantees/?from=bookmark#store-failures');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Guarantees',
  );
});

test('theme defaults to dark and persists between pages with reduced motion', async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('theme'));
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page
    .getByRole('button', { name: 'Toggle color theme', exact: true })
    .click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-theme-transition',
    'active',
  );
  await page.goto('/docs/');
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  if (info.project.name === 'mobile') {
    await page
      .getByRole('button', { name: 'Open Sidebar', exact: true })
      .click();
  }
  await page
    .getByRole('button', { name: 'Toggle color theme', exact: true })
    .first()
    .click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
