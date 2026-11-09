/**
 * The CraftPanel mark: an isometric block with a console prompt. Paths from the brand package
 * (small-size variant with the bolder prompt, since the dashboard never shows it above 48 px).
 * The top face is lighter on dark surfaces; the colours belong to the mark, not to the theme tokens.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 110.85" className={className} aria-hidden>
      <path
        d="M46.8 0.69C47.54 0.26 48.46 0.26 49.2 0.69L94.8 27.02C95.54 27.45 96 28.24 96 29.1V81.75C96 82.61 95.54 83.4 94.8 83.83L49.2 110.16C48.46 110.59 47.54 110.59 46.8 110.16L1.2 83.83C0.46 83.4 0 82.61 0 81.75V29.1C0 28.24 0.46 27.45 1.2 27.02Z"
        fill="#363C43"
      />
      <path d="M48 55.43V110.48C47.59 110.48 47.17 110.37 46.8 110.16L1.2 83.83C0.46 83.4 0 82.61 0 81.75V29.1C0 28.67 0.11 28.26 0.32 27.9Z" fill="#5C646C" />
      <path
        d="M48 55.43 0.32 27.9C0.53 27.54 0.83 27.23 1.2 27.02L46.8 0.69C47.54 0.26 48.46 0.26 49.2 0.69L94.8 27.02C95.17 27.23 95.47 27.54 95.68 27.9Z"
        className="fill-[#C6CBC5] dark:fill-[#E6E8E3]"
      />
      <path d="M64.17 77.51 52.62 62.66 59.56 53.7 61.71 56.46 74.71 73.18 57.91 100.19 52.48 96.29Z" fill="#5BBF4A" />
      <path d="M87.44 81.2 73.76 89.09V79.67L77.84 77.32L91.52 69.42V78.84Z" fill="#E6E8E3" />
    </svg>
  );
}
