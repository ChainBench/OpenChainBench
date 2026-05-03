"use client";

import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";

type Template = {
  id: string;
  label: string;
  description: string;
};

const TEMPLATES: Template[] = [
  {
    id: "ranking",
    label: "Ranking",
    description: "Provider bars sorted by p50, with values and tail at p99.",
  },
  {
    id: "snapshot",
    label: "Snapshot",
    description: "24-hour multi-line chart of every provider, with a legend.",
  },
];

type Props = {
  slug: string;
  title: string;
};

export function ShareSection({ slug, title }: Props) {
  const [activeId, setActiveId] = useState<string>("ranking");

  const cardSrc = (templateId: string) =>
    `/benchmarks/${slug}/share-card?template=${templateId}`;

  async function handleDownload(templateId: string) {
    const url = cardSrc(templateId);
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${slug}-${templateId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error("download failed", err);
    }
  }

  return (
    <details className="mt-1 group border-t border-rule">
      <summary className="flex cursor-pointer items-center justify-between py-4 list-none">
        <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-ink">
          Share · export · embed
        </span>
        <ChevronDown
          size={16}
          strokeWidth={2}
          className="text-ink-muted transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="pb-6 space-y-5">
        <p className="text-sm text-ink-muted leading-relaxed max-w-2xl">
          Pick a layout and download a 1200×630 PNG ready for Twitter, Reddit, LinkedIn or any OG-card embed. Same data, same colors as this dashboard.
        </p>

        {/* Tabs */}
        <div className="flex flex-wrap items-center gap-1 border border-rule rounded p-1 bg-paper-soft w-fit">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveId(t.id)}
              className={`px-3 py-1.5 text-xs font-medium uppercase tracking-[0.14em] rounded transition-colors ${
                activeId === t.id
                  ? "bg-paper text-ink shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Active preview */}
        {TEMPLATES.map((t) => {
          if (t.id !== activeId) return null;
          return (
            <div key={t.id} className="space-y-3">
              <p className="text-xs text-ink-muted">{t.description}</p>
              <div className="border border-rule rounded overflow-hidden bg-paper-soft">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cardSrc(t.id)}
                  alt={`${title} — ${t.label} share card`}
                  width={1200}
                  height={630}
                  className="w-full h-auto"
                  loading="lazy"
                />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => handleDownload(t.id)}
                  className="btn-primary btn-primary--sm inline-flex items-center gap-1.5"
                >
                  <Download size={14} strokeWidth={2.2} />
                  Download PNG
                </button>
                <a
                  href={cardSrc(t.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium uppercase tracking-[0.14em] text-ink-muted hover:text-ink"
                >
                  Open raw ↗
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}
