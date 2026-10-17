// Browser checks against the built static MDX site on desktop and mobile.
import { fileURLToPath } from 'node:url';
import nextEnv from '@next/env';
import { defineConfig, devices } from '@playwright/test';

// Expect the same NEXT_PUBLIC_SITE_URL the static export was built with.
nextEnv.loadEnvConfig(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  testDir: './test',
  use: { baseURL: 'http://127.0.0.1:4321' },
  webServer: {
    command: 'python3 -m http.server 4321 --bind 127.0.0.1 --directory out',
    url: 'http://127.0.0.1:4321',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
});
