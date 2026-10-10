'use client';

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';

/** Motion follows the OS setting: position changes drop out, fades remain. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
