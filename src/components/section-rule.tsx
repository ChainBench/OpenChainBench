type Props = {
  label: string;
  /** Kept optional for backwards compat — currently ignored. */
  number?: string;
};

export function SectionRule({ label }: Props) {
  return (
    <div className="mt-14 mb-7">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </h2>
      <div className="mt-2 h-px bg-rule" />
    </div>
  );
}
