import { formatLastRun } from "@/data/benchmarks";

type Props = {
  number: string;
  category: string;
  lastRunAt: string;
  sampleSize: number;
};

export function Byline({ number, category, lastRunAt, sampleSize }: Props) {
  return (
    <div className="border-y border-ink/80 py-3 grid grid-cols-2 sm:grid-cols-4 gap-2 font-sans text-[10px] uppercase tracking-[0.18em] text-ink-soft">
      <span>Bench №&nbsp;{number}</span>
      <span>{category}</span>
      <span className="sm:text-right">Last run · {formatLastRun(lastRunAt)}</span>
      <span className="sm:text-right">n&nbsp;=&nbsp;{sampleSize.toLocaleString()}</span>
    </div>
  );
}
