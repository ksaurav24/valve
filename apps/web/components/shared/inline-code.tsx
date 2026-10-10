/** Renders changelog text with `backtick` spans as code; no other markdown. */
export function InlineCode({ text }: { text: string }) {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code
        key={index}
        className="rounded border border-border bg-muted px-1 py-px font-mono text-[0.85em] text-foreground"
      >
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
