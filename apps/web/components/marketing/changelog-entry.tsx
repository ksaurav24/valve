import { InlineCode } from '@/components/shared/inline-code';
import type { ChangelogSection } from '@/lib/releases';
import { cn } from '@/lib/utils';

const kinds: Record<string, string> = {
  'Major Changes': 'Major',
  'Minor Changes': 'Minor',
  'Patch Changes': 'Patch',
};

/** Preview series repeat headings; show each kind once, in first-seen order. */
function mergeSections(sections: ChangelogSection[]) {
  const merged = new Map<string | null, ChangelogSection>();
  for (const { title, items, anchors = [] } of sections) {
    const previous = merged.get(title);
    merged.set(title, {
      title,
      items: [...(previous?.items ?? []), ...items],
      anchors: [...new Set([...(previous?.anchors ?? []), ...anchors])],
    });
  }
  return [...merged.values()];
}

export function ChangelogSections({
  sections,
  limit,
}: {
  sections: ChangelogSection[];
  /** Trim each list for previews. */
  limit?: number;
}) {
  if (limit) {
    return (
      <div className="max-w-[72ch] space-y-4">
        {sections.map((section, index) => (
          <section key={index}>
            {section.title && (
              <h4 className="mb-3 text-sm font-medium text-foreground">
                {section.title}
              </h4>
            )}
            <ul className="space-y-3 text-base leading-relaxed">
              {section.items.slice(0, limit).map((item, i) => (
                <li key={i} className="relative pl-4">
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-[0.6em] size-1 rounded-full bg-muted-foreground/50"
                  />
                  <span className="line-clamp-2">
                    <InlineCode text={item.split('\n\n')[0]!} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {mergeSections(sections).map(({ title, items, anchors = [] }) =>
        title === null ? (
          <div key="notes" className="space-y-2">
            {items.map((item, i) => (
              <p
                key={i}
                className="border-l-2 border-border pl-4 text-sm leading-relaxed text-muted-foreground"
              >
                <InlineCode text={item} />
              </p>
            ))}
          </div>
        ) : (
          <section key={title} className="space-y-4">
            <h3
              id={anchors[0]}
              className="relative flex scroll-mt-24 items-center gap-3 text-xs font-medium text-muted-foreground"
            >
              {anchors.slice(1).map((anchor) => (
                <span
                  key={anchor}
                  id={anchor}
                  aria-hidden="true"
                  className="absolute top-0 scroll-mt-24"
                />
              ))}
              <span
                className={cn(
                  'change-kind',
                  kinds[title] && `change-kind-${kinds[title].toLowerCase()}`,
                )}
              >
                {kinds[title] ?? title}
              </span>
              <span className="tabular-nums">
                {items.length} {items.length === 1 ? 'change' : 'changes'}
              </span>
              <span aria-hidden="true" className="h-px flex-1 bg-border" />
            </h3>
            <ul className="change-list">
              {items.map((item, i) => (
                <li key={i}>
                  {item.split('\n\n').map((paragraph, p) => (
                    <p key={p}>
                      <InlineCode text={paragraph} />
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ),
      )}
    </div>
  );
}
