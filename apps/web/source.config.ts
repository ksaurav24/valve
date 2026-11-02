import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { articleSchema } from './lib/article-schema';

export const docs = defineDocs({ dir: 'content/docs' });
export const articles = defineDocs({
  dir: 'content/articles',
  docs: { schema: articleSchema },
});
export const changelog = defineDocs({ dir: 'content/changelog' });
export const contributing = defineDocs({ dir: 'content/contributing' });
export default defineConfig();
