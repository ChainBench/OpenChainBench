/**
 * Tiny pulsing green dot used inline in section labels to signal that
 * the surrounding figure reflects live data. Discreet by design - when
 * paired with the masthead `LiveIndicator`, this is just visual reinforcement.
 */
export function LiveDot({ className = "" }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex h-1.5 w-1.5 items-center justify-center align-middle ${className}`}
      aria-hidden
    >
      <span className="absolute inset-0 rounded-full bg-good opacity-60 animate-ping" />
      <span className="relative h-1.5 w-1.5 rounded-full bg-good" />
    </span>
  );
}
