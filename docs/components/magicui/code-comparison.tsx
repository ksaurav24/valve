// Adapted from Magic UI's Code Comparison (MIT).
// https://magicui.design/r/code-comparison.json
// Accepts server-highlighted code to avoid shipping Shiki to the browser.
import type { ReactNode } from 'react';

export function CodeComparison({
  beforeCode,
  afterCode,
  beforeLabel,
  afterLabel,
}: {
  beforeCode: ReactNode;
  afterCode: ReactNode;
  beforeLabel: string;
  afterLabel: string;
}) {
  return (
    <div className="code-comparison">
      <div className="code-comparison-grid">
        <section aria-label={beforeLabel} className="code-comparison-side">
          <h3>{beforeLabel}</h3>
          {beforeCode}
          <p>The default memory store belongs to this valve instance.</p>
        </section>
        <section aria-label={afterLabel} className="code-comparison-side">
          <h3>{afterLabel}</h3>
          {afterCode}
          <p>
            Use the same Redis server, prefix, id, and rules in every worker.
          </p>
        </section>
      </div>
    </div>
  );
}
