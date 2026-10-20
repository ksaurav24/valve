import type { Adapter } from './types.ts';

/** Harness floor only: report raw values in a separate row; never subtract it. */
export const identityAdapter: Adapter = {
  id: 'identity',
  version: 'harness',
  supports: () => true,
  async create() {
    return {
      async submit(fn) {
        return fn();
      },
      async close() {},
    };
  },
};
