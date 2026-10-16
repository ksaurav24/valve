'use client';

import { useState } from 'react';
import { FileCode2 } from 'lucide-react';
import { CopyButton } from '@/components/shared/copy-button';
import { TabsSubtle, TabsSubtleItem } from '@/components/ui/tabs-subtle';

export interface CodeTab {
  file: string;
  code: string;
  /** Shiki output, rendered on the server. */
  html: string;
}

/** Only the tab indicator moves; panels swap without animation. */
export function CodeTabs({ tabs }: { tabs: CodeTab[] }) {
  const [selected, setSelected] = useState(0);
  const tab = tabs[selected]!;
  return (
    <div data-ui className="overflow-hidden rounded-lg bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <TabsSubtle
          selectedIndex={selected}
          onSelect={setSelected}
          size="compact"
          idPrefix="code"
          className="code-tab-list"
        >
          {tabs.map(({ file }, index) => (
            <TabsSubtleItem
              key={file}
              index={index}
              label={file}
              icon={FileCode2}
            />
          ))}
        </TabsSubtle>
        <CopyButton value={tab.code} label={`Copy ${tab.file}`} />
      </div>
      <div
        id={`code-panel-${selected}`}
        role="tabpanel"
        aria-labelledby={`code-tab-${selected}`}
        aria-label={tab.file}
        className="code-html overflow-x-auto px-4 py-4 text-[13px] leading-6"
        dangerouslySetInnerHTML={{ __html: tab.html }}
      />
    </div>
  );
}
