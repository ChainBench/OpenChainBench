import { cn } from "@/lib/utils";

type Props = {
  value: string;
  unit?: string;
  label: string;
  caption?: string;
  emphasis?: boolean;
};

export function BigNumber({ value, unit, label, caption, emphasis }: Props) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 px-5 py-5",
        emphasis ? "bg-paper-deep/70 border-y-2 border-ink" : "border-y border-ink/30"
      )}
    >
      <p className="font-sans text-[10px] uppercase tracking-[0.22em] text-ink-muted">
        {label}
      </p>
      <p className="display-num text-4xl sm:text-5xl leading-none">
        {value}
        {unit && (
          <span className="ml-1 font-serif font-normal italic text-xl text-ink-soft">
            {unit}
          </span>
        )}
      </p>
      {caption && (
        <p className="font-serif italic text-sm text-ink-soft">{caption}</p>
      )}
    </div>
  );
}
