export const downloadsEndpoint =
  'https://api.npmjs.org/downloads/point/last-month/valvejs';

/** npm's last-month endpoint counts the last 30 available days. */
export function parseDownloads(json) {
  if (
    json?.package !== 'valvejs' ||
    !Number.isSafeInteger(json.downloads) ||
    json.downloads < 0
  )
    throw new Error('Unexpected npm downloads response');
  return json.downloads;
}
