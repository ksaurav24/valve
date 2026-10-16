// Verify the exported HTML consumed by crawlers, without waiting for hydration.
import { expect, test } from '@playwright/test';

const origin = new URL(
  process.env.NEXT_PUBLIC_SITE_URL || 'https://valvejs.vercel.app',
).origin;

test('marketing and docs export distinct canonical and social metadata', async ({
  page,
  request,
}) => {
  for (const path of [
    '/',
    '/changelog/',
    '/releases/',
    '/contributors/',
    '/docs/',
    '/docs/quickstart/',
    '/docs/guides/scoped-rate-limits/',
  ]) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    const metadata = await page.evaluate(
      (html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const content = (selector: string) =>
          doc.querySelector(selector)?.getAttribute('content');
        return {
          title: doc.title,
          description: content('meta[name="description"]'),
          canonical: doc
            .querySelector('link[rel="canonical"]')
            ?.getAttribute('href'),
          ogTitle: content('meta[property="og:title"]'),
          ogDescription: content('meta[property="og:description"]'),
          ogUrl: content('meta[property="og:url"]'),
          ogImage: content('meta[property="og:image"]'),
          ogWidth: content('meta[property="og:image:width"]'),
          ogHeight: content('meta[property="og:image:height"]'),
          ogAlt: content('meta[property="og:image:alt"]'),
          twitterCard: content('meta[name="twitter:card"]'),
          twitterTitle: content('meta[name="twitter:title"]'),
          twitterDescription: content('meta[name="twitter:description"]'),
          twitterImage: content('meta[name="twitter:image"]'),
          manifest: doc
            .querySelector('link[rel="manifest"]')
            ?.getAttribute('href'),
          robots: content('meta[name="robots"]'),
        };
      },
      await response.text(),
    );
    expect(metadata.description, path).toBeTruthy();
    expect(metadata.canonical, path).toBe(`${origin}${path}`);
    expect(metadata.ogUrl, path).toBe(metadata.canonical);
    expect(metadata.ogTitle, path).toBe(metadata.title);
    expect(metadata.ogDescription, path).toBe(metadata.description);
    expect(metadata.ogImage, path).toBe(`${origin}/og.png`);
    expect([metadata.ogWidth, metadata.ogHeight], path).toEqual([
      '1200',
      '630',
    ]);
    expect(metadata.ogAlt, path).toContain('Three workers');
    expect(metadata.twitterCard, path).toBe('summary_large_image');
    expect(metadata.twitterTitle, path).toBe(metadata.title);
    expect(metadata.twitterDescription, path).toBe(metadata.description);
    expect(metadata.twitterImage, path).toBe(metadata.ogImage);
    expect(metadata.manifest, path).toBe('/manifest.webmanifest');
    expect(metadata.robots, path).toBe('index, follow');
  }
});

test('legacy aliases point crawlers to docs and remain unindexed', async ({
  page,
  request,
}) => {
  const response = await request.get('/quickstart/');
  const metadata = await page.evaluate(
    (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return {
        canonical: doc
          .querySelector('link[rel="canonical"]')
          ?.getAttribute('href'),
        robots: doc
          .querySelector('meta[name="robots"]')
          ?.getAttribute('content'),
      };
    },
    await response.text(),
  );
  expect(metadata.canonical).toBe(`${origin}/docs/quickstart/`);
  expect(metadata.robots).toBe('noindex, follow');
});

test('sitemap contains only canonical pages and robots advertises it', async ({
  page,
  request,
}) => {
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  const urls = await page.evaluate(
    (xml) =>
      [
        ...new DOMParser()
          .parseFromString(xml, 'text/xml')
          .querySelectorAll('loc'),
      ].map((node) => node.textContent!),
    await response.text(),
  );
  expect(new Set(urls).size).toBe(urls.length);
  expect(urls).toEqual(
    expect.arrayContaining([
      `${origin}/`,
      `${origin}/releases/`,
      `${origin}/changelog/`,
      `${origin}/contributors/`,
      `${origin}/docs/`,
      `${origin}/docs/quickstart/`,
    ]),
  );
  expect(urls).not.toContain(`${origin}/quickstart/`);
  for (const url of urls) {
    expect(new URL(url).origin).toBe(origin);
    expect((await request.get(new URL(url).pathname)).status(), url).toBe(200);
  }
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain(`Sitemap: ${origin}/sitemap.xml`);
  expect(await robots.text()).toContain('Disallow: /api/search');
});

test('social card and manifest icons are available at the declared sizes', async ({
  request,
}) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    name: 'valve',
    start_url: '/',
    display: 'browser',
  });
  expect(manifest.icons).toHaveLength(2);
  for (const [path, width, height] of [
    ['/og.png', 1200, 630],
    ...manifest.icons.map((icon: { src: string; sizes: string }) => [
      icon.src,
      ...icon.sizes.split('x').map(Number),
    ]),
  ] as [string, number, number][]) {
    const image = await request.get(path);
    expect(image.status(), path).toBe(200);
    expect(image.headers()['content-type'], path).toContain('image/png');
    const body = await image.body();
    expect(body.subarray(0, 8).toString('hex'), path).toBe('89504e470d0a1a0a');
    expect([body.readUInt32BE(16), body.readUInt32BE(20)], path).toEqual([
      width,
      height,
    ]);
  }
});

test('homepage includes website and source-code structured data', async ({
  page,
  request,
}) => {
  const response = await request.get('/');
  const data = await page.evaluate(
    (html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return JSON.parse(
        doc.querySelector('script[type="application/ld+json"]')!.textContent!,
      );
    },
    await response.text(),
  );
  expect(data['@context']).toBe('https://schema.org');
  expect(data['@graph']).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ '@type': 'WebSite', url: `${origin}/` }),
      expect.objectContaining({
        '@type': 'SoftwareSourceCode',
        name: 'valvejs',
        codeRepository: 'https://github.com/ksaurav24/valve',
        programmingLanguage: 'TypeScript',
      }),
    ]),
  );
});
