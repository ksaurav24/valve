import Link from 'next/link';

const guides = [
  {
    href: '/quickstart/',
    title: 'Make your first call',
    description: 'Create a valve and put a budget in front of your API.',
  },
  {
    href: '/guides/share-a-quota/',
    title: 'Share a quota',
    description: 'Keep every worker within one provider limit.',
  },
  {
    href: '/guarantees/',
    title: 'Know the guarantees',
    description: 'Understand admission, cancellation, and recovery.',
  },
  {
    href: '/reference/api/',
    title: 'Explore the API',
    description: 'Find the options and lifecycle controls you need.',
  },
];

export function OverviewLinks() {
  return (
    <nav
      className="overview-links not-prose"
      aria-label="Explore the documentation"
    >
      {guides.map((guide) => (
        <Link key={guide.href} href={guide.href} className="overview-link">
          <strong>{guide.title}</strong>
          <span>{guide.description}</span>
        </Link>
      ))}
    </nav>
  );
}
