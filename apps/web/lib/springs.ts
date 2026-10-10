// Tuned to the site's motion budget: button feedback 100-180ms (fast),
// dropdowns and popovers 150-220ms (moderate). `slow` is for dialogs only.
export const spring = {
  fast: {
    type: 'spring' as const,
    duration: 0.12,
    bounce: 0,
    exit: { duration: 0.1 },
  },
  // Critically damped: same perceived speed as a bouncier tier, but lands
  // exactly with no overshoot, for short travel and panels/sheets that must
  // settle precisely (dropdowns, tabs, drawers, merged selection backgrounds).
  moderate: {
    type: 'spring' as const,
    duration: 0.18,
    bounce: 0,
    exit: { duration: 0.15 },
  },
  slow: {
    type: 'spring' as const,
    duration: 0.24,
    bounce: 0.12,
    exit: { duration: 0.16 },
  },
} as const;

// Fallback delay (ms) for deferred-unmount timers that guard an exit tween:
// popups keep their portal mounted until onAnimationComplete fires, but a
// throttled/background tab can stall the animation, so a timer force-unmounts
// after the tier's exit duration plus a safety buffer. Deriving it here keeps
// the timers in step with the tokens above.
export const exitFallbackMs = (tier: { exit: { duration: number } }) =>
  Math.round(tier.exit.duration * 1000) + 100;
