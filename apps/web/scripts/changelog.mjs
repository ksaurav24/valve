/** Keep plain-version entries in source order without renaming published builds. */
export function plainVersionChangelog(markdown) {
  const [intro, ...entries] = markdown.split(/^## /m);
  return (
    intro +
    entries
      .filter((entry) => /^\d+\.\d+\.\d+$/.test(entry.split('\n')[0].trim()))
      .map((entry) => `## ${entry}`)
      .join('')
  );
}
