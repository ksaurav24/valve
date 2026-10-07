// Static MDX documentation with navigation, search, and syntax highlighting.
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
export default defineConfig({
  integrations: [
    starlight({
      title: 'valve',
      description: 'One rate limit for every worker that calls an API.',
      customCss: ['./src/styles/custom.css'],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/ksaurav24/valve',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Quickstart', slug: 'quickstart' },
          ],
        },
        {
          label: 'Understand the budget',
          items: [
            { label: 'Guarantees', slug: 'guarantees' },
            { label: 'Choose an algorithm', slug: 'choosing-an-algorithm' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        {
          label: 'Reference',
          items: [{ autogenerate: { directory: 'reference' } }],
        },
      ],
    }),
  ],
});
