import { cn } from "@/lib/utils";

type Props = {
  value: string;
  unit?: string;
  label: string;
  caption?: string;
};

export function BigNumber({ value, unit, label, caption }: Props) {
  return (
    <div className={cn("flex flex-col gap-2 px-5 py-5 border-y border-ink/30")}>
      <p className="font-sans text-[10px] uppercase tracking-[0.22em] text-ink-muted">
        {label}
      </p>
      <p className="display-num text-3xl sm:text-4xl leading-none">
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
