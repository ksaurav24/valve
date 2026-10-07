// Verify the MDX site, budget illustration, navigation, search, and layout.
import { expect, test } from '@playwright/test';
test('overview and shared-budget illustration respond to keyboard input', async ({
  page,
}, info) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'One rate limit',
  );
  const slider = page.getByRole('slider', { name: /Workers sharing/ });
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(page.locator('#budget-result')).toContainText('7 workers');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: `/tmp/valve-docs-${info.project.name}.png`,
    fullPage: true,
  });
});
test('guides and generated reference resolve', async ({ page, request }) => {
  for (const route of [
    '/quickstart/',
    '/guarantees/',
    '/choosing-an-algorithm/',
    '/guides/share-a-quota/',
    '/guides/respect-retry-after/',
    '/guides/priorities-and-shutdown/',
    '/reference/api/',
    '/reference/testing/',
    '/reference/implementation-status/',
    '/api/',
  ]) {
    const response = await request.get(route);
    expect(response.status(), route).toBe(200);
  }
  await page.goto('/guarantees/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Guarantees',
  );
  await expect(
    page.getByRole('heading', { name: 'Grants and cancellation', exact: true }),
  ).toBeVisible();
});
test('built search finds guarantees', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('button', { name: /Search/ })
    .first()
    .click();
  await page
    .getByRole('textbox', { name: 'Search', exact: true })
    .fill('guarantees');
  await expect(page.locator('.pagefind-ui__result-link').first()).toBeVisible();
});
