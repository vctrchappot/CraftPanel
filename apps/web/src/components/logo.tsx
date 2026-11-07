export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden>
      <rect x="1" y="1" width="30" height="30" rx="8" className="fill-foreground" />
      <path d="M9 11.5 16 8l7 3.5v9L16 24l-7-3.5v-9Z" className="stroke-background" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 11.5 16 15l7-3.5M16 15v9" className="stroke-background" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
