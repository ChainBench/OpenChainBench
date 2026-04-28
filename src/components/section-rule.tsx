type Props = {
  label: string;
};

export function SectionRule({ label }: Props) {
  return (
    <div className="mt-14 mb-6">
      <h2 className="text-xs font-medium uppercase tracking-[0.18em] text-ink-faint">
        {label}
      </h2>
      <div className="mt-2 h-px bg-rule" />
    </div>
  );
}
