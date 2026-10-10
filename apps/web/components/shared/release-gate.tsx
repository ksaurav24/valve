import type { ReactNode } from 'react';
import { current } from '@/lib/releases';

/** Docs text that is true only until the current version is on npm. */
export function Unpublished({ children }: { children: ReactNode }) {
  return current.state === 'dev' ? children : null;
}

/** Docs text that is true only once the current version is on npm. */
export function Published({ children }: { children: ReactNode }) {
  return current.state === 'dev' ? null : children;
}
