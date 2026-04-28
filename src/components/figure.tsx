type Props = {
  number: string;
  title: string;
  source?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * Wraps any chart/table with a "Fig. N — Title" caption above and a
 * Source/Note line below — the typographic skeleton of an editorial figure.
 */
export function Figure({ number, title, source, note, children }: Props) {
  return (
    <figure className="my-10">
      <figcaption className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule pb-2">
        <span className="font-sans text-[11px] uppercase tracking-[0.22em] text-ink">
          Fig.&nbsp;{number}
        </span>
        <span className="font-serif italic text-ink-soft">{title}</span>
      </figcaption>

      {children}

      {(source || note) && (
        <div className="mt-3 flex flex-col gap-1 border-t border-rule pt-2 font-sans text-[10px] uppercase tracking-[0.16em] text-ink-muted">
          {source && (
            <span>
              <span className="text-ink">Source:</span> {source}
            </span>
          )}
          {note && (
            <span className="normal-case tracking-normal italic font-serif text-[11px] text-ink-soft">
              <span className="font-sans uppercase tracking-[0.16em] text-ink">
                Note:
              </span>{" "}
              {note}
            </span>
          )}
        </div>
      )}
    </figure>
  );
}
