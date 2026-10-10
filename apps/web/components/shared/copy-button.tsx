'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, Copy } from 'lucide-react';
import { spring } from '@/lib/springs';
import { cn } from '@/lib/utils';

export function CopyButton({
  value,
  className,
  label = 'Copy to clipboard',
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => setCopied(true))
      }
      className={cn(
        'relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground active:scale-95',
        className,
      )}
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={copied ? 'check' : 'copy'}
          initial={{ opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.6, transition: spring.fast.exit }}
          transition={spring.fast}
          className="grid place-items-center"
        >
          {copied ? (
            <Check className="size-3.5 text-live" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </motion.span>
      </AnimatePresence>
    </button>
  );
}
