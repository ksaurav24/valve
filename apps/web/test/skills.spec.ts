// Verify the homepage command and shared clipboard fallback on desktop and mobile.
import { expect, test, type Page } from '@playwright/test';

const command = 'npx skills add ksaurav24/valve';
const skills = (page: Page) =>
  page.getByRole('region', { name: 'Agent skills' });

test('the homepage copies the interactive skills command', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/#agent-skills');
  const section = skills(page);
  await expect(section.locator('code')).toHaveText(command);
  await section
    .getByRole('button', { name: 'Copy skills install command' })
    .click();
  await expect(section.getByRole('status')).toHaveText('Copied');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(command);
  await expect(section.getByRole('tab')).toHaveCount(0);
  await expect(section.getByRole('combobox')).toHaveCount(0);
  await expect(page.locator('a[href="/skills/"]')).toHaveCount(0);
  expect((await request.get('/skills/')).status()).toBe(404);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});

test('a clipboard failure keeps the command available for manual copying', async ({
  page,
}) => {
  await page.addInitScript(() => {
    document.execCommand = () => false;
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    });
  });
  await page.goto('/#agent-skills');
  const section = skills(page);
  const copy = section.getByRole('button', {
    name: 'Copy skills install command',
  });
  await copy.click();
  await expect(section.getByRole('status')).toHaveText('Copy failed');
  await expect(copy).toBeFocused();
  await expect(section.locator('code')).toHaveText(command);
});

test('copy falls back when Clipboard API access is denied and preserves focus', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => {
        throw new Error('Clipboard API denied');
      },
    });
  });
  await page.goto('/#agent-skills');
  const section = skills(page);
  const copy = section.getByRole('button', {
    name: 'Copy skills install command',
  });
  await copy.click();
  await expect(section.getByRole('status')).toHaveText('Copied');
  await expect(copy).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(command);
});
