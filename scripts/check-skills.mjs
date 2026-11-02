// Check installable skill metadata, catalogue coverage, and bundled references.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const catalogue = JSON.parse(
  readFileSync(resolve(root, 'skills/catalog.json'), 'utf8'),
);
const discovered = ['skills', '.claude/skills'].flatMap((container) =>
  readdirSync(resolve(root, container), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${container}/${entry.name}`),
);
assert.deepEqual(
  catalogue.map((skill) => skill.path).sort(),
  discovered.sort(),
  'Catalogue must cover every skill exactly once',
);

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? markdownFiles(path)
      : entry.name.endsWith('.md')
        ? [path]
        : [];
  });
}

for (const skill of catalogue) {
  const directory = resolve(root, skill.path);
  const source = readFileSync(resolve(directory, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]+?)\r?\n---\r?\n/.exec(source)?.[1];
  assert.ok(frontmatter, `${skill.name}: missing YAML frontmatter`);
  const name = /^name: ([a-z0-9-]+)$/m.exec(frontmatter)?.[1];
  assert.equal(
    name,
    skill.name,
    `${skill.path}: name must match the catalogue`,
  );
  assert.equal(
    skill.path.split('/').at(-1),
    name,
    `${name}: folder must match name`,
  );
  assert.ok(name.length <= 64, `${name}: name is too long`);
  // Descriptions are single-line YAML string scalars; Prettier may change quotes.
  const scalar = /^description: (.+)$/m.exec(frontmatter)?.[1];
  const description = scalar?.startsWith('"')
    ? JSON.parse(scalar)
    : scalar?.startsWith("'")
      ? scalar.slice(1, -1).replaceAll("''", "'")
      : scalar;
  assert.ok(
    typeof description === 'string' &&
      description.length > 0 &&
      description.length <= 1024,
    `${name}: invalid description`,
  );
  assert.equal(
    /^ {2}internal: true$/m.test(frontmatter),
    skill.internal,
    `${name}: internal visibility mismatch`,
  );
  assert.ok(
    source.split('\n').length <= 500,
    `${name}: move detail into references`,
  );
  assert.ok(
    skill.title && skill.description && skill.prompt,
    `${name}: incomplete website entry`,
  );
  assert.ok(
    skill.prompt.includes(
      `https://github.com/ksaurav24/valve/blob/master/${skill.path}/SKILL.md`,
    ),
    `${name}: prompt must link to its skill`,
  );
  const metadata = readFileSync(
    resolve(directory, 'agents/openai.yaml'),
    'utf8',
  );
  assert.ok(
    metadata.includes(`$${name}`),
    `${name}: default prompt must invoke the skill`,
  );

  for (const file of markdownFiles(directory)) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /\[[^\]]+\]\(([^\s)]+)\)/g,
    )) {
      const link = match[1];
      if (/^(?:[a-z]+:|#|\/)/i.test(link)) continue;
      const target = resolve(
        dirname(file),
        decodeURIComponent(link.split('#')[0]),
      );
      const local = relative(directory, target);
      assert.ok(
        !local.startsWith('..') && !isAbsolute(local),
        `${file}: reference escapes skill folder`,
      );
      assert.ok(
        existsSync(target) && statSync(target).isFile(),
        `${file}: broken reference ${link}`,
      );
    }
  }
}
console.log(
  `Validated ${catalogue.length} skills, catalogue entries, agent metadata, and local references.`,
);
