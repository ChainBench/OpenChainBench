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
        <span className="benchmark-mark">Fig.&nbsp;{number}</span>
        <span className="editorial text-[15px] text-ink-soft">{title}</span>
      </figcaption>

      {children}

      {(source || note) && (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-rule pt-3 text-[11px] leading-relaxed">
          {source && (
            <span className="text-ink-muted">
              <span className="uppercase tracking-[0.12em] text-ink-soft">Source</span>{" "}
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
