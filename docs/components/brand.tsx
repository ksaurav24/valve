export function Brand() {
  return (
    <span className="valve-brand">
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <path
          d="M4 10h7l5 12 5-12h7"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M16 4v9M11 4h10"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span>valve</span>
      <span className="valve-version">0.1.0</span>
    </span>
  );
}
