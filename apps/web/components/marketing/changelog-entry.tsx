import { InlineCode } from '@/components/shared/inline-code';
import type { ChangelogSection } from '@/lib/releases';

export function ChangelogSections({
  sections,
  limit,
}: {
  sections: ChangelogSection[];
  /** Trim each list for previews. */
  limit?: number;
}) {
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
                <span className={limit ? 'line-clamp-2' : undefined}>
                  <InlineCode text={item} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
