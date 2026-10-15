import metadata from '../.generated/metadata.json';

/** Last 30 available days; null until npm has published download statistics. */
export const monthlyDownloads: number | null = metadata.downloads;
