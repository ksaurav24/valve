// Verify skill selection and copying on the exported desktop and mobile site.
import { expect, test } from '@playwright/test';

test('skill selection copies the matching command and prompt', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/skills/');
  const select = page.getByLabel('What are you working on?');
  await select.selectOption('valve-migrate-from-bottleneck');
  const command =
    'npx skills add ksaurav24/valve --skill valve-migrate-from-bottleneck';
  await expect(
    page.getByRole('textbox', { name: 'Skill installation command' }),
  ).toHaveValue(command);
  await page.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Command copied.');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(command);

  await page.getByRole('button', { name: 'Use a prompt', exact: true }).click();
  const prompt = await page
    .getByRole('textbox', { name: 'Agent prompt' })
    .inputValue();
  expect(prompt).toContain('/skills/valve-migrate-from-bottleneck/SKILL.md');
  expect(prompt).toContain('Migrate this project from Bottleneck to valvejs.');
  await page.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Prompt copied.');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(prompt);

  await select.selectOption('valve-perf-harness');
  await page
    .getByRole('button', { name: 'Install skill', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Skill installation command' }),
  ).toHaveValue(
    'INSTALL_INTERNAL_SKILLS=1 npx skills add ksaurav24/valve --skill valve-perf-harness',
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
  ).toBe(false);
});

test('a clipboard failure leaves the prompt available for manual copying', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    });
  });
  await page.goto('/');
  const setup = page.getByRole('region', { name: 'Set up with your agent.' });
  await setup
    .getByRole('button', { name: 'Use a prompt', exact: true })
    .click();
  await setup.getByRole('button', { name: 'Copy prompt', exact: true }).click();
  await expect(setup.getByRole('status')).toHaveText(
    'Copy failed. Select and copy the text below.',
  );
  await expect(
    setup.getByRole('textbox', { name: 'Agent prompt' }),
  ).toHaveValue(/Set up valvejs in this project/);
  await expect(
    setup.getByRole('link', { name: 'Browse all skills' }),
  ).toHaveAttribute('href', '/skills/');
});
