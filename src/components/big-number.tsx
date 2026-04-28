import { cn } from "@/lib/utils";

type Props = {
  value: string;
  unit?: string;
  label: string;
  caption?: string;
  emphasis?: boolean;
  color?: string;
};

export function BigNumber({ value, unit, label, caption, emphasis, color }: Props) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-6 py-5 bg-bg-elev",
        emphasis && "ring-1 ring-inset ring-ink/10"
      )}
    >
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted">
        {label}
      </p>
      <p className="display text-3xl sm:text-4xl leading-none" style={color ? { color } : undefined}>
        {value}
        {unit && (
          <span className="ml-1 font-sans font-medium text-lg text-ink-muted">
            {unit}
          </span>
        )}
      </p>
      {caption && (
        <p className="text-xs text-ink-muted leading-relaxed">{caption}</p>
      )}
    </div>
  );
}
