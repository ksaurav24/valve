'use client';

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

export function HeroReveal({
  children,
  className,
  delay = 0,
  from = 'bottom',
  onView = false,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  from?: 'bottom' | 'right';
  onView?: boolean;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      className={`hero-reveal ${className ?? ''}`}
      initial={{
        opacity: 0,
        x: from === 'right' ? 24 : 0,
        y: from === 'bottom' ? 12 : 0,
      }}
      animate={onView ? undefined : { opacity: 1, x: 0, y: 0 }}
      whileInView={onView ? { opacity: 1, x: 0, y: 0 } : undefined}
      viewport={{ once: true, amount: 0.12 }}
      transition={{
        duration: reducedMotion ? 0 : 0.6,
        delay: reducedMotion ? 0 : delay,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {children}
    </motion.div>
  );
}

export function HeroHeading({ lines }: { lines: [string, string] }) {
  const reducedMotion = useReducedMotion();
  return lines.map((line, index) => (
    <span key={line} className="block overflow-hidden pb-[0.08em] -mb-[0.08em]">
      <motion.span
        className="hero-reveal block"
        initial={{ y: '110%' }}
        animate={{ y: 0 }}
        transition={{
          duration: reducedMotion ? 0 : 0.8,
          delay: reducedMotion ? 0 : index * 0.1,
          ease: [0.22, 1, 0.36, 1],
        }}
      >
        {line}
      </motion.span>
      {index === 0 ? ' ' : null}
    </span>
  ));
}
