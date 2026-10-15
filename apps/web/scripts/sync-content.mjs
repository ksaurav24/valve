import { mkdir, readFile, writeFile } from 'node:fs/promises';

// Changesets owns the package changelog and package.json owns the version.
// Never maintain a second copy by hand; everything here is generated.
const packageDir = new URL('../../../packages/valve/', import.meta.url);
const generated = new URL('../.generated/', import.meta.url);
const output = new URL('../content/changelog/index.mdx', import.meta.url);
const contributing = new URL(
  '../content/contributing/index.md',
  import.meta.url,
);

const { version } = JSON.parse(
  await readFile(new URL('package.json', packageDir), 'utf8'),
);
if (!version) throw new Error('packages/valve/package.json has no version.');
const markdown = await readFile(new URL('CHANGELOG.md', packageDir), 'utf8');
const body = markdown.replace(/^# [^\n]+\n\s*/, '');

/** Splits `## x.y.z` entries into `### Section` lists of change text. */
function parse(text) {
  return text
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [heading, ...rest] = chunk.split('\n');
      const sections = [];
      let current;
      for (const line of rest) {
        const title = line.match(/^### (.+)$/)?.[1];
        if (title) {
          current = { title, items: [] };
          sections.push(current);
          continue;
        }
        if (!current) {
          current = { title: null, items: [] };
          sections.push(current);
        }
        const item = line.match(/^- (?:[0-9a-f]{7,40}: )?(.*)$/)?.[1];
        if (item !== undefined) current.items.push(item);
        else if (line.trim() && current.items.length)
          current.items[current.items.length - 1] += ' ' + line.trim();
        else if (line.trim()) current.items.push(line.trim());
      }
      return {
        version: heading.trim(),
        sections: sections.filter((section) => section.items.length),
      };
    })
    .filter((entry) => /^\d+\.\d+\.\d+/.test(entry.version));
}

await mkdir(generated, { recursive: true });
await mkdir(new URL('.', output), { recursive: true });
await writeFile(
  output,
  '---\ntitle: Changelog\ndescription: Changes recorded in the package changelog.\n---\n\n' +
    body,
);
await writeFile(
  new URL('changelog.json', generated),
  JSON.stringify(parse(body), null, 2) + '\n',
);
// The root guide stays the only copy; the website renders it on /contributors.
await mkdir(new URL('.', contributing), { recursive: true });
await writeFile(
  contributing,
  '---\ntitle: Contributing\ndescription: How to work on valve.\n---\n\n' +
    (
      await readFile(
        new URL('../../../CONTRIBUTING.md', import.meta.url),
        'utf8',
      )
    )
      .replace(/^# [^\n]+\n\s*/, '')
      // Repository-relative links resolve against GitHub, not the website.
      .replace(
        /\]\((?!https?:|#|\/)([^)]+)\)/g,
        '](https://github.com/ksaurav24/valve/blob/master/$1)',
      ),
);
await writeFile(
  new URL('release.json', generated),
  JSON.stringify({ version }) + '\n',
);
