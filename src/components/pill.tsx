type Variant = "default" | "live" | "draft" | "category";

const VARIANTS: Record<Variant, string> = {
  default:
    "bg-paper-soft border-rule text-ink-muted",
  live:
    "bg-good/10 border-good/40 text-good",
  draft:
    "bg-paper-soft border-rule text-ink-faint",
  category:
    "bg-ink/[0.04] border-rule text-ink-soft",
};

type Props = {
  children: React.ReactNode;
  variant?: Variant;
  pulse?: boolean;
  className?: string;
};

export function Pill({ children, variant = "default", pulse = false, className = "" }: Props) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${VARIANTS[variant]} ${className}`}
    >
      {pulse && (
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            variant === "live" ? "bg-good animate-pulse" : "bg-ink-faint"
          }`}
        />
      )}
      {children}
    </span>
  );
}
