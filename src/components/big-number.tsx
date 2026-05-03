import { cn } from "@/lib/utils";

type Props = {
  value: string;
  unit?: string;
  label: string;
  caption?: string;
};

export function BigNumber({ value, unit, label, caption }: Props) {
  return (
    <div className={cn("flex flex-col gap-2 px-5 py-5 bg-surface min-w-0")}>
      <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-ink-muted truncate">
        {label}
      </p>
      <p className="display-num text-2xl sm:text-3xl leading-none tabular truncate">
        {value}
        {unit && (
          <span className="ml-1 font-sans font-medium text-sm text-ink-muted">
            {unit}
          </span>
        )}
      </p>
      {caption && (
        <p className="text-xs text-ink-muted leading-snug">{caption}</p>
      )}
    </div>
  );
}
