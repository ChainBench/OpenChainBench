"use client";

import { useEffect, useState, useTransition } from "react";

type Region = { region: string; service: string; logsUrl: string };

type Props = {
  slug: string;
  service: string;
  rawUrl: string;
  extraRegions?: Region[];
};

export function LogsButton({ slug, service, rawUrl, extraRegions }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-[11px] px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900"
      >
        logs
      </button>
      {open && (
        <LogsModal
          slug={slug}
          service={service}
          rawUrl={rawUrl}
          extraRegions={extraRegions}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function LogsModal({
  slug,
  service,
  rawUrl,
  extraRegions,
  onClose,
}: Props & { onClose: () => void }) {
  const regions = [
    { region: "primary", service, rawUrl },
    ...(extraRegions ?? []).map((r) => ({ region: r.region, service: r.service, rawUrl: r.logsUrl })),
  ];
  const [region, setRegion] = useState(regions[0].region);
  const [tail, setTail] = useState(300);
  const [text, setText] = useState<string>("loading…");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const active = regions.find((r) => r.region === region) ?? regions[0];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    startTransition(async () => {
      setError(null);
      try {
        const qs = new URLSearchParams({ tail: String(tail) });
        if (region !== "primary") qs.set("region", region);
        const res = await fetch(`/api/logs/${slug}?${qs}`, { cache: "no-store" });
        const body = await res.text();
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setText(body);
        } else {
          setText(body || "(empty)");
        }
      } catch (e) {
        setError((e as Error).message);
        setText("");
      }
    });
  }, [slug, region, tail]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-950 border border-neutral-700 rounded-lg w-full max-w-5xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-bold">
              <span className="text-emerald-400">{slug}</span>{" "}
              <span className="text-neutral-500">·</span>{" "}
              <span className="text-neutral-400 font-normal">{active.service}</span>
            </h2>
            {regions.length > 1 && (
              <div className="flex gap-1">
                {regions.map((r) => (
                  <button
                    key={r.region}
                    onClick={() => setRegion(r.region)}
                    className={`text-[10px] px-2 py-0.5 rounded border ${
                      r.region === region
                        ? "border-emerald-700 bg-emerald-900/40 text-emerald-300"
                        : "border-neutral-700 text-neutral-500 hover:text-neutral-200"
                    }`}
                  >
                    {r.region === "primary" ? "us" : r.region}
                  </button>
                ))}
              </div>
            )}
            <select
              value={tail}
              onChange={(e) => setTail(Number(e.target.value))}
              className="text-[10px] bg-neutral-900 border border-neutral-700 rounded px-1 py-0.5"
            >
              <option value={100}>tail 100</option>
              <option value={300}>tail 300</option>
              <option value={1000}>tail 1000</option>
              <option value={3000}>tail 3000</option>
            </select>
            {pending && <span className="text-[10px] text-neutral-500">loading…</span>}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={active.rawUrl}
              target="_blank"
              rel="noopener"
              className="text-[10px] text-neutral-400 hover:text-neutral-200 underline"
            >
              raw page ↗
            </a>
            <button
              onClick={onClose}
              className="text-neutral-500 hover:text-neutral-200 text-lg leading-none px-1"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>
        {error && (
          <div className="px-4 py-2 text-[11px] text-rose-400 border-b border-rose-900/50 bg-rose-950/30">
            {error}
          </div>
        )}
        <pre className="flex-1 overflow-auto p-4 text-[11px] leading-snug text-neutral-300 whitespace-pre-wrap font-mono">
          {text}
        </pre>
      </div>
    </div>
  );
}
