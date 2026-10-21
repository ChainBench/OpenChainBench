import type React from "react";
import { legibleBench, themeFor } from "./theme";

/**
 * Wraps a bench composition so it only ever sees colours that read on its
 * background (see legibleBench). Applied once in Root, so no composition
 * can forget it.
 */
export function withLegible<P extends { theme: "light" | "dark"; bench?: unknown }>(C: React.FC<P>): React.FC<P> {
  const Wrapped: React.FC<P> = (props) => {
    const b = props.bench as { providers?: { color: string }[] } | undefined;
    if (!b?.providers) return <C {...props} />;
    return <C {...props} bench={legibleBench(b as { providers: { color: string }[] }, themeFor(props.theme))} />;
  };
  return Wrapped;
}
