// Verify the MDX site, navigation, search, and layout.
import { expect, test } from '@playwright/test';
import release from '../.generated/release.json' with { type: 'json' };
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

test('public pages connect readers to documentation and recorded releases', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Shared rate limits for outbound calls.',
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Start reading' })
      .getByRole('link', { name: 'Quickstart', exact: true }),
  ).toHaveAttribute('href', '/docs/quickstart/');
  await expect(page.locator('.site-brand svg')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Simulate Retry-After' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Blog', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'In-memory rate limit example' }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Shared Redis budget example' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
  for (const route of ['/docs/', '/changelog/']) {
    expect((await request.get(route)).status(), route).toBe(200);
  }
  expect((await request.get('/blog/')).status()).toBe(404);
  expect((await request.get('/blog/one-quota-many-workers/')).status()).toBe(
    404,
  );
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Changelog', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: release.version, exact: true }),
  ).toBeVisible();
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

test('theme choice persists between public pages and docs with reduced motion', async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('theme'));
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page
    .getByRole('button', { name: 'Toggle color theme', exact: true })
    .click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.locator('html')).not.toHaveAttribute(
    'data-theme-transition',
    'active',
  );
  await page.goto('/docs/');
  await expect(page.locator('html')).toHaveClass(/dark/);
  if (info.project.name === 'mobile') {
    await page
      .getByRole('button', { name: 'Open Sidebar', exact: true })
      .click();
  }
  await page
    .getByRole('button', { name: 'Toggle color theme', exact: true })
    .first()
    .click();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator('html')).not.toHaveClass(/dark/);
});
