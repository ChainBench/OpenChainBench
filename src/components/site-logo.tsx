import { useId } from "react";

/**
 * Custom "C" mark used in the masthead. Matches the redesigned brand:
 * a black C-ring with two gray right-angle markers in the top-right
 * and bottom-right corners. SVG is self-contained, no font dep.
 *
 * useId() gives every instance a unique mask id. The previous shared
 * id collided between the header (hidden via display:none on desktop)
 * and the footer, and Safari refuses to resolve a mask whose owning
 * SVG is display:none — the footer ended up painting an unmasked
 * filled circle.
 */
export function SiteLogo({ size = 22 }: { size?: number }) {
  const maskId = `site-logo-mask-${useId()}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <mask id={maskId}>
        <rect width="100" height="100" fill="white" />
        <ellipse cx="45" cy="50" rx="22" ry="40" fill="black" />
        <rect x="45" y="38" width="55" height="24" fill="black" />
      </mask>
      <circle cx="45" cy="50" r="45" fill="var(--color-ink)" mask={`url(#${maskId})`} />
      <path d="M 65 0 L 100 0 L 100 35 Z" fill="#A0A0A0" />
      <path d="M 65 100 L 100 100 L 100 65 Z" fill="#A0A0A0" />
    </svg>
  );
}
