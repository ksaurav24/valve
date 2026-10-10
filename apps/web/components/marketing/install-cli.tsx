'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Terminal } from 'lucide-react';
import { CopyButton } from '@/components/shared/copy-button';
import { TabsSubtle, TabsSubtleItem } from '@/components/ui/tabs-subtle';

const pkg = '@ksaurav24/valve';
const managers = [
  { label: 'pnpm', command: `pnpm add ${pkg}` },
  { label: 'npm', command: `npm install ${pkg}` },
  { label: 'yarn', command: `yarn add ${pkg}` },
  { label: 'bun', command: `bun add ${pkg}` },
];
const fromSource = [
  'git clone https://github.com/ksaurav24/valve.git && cd valve',
  'pnpm install && pnpm build',
  `pnpm --filter ${pkg} pack --out /tmp/valve.tgz`,
].join('\n');

/** Registry commands only claim to work once npm lists the package. */
export function InstallCli({ published }: { published: boolean }) {
  const tabs = published
    ? managers
    : [{ label: 'source', command: fromSource }, ...managers];
  const [selected, setSelected] = useState(0);
  const tab = tabs[selected]!;
  const pending = !published && tab.label !== 'source';

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <TabsSubtle
          selectedIndex={selected}
          onSelect={setSelected}
          size="compact"
          idPrefix="install"
        >
          {tabs.map(({ label }, index) => (
            <TabsSubtleItem key={label} index={index} label={label} />
          ))}
        </TabsSubtle>
        <CopyButton value={tab.command} label={`Copy ${tab.label} command`} />
      </div>
      <div
        role="tabpanel"
        className="flex gap-3 overflow-x-auto px-4 py-4 font-mono text-[13px] leading-6"
      >
        <Terminal
          aria-hidden="true"
          className="mt-1 size-3.5 shrink-0 text-muted-foreground"
        />
        <pre className="whitespace-pre text-foreground">
          {tab.command.split('\n').map((line) => (
            <div key={line}>
              <span className="select-none text-muted-foreground">$ </span>
              {line}
            </div>
          ))}
          {pending && (
            <div className="text-muted-foreground">
              # not on npm yet; available from the first release
            </div>
          )}
        </pre>
      </div>
      {!published && (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          The package is unreleased. Install the tarball with your package
          manager.{' '}
          <Link
            href="/docs/installation"
            className="text-foreground underline decoration-ring underline-offset-4 hover:decoration-foreground"
          >
            Installation guide
          </Link>
        </p>
      )}
    </div>
  );
}
