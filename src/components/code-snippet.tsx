const SNIPPET =
  "mt-4 overflow-x-auto rounded-xl px-5 py-4 text-[12px] font-mono " +
  "leading-relaxed";
const COLORS = {
  background: "var(--color-ink)",
  color: "var(--color-paper, #fff)",
};

export function CodeSnippet({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <pre className={SNIPPET} style={COLORS} tabIndex={0} role="region"
      aria-label={label}>
      {children}
    </pre>
  );
}
