// Fail a same-runner throughput or scheduling regression over fifteen percent.
import { readFileSync } from 'node:fs';
const [basePath, currentPath] = process.argv.slice(2);
const base = JSON.parse(readFileSync(basePath, 'utf8')).results;
const current = JSON.parse(readFileSync(currentPath, 'utf8')).results;
for (const key of ['valve', 'p99DelayMs']) {
  const ceiling = Math.max(base[key] * 1.15, key === 'p99DelayMs' ? 1 : 0);
  if (current[key] > ceiling) {
    console.error(
      `${key}: ${current[key]} exceeds baseline ceiling ${ceiling}`,
    );
    process.exitCode = 1;
  }
}
