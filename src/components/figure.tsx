type Props = {
  number: string;
  title: string;
  source?: string;
  note?: React.ReactNode;
  children: React.ReactNode;
};

export function Figure({ number, title, source, note, children }: Props) {
  return (
    <figure className="my-10">
      <figcaption className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-faint">
          Fig.&nbsp;{number}
        </span>
        <span className="text-base font-medium text-ink">{title}</span>
      </figcaption>

      {children}

      {(source || note) && (
        <div className="mt-3 flex flex-col gap-1.5 text-[11px] leading-relaxed">
          {source && (
            <span className="text-ink-faint">
              <span className="uppercase tracking-[0.12em] text-ink-muted">Source</span>{" "}
              · {source}
            </span>
          )}
          {note && (
            <span className="text-ink-muted">
              <span className="uppercase tracking-[0.12em] text-ink-soft">Note</span> · {note}
            </span>
          )}
        </div>
      )}
    </figure>
  );
}
