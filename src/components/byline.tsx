import { formatLastRun } from "@/data/benchmarks";

type Props = {
  number: string;
  category: string;
  lastRunAt: string;
  sampleSize: number;
};

export function Byline({ number, category, lastRunAt, sampleSize }: Props) {
  return (
    <div className="border-y border-rule py-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] uppercase tracking-[0.16em] text-ink-muted font-medium">
      <span>Bench №&nbsp;{number}</span>
      <span>{category}</span>
      <span className="sm:text-right">Last run · {formatLastRun(lastRunAt)}</span>
      <span className="sm:text-right">
        n&nbsp;=&nbsp;{Math.round(sampleSize).toLocaleString()}
      </span>
    </div>
  );
}
