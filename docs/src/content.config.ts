// MDX content collection validated by the Starlight schema.
import { defineCollection } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
