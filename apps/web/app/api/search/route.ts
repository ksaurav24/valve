import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Export a local search index so the entire website can be hosted statically.
export const dynamic = 'force-static';
const search = createFromSource(source);
export const GET = search.staticGET;
