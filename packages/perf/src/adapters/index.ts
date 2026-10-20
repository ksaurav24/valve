// Adapter registry with the Valve adapter registered alongside the competitors.
import { adapterFor, registerAdapter } from './registry.ts';
import { valveAdapter } from './valve.ts';

registerAdapter(valveAdapter);

export { adapterFor, valveAdapter };
export { CATEGORIES, competitorAdapters, naMatrix } from './registry.ts';
