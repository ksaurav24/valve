'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, Link2, X } from 'lucide-react';
import { cn } from '@/lib/utils';

type Status = 'idle' | 'copied' | 'failed';

/** Clipboard API first; preserve keyboard focus if the selection fallback is needed. */
async function writeClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // A denied Clipboard API request may still permit the selection fallback.
    }
  }
  const focused = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('Copy failed');
  } finally {
    area.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    selection?.removeAllRanges();
    for (const range of ranges) selection?.addRange(range);
  }
}

const icons = { copy: Copy, link: Link2 };

export function CopyButton({
  value,
  className,
  label = 'Copy to clipboard',
  icon = 'copy',
  onCopied,
}: {
  value: string;
  className?: string;
  label?: string;
  icon?: keyof typeof icons;
  onCopied?: () => void;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (status === 'idle') return;
    const timer = setTimeout(() => setStatus('idle'), 1800);
    return () => clearTimeout(timer);
  }, [status, pulse]);

  const Idle = icons[icon];
  const message =
    status === 'copied'
      ? icon === 'link'
        ? 'Link copied'
        : 'Copied'
      : 'Copy failed';

  return (
    <span className={cn('relative inline-grid', className)}>
      <button
        type="button"
        aria-label={label}
        title={
          status === 'failed'
            ? 'Copy failed. Try again or select the text to copy it manually.'
            : label
        }
        data-status={status}
        onClick={() =>
          writeClipboard(value).then(
            () => {
              setStatus('copied');
              setPulse((n) => n + 1);
              onCopied?.();
            },
            () => {
              setStatus('failed');
              setPulse((n) => n + 1);
            },
          )
        }
        className="copy-button relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground active:scale-95 data-[status=copied]:text-live-foreground"
      >
        {status === 'copied' && (
          <span key={pulse} aria-hidden="true" className="copy-ring" />
        )}
        <span
          aria-hidden="true"
          className="t-icon-swap"
          data-state={status === 'idle' ? 'a' : 'b'}
        >
          <span className="t-icon" data-icon="a">
            <Idle className="size-3.5" />
          </span>
          <span className="t-icon" data-icon="b">
            {status === 'failed' ? (
              <X className="size-3.5 text-destructive" />
            ) : (
              <Check className="size-3.5" strokeWidth={2.5} />
            )}
          </span>
        </span>
      </button>
      {status !== 'idle' && (
        <span key={`tip-${pulse}`} aria-hidden="true" className="copy-tip">
          {message}
        </span>
      )}
      <span role="status" className="sr-only">
        <span key={pulse}>{status === 'idle' ? '' : message}</span>
      </span>
    </span>
  );
}
