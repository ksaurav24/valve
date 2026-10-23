import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { releaseTag } from './prepare-release-plan.mjs';

// Read the full packument used by the website, not npm's version endpoint.
export async function waitForNpmRelease(
  { name, version },
  {
    tag,
    attempts = 60,
    intervalMs = 10_000,
    fetchImpl = fetch,
    sleep = setTimeout,
    log = console.log,
  } = {},
) {
  let reason;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(
        `https://registry.npmjs.org/${name.replace('/', '%2f')}`,
        {
          headers: { accept: 'application/json', 'cache-control': 'no-cache' },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const packument = await response.json();
      if (
        !packument.time?.unpublished &&
        Object.hasOwn(packument.versions ?? {}, version) &&
        Number.isFinite(Date.parse(packument.time?.[version])) &&
        (!tag || packument['dist-tags']?.[tag] === version)
      ) {
        log(`npm exposes ${name}@${version}${tag ? ` on ${tag}` : ''}`);
        return packument;
      }
      reason = `version, publication time${tag ? `, or ${tag} tag` : ''} missing`;
    } catch (error) {
      reason = error.message;
    }
    log(
      `Waiting for npm ${name}@${version} (${attempt}/${attempts}): ${reason}`,
    );
    if (attempt < attempts) await sleep(intervalMs);
  }
  throw new Error(`npm did not expose ${name}@${version}: ${reason}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const pkg = JSON.parse(
    await readFile(new URL('../packages/valve/package.json', import.meta.url)),
  );
  await waitForNpmRelease(pkg, { tag: releaseTag(pkg) });
}
