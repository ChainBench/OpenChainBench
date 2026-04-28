type Props = {
  label: string;
  number?: string;
};

export function SectionRule({ label, number }: Props) {
  return (
    <div className="my-12 flex items-center gap-4">
      <span className="h-px flex-1 bg-ink" />
      <span className="font-sans text-[11px] uppercase tracking-[0.24em] text-ink">
        § {number ? `${number} · ` : ""}
        {label}
      </span>
      <span className="h-px flex-1 bg-ink" />
    </div>
  );
}
