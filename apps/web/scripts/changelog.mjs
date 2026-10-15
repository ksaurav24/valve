/** Use plain headings while retaining preview-only history as explicitly grouped notes. */
export function websiteChangelog(markdown) {
  const [intro, ...entries] = markdown.split(/^## /m);
  const parsed = entries.flatMap((entry) => {
    const newline = entry.indexOf('\n');
    const version = (newline < 0 ? entry : entry.slice(0, newline)).trim();
    const match = version.match(/^(\d+\.\d+\.\d+)(-.+)?$/);
    return match
      ? [
          {
            version,
            base: match[1],
            preview: Boolean(match[2]),
            body: newline < 0 ? '\n' : entry.slice(newline),
          },
        ]
      : [];
  });
  const plainVersions = new Set(
    parsed.filter((entry) => !entry.preview).map((entry) => entry.version),
  );
  const groups = new Map();
  const historicalVersions = {};
  for (const entry of parsed) {
    // A plain release already carries its preview series' final release notes.
    if (entry.preview && plainVersions.has(entry.base)) continue;
    if (!groups.has(entry.base)) groups.set(entry.base, []);
    groups.get(entry.base).push(entry.body);
    if (entry.preview)
      (historicalVersions[entry.base] ??= []).push(entry.version);
  }
  const body =
    intro +
    [...groups]
      .map(
        ([version, notes]) =>
          `## ${version}` +
          (historicalVersions[version]
            ? '\n\nHistorical preview notes. This heading groups earlier builds; a plain npm release was not published.\n'
            : '') +
          notes.join(''),
      )
      .join('');
  return { body, historicalVersions };
}
