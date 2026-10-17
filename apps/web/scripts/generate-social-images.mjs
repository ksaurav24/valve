// Render the existing vector identity with local fonts. No network or build hook.
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { vfAt, vfBuild } from '../components/marketing/valve-flow/geometry.ts';

const output = new URL('../public/', import.meta.url);
const icon = await readFile(
  new URL('../app/icon.svg', import.meta.url),
  'utf8',
);
const font = async (name) =>
  (
    await readFile(
      new URL(
        `../node_modules/@fontsource-variable/${name}/files/${name}-latin-wght-normal.woff2`,
        import.meta.url,
      ),
    )
  ).toString('base64');
const [sans, mono] = await Promise.all([font('geist'), font('geist-mono')]);
const fonts = `
  @font-face { font-family: Geist; src: url(data:font/woff2;base64,${sans}); font-weight: 100 900; }
  @font-face { font-family: Mono; src: url(data:font/woff2;base64,${mono}); font-weight: 100 900; }
`;
const g = vfBuild('wide');
const dot = (x, y, color = '#ededed') =>
  `<circle cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`;
const flow = `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 330" aria-hidden="true">
    <g fill="none" stroke="#525252" stroke-width="1.5">
      ${g.lanes.map((lane) => `<path d="${lane.d}"/>`).join('')}
    </g>
    <path d="${g.body}" fill="#111111" stroke="#525252" stroke-width="1.5"/>
    <path d="${g.channel}" fill="#080808" stroke="#262626"/>
    ${g.workers
      .map(
        (w) => `
      <text x="${g.x0}" y="${w.y - 18}" fill="#8f8f8f">${w.label}</text>
      <path d="M${g.x0} ${w.y}H${g.port}" stroke="#8f8f8f" stroke-width="2"/>
    `,
      )
      .join('')}
    ${g.lanes.flatMap((lane) => [0.16, 0.55, 0.8].map((fraction) => dot(...vfAt(lane.path, lane.ST * fraction)))).join('')}
    ${Array.from({ length: 7 }, (_, i) => dot(g.TX + 30 + i * g.SP, g.cy)).join('')}
    <path d="M${g.GX} ${g.cy - 82}V${g.cy - 36}" stroke="#d2463a" stroke-width="3"/>
    <rect x="${g.GX - 24}" y="${g.cy - 86}" width="48" height="5" rx="2.5" fill="#d2463a"/>
    <path d="M${g.GX} ${g.cy - 14}V${g.cy + 14}" stroke="#d2463a" stroke-width="3"/>
    ${[90, 190, 290].map((offset) => dot(g.GX + offset, g.cy, '#d2463a')).join('')}
    <text x="${g.TX}" y="${g.cy + 72}" fill="#8f8f8f">queued 07/10</text>
    <text x="${g.C1 + 50}" y="${g.cy - 38}" fill="#d2463a">admitted 2 req/s</text>
  </svg>
`;

await mkdir(new URL('icons/', output), { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
    colorScheme: 'dark',
  });
  await page.setContent(`<!doctype html><html lang="en"><head><style>
    ${fonts}
    * { box-sizing: border-box; }
    body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #080808; color: #ededed; font-family: Geist, sans-serif; }
    header { position: absolute; inset: 48px 56px auto; display: flex; justify-content: space-between; align-items: center; }
    .brand { display: flex; align-items: center; gap: 16px; font: 600 30px Mono, monospace; letter-spacing: -1.5px; }
    .brand svg { width: 42px; height: 42px; }
    .stack { font: 16px Mono, monospace; color: #8f8f8f; }
    h1 { position: absolute; top: 144px; left: 56px; margin: 0; font-size: 78px; font-weight: 550; line-height: 1.04; letter-spacing: -4px; }
    h1 span { color: #d2463a; }
    .description { position: absolute; top: 203px; right: 60px; width: 274px; margin: 0; font-size: 23px; line-height: 1.45; color: #8f8f8f; letter-spacing: -0.4px; }
    .flow { position: absolute; inset: auto 24px 12px; height: 278px; }
    .flow svg { width: 100%; height: 100%; font-family: Mono, monospace; font-size: 18px; }
  </style></head><body>
    <header><div class="brand">${icon}<span>valve_</span></div><div class="stack">TypeScript · Redis · Valkey</div></header>
    <h1>Many workers<span>.</span><br>One rate limit<span>.</span></h1>
    <p class="description">One shared budget for outbound API calls.</p>
    <div class="flow">${flow}</div>
  </body></html>`);
  await page.evaluate('document.fonts.ready');
  await page.screenshot({ path: new URL('og.png', output).pathname });

  for (const size of [192, 512]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><html><head><style>
      body { margin: 0; background: #080808; width: ${size}px; height: ${size}px; display: grid; place-items: center; }
      svg { width: 75%; height: 75%; }
    </style></head><body>${icon}</body></html>`);
    await page.screenshot({
      path: new URL(`icons/valve-${size}.png`, output).pathname,
    });
  }
} finally {
  await browser.close();
}
console.log('Generated og.png (1200x630) and 192px/512px manifest icons.');
