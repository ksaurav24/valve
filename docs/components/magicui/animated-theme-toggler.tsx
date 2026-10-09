'use client';

// Adapted from Magic UI's Animated Theme Toggler (MIT).
// https://magicui.design/r/animated-theme-toggler.json
// Controlled by next-themes; retains Magic UI's percentage-based circular reveal.
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTheme } from 'next-themes';

export function AnimatedThemeToggler({
  className = '',
}: {
  className?: string;
}) {
  const { setTheme } = useTheme();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [transitioning, setTransitioning] = useState(false);

  async function toggleTheme() {
    if (
      busy.current ||
      document.documentElement.dataset.themeTransition === 'active'
    )
      return;
    const root = document.documentElement;
    const next = root.classList.contains('dark') ? 'light' : 'dark';
    const applyTheme = () => {
      root.classList.toggle('dark', next === 'dark');
      setTheme(next);
    };
    if (
      typeof document.startViewTransition !== 'function' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      !buttonRef.current
    ) {
      applyTheme();
      return;
    }

    busy.current = true;
    setTransitioning(true);
    const { left, top, width, height } =
      buttonRef.current.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const radius = Math.hypot(
      Math.max(x, viewportWidth - x),
      Math.max(y, viewportHeight - y),
    );
    const origin = `${(x / viewportWidth) * 100}% ${(y / viewportHeight) * 100}%`;
    const endRadius =
      (radius / (Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2)) * 100;
    const clipPath = [
      `circle(0% at ${origin})`,
      `circle(${endRadius}% at ${origin})`,
    ];
    let animation: Animation | undefined;
    root.dataset.themeTransition = 'active';
    root.style.setProperty('--theme-reveal-start', clipPath[0]);
    try {
      const transition = document.startViewTransition(() =>
        flushSync(applyTheme),
      );
      try {
        await transition.ready;
        animation = root.animate(
          { clipPath },
          {
            duration: 420,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'forwards',
            pseudoElement: '::view-transition-new(root)',
          },
        );
        await animation.finished;
      } finally {
        // Capture failures leave the new theme applied; allow the transition to finish.
        await transition.finished.catch(() => undefined);
      }
    } catch {
      applyTheme();
    } finally {
      animation?.cancel();
      delete root.dataset.themeTransition;
      root.style.removeProperty('--theme-reveal-start');
      busy.current = false;
      setTransitioning(false);
    }
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      className={`animated-theme-toggle ${className}`}
      aria-label="Toggle color theme"
      title="Toggle color theme"
      disabled={transitioning}
      onClick={toggleTheme}
    >
      <span className="theme-icons" aria-hidden="true">
        <svg
          className="theme-sun"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </svg>
        <svg
          className="theme-moon"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
        >
          <path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z" />
        </svg>
      </span>
    </button>
  );
}
