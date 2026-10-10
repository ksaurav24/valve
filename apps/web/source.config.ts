import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({ dir: 'content/docs' });
export const blog = defineDocs({ dir: 'content/blog' });
export const changelog = defineDocs({ dir: 'content/changelog' });
export const contributing = defineDocs({ dir: 'content/contributing' });
export default defineConfig();
