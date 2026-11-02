import { useEffect, useState } from "react";
import { continueRender, delayRender, staticFile } from "remotion";

/**
 * Loads the three brand faces from public/ before the first frame is written.
 *
 * Without the delayRender gate, Remotion screenshots frame 0 while the faces
 * are still loading and the opening second of the film renders in a system
 * fallback at a different width, which shows up as a visible snap once the
 * real face arrives.
 */
const FACES: Array<[string, string, number]> = [
  ["Inter Tight", "fonts/InterTight-latin.woff2", 700],
  ["Inter", "fonts/Inter-latin.woff2", 400],
  ["JetBrains Mono", "fonts/JetBrainsMono-latin.woff2", 400],
];

export function useBrandFonts(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const handle = delayRender("loading brand fonts");
    let cancelled = false;

    Promise.all(
      FACES.map(async ([family, file, weight]) => {
        const face = new FontFace(family, `url(${staticFile(file)}) format("woff2")`, {
          weight: String(weight),
          display: "block",
        });
        await face.load();
        // FontFaceSet.add exists in every browser Remotion renders in; the
        // DOM lib shipped with this tsconfig does not declare it.
        (document.fonts as unknown as { add: (f: FontFace) => void }).add(face);
      }),
    )
      .then(() => document.fonts.ready)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        continueRender(handle);
      })
      .catch(() => {
        // A missing face must not hang the render: fall through to the stack
        // in theme.ts and let the frame be written.
        if (cancelled) return;
        setReady(true);
        continueRender(handle);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return ready;
}
