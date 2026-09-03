"use client";

/**
 * Client-side RPC speed test. The Speedtest.net moment for RPC endpoints:
 * the user pastes any number of RPC URLs, picks a duration, and the
 * browser probes them directly — same anti-cache methodology as the
 * public OCB harnesses (eth_getBlockByNumber("latest", false) with a
 * rotating JSON-RPC id, ok/http_err/jsonrpc_err/stale/timeout
 * classification).
 *
 * Everything runs in the user's browser from the user's IP. URLs (and
 * any embedded API keys) never touch OCB servers — requests go straight
 * browser → provider. Zero server cost per test by construction.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────

type Verdict = "ok" | "http_err" | "jsonrpc_err" | "timeout";

type Sample = {
  ms: number;
  verdict: Verdict;
  block: number | null;
  round: number;
};

type EpStatus =
  | "pending"
  | "checking"
  | "ready"
  | "cors_blocked"
  | "invalid"
  | "testing"
  | "done";

type Endpoint = {
  id: string;
  url: string;
  host: string;
  status: EpStatus;
  chainId: string | null;
  samples: Sample[];
  staleRounds: number;
  lastMs: number | null;
  error?: string;
};

type Stage = "setup" | "testing" | "results";

// ─── Probe engine ────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 5_000;
const STALE_BLOCKS = 20;

let idCounter = 0;
function rpcId(): string {
  // Rotating id defeats body-keyed edge caches — identical to the
  // harness payload contract documented on /methodology.
  idCounter += 1;
  return `ocb-st-${Date.now().toString(36)}-${idCounter}`;
}

async function rpcCall(
  url: string,
  method: string,
  params: unknown[],
): Promise<{ ms: number; verdict: Verdict; result: unknown; block: number | null }> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpcId(), method, params });
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Never send cookies/credentials to third-party RPC endpoints.
      credentials: "omit",
      cache: "no-store",
    });
    const ms = performance.now() - t0;
    if (!res.ok) return { ms, verdict: "http_err", result: null, block: null };
    let json: { result?: { number?: string } | string; error?: unknown };
    try {
      json = await res.json();
    } catch {
      return { ms, verdict: "jsonrpc_err", result: null, block: null };
    }
    if (json.error || json.result == null)
      return { ms, verdict: "jsonrpc_err", result: null, block: null };
    let block: number | null = null;
    if (typeof json.result === "object" && typeof json.result.number === "string") {
      block = parseInt(json.result.number, 16);
      if (Number.isNaN(block)) block = null;
    }
    return { ms, verdict: "ok", result: json.result, block };
  } catch (e) {
    const ms = performance.now() - t0;
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return { ms, verdict: "timeout", result: null, block: null };
    }
    // TypeError from fetch = network-level failure. From a browser this
    // is almost always CORS (the response exists but is opaque to us).
    throw e;
  }
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(ep: Endpoint) {
  const okMs = ep.samples.filter((s) => s.verdict === "ok").map((s) => s.ms).sort((a, b) => a - b);
  const n = ep.samples.length;
  const ok = okMs.length;
  return {
    n,
    ok,
    successPct: n === 0 ? 0 : Math.round((ok / n) * 100),
    p50: quantile(okMs, 0.5),
    p90: quantile(okMs, 0.9),
    min: okMs[0] ?? NaN,
    max: okMs[okMs.length - 1] ?? NaN,
  };
}

// ─── Gauge geometry ──────────────────────────────────────────────────

/** Log-ish scale stops mapped onto a 240° arc, speedometer-style. */
const GAUGE_STOPS = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
const GAUGE_START = -210; // degrees; sweep 240° to +30
const GAUGE_SWEEP = 240;

function msToAngle(ms: number): number {
  const clamped = Math.max(1, Math.min(1000, ms));
  const t = Math.log(clamped / 1) / Math.log(1000 / 1); // 0..1 log scale
  return GAUGE_START + t * GAUGE_SWEEP;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function msColor(ms: number): string {
  if (ms < 50) return "var(--color-good)";
  if (ms < 200) return "var(--color-warn)";
  return "#ef4444";
}

function Gauge({
  ms,
  label,
  sub,
  className = "mx-auto w-[280px] sm:w-[340px]",
}: {
  ms: number | null;
  label: string;
  sub: string;
  className?: string;
}) {
  const angle = ms == null ? GAUGE_START : msToAngle(ms);
  return (
    <div className={`relative ${className}`}>
      <svg viewBox="0 0 200 170" className="w-full">
        {/* Track */}
        <path
          d={arcPath(100, 100, 78, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
          fill="none"
          stroke="var(--color-rule, #e2e8f0)"
          strokeWidth="10"
          strokeLinecap="round"
        />
        {/* Colored zones: <50 good, 50-200 warn, >200 danger */}
        <path
          d={arcPath(100, 100, 78, GAUGE_START, msToAngle(50))}
          fill="none" stroke="var(--color-good)" strokeWidth="10" strokeLinecap="round" opacity="0.85"
        />
        <path
          d={arcPath(100, 100, 78, msToAngle(50), msToAngle(200))}
          fill="none" stroke="var(--color-warn)" strokeWidth="10" opacity="0.75"
        />
        <path
          d={arcPath(100, 100, 78, msToAngle(200), GAUGE_START + GAUGE_SWEEP)}
          fill="none" stroke="#ef4444" strokeWidth="10" strokeLinecap="round" opacity="0.55"
        />
        {/* Scale labels */}
        {GAUGE_STOPS.map((stop) => {
          const [x, y] = polar(100, 100, 60, msToAngle(stop));
          return (
            <text
              key={stop}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="8"
              fill="var(--color-ink-faint)"
              fontFamily="var(--font-mono, monospace)"
            >
              {stop}
            </text>
          );
        })}
        {/* Needle */}
        <g
          style={{
            transform: `rotate(${angle + 90}deg)`,
            transformOrigin: "100px 100px",
            transition: "transform 0.45s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <line x1="100" y1="100" x2="100" y2="32" stroke="var(--color-ink)" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="100" cy="100" r="5" fill="var(--color-ink)" />
        </g>
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div
          className="display text-3xl sm:text-4xl tabular-nums leading-none"
          style={{ color: ms == null ? "var(--color-ink-faint)" : msColor(ms) }}
        >
          {ms == null ? "—" : Math.round(ms)}
          <span className="text-sm ml-1 text-ink-faint">ms</span>
        </div>
        <p className="mt-1 label-mono text-[11px] text-ink truncate max-w-[90%] mx-auto">{label}</p>
        <p className="label-mono text-[10px] text-ink-faint truncate">{sub}</p>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────

const DURATIONS = [
  { sec: 15, label: "15 s · quick" },
  { sec: 30, label: "30 s · standard" },
  { sec: 60, label: "60 s · thorough" },
];

const EXAMPLE_URLS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://1rpc.io/eth",
];

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function SpeedtestRpcClient() {
  const [stage, setStage] = useState<Stage>("setup");
  const [inputs, setInputs] = useState<string[]>(["", ""]);
  const [durationSec, setDurationSec] = useState(30);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [round, setRound] = useState(0);
  const abortRef = useRef<{ stop: boolean }>({ stop: false });

  const setInput = (i: number, v: string) =>
    setInputs((xs) => xs.map((x, j) => (j === i ? v : x)));
  const addInput = () => setInputs((xs) => [...xs, ""]);
  const removeInput = (i: number) =>
    setInputs((xs) => (xs.length <= 1 ? xs : xs.filter((_, j) => j !== i)));

  const validCount = inputs.filter((u) => {
    try {
      const p = new URL(u.trim());
      return p.protocol === "https:" && !p.username && !p.password;
    } catch {
      return false;
    }
  }).length;

  // ── Test orchestration ────────────────────────────────────────────
  const start = useCallback(async () => {
    const urls = Array.from(
      new Set(
        inputs
          .map((u) => u.trim())
          .filter((u) => {
            try {
              const p = new URL(u);
              return p.protocol === "https:" && !p.username && !p.password;
            } catch {
              return false;
            }
          }),
      ),
    );
    if (urls.length === 0) return;
    abortRef.current = { stop: false };
    const eps: Endpoint[] = urls.map((url, i) => ({
      id: `ep${i}`,
      url,
      host: hostOf(url),
      status: "checking",
      chainId: null,
      samples: [],
      staleRounds: 0,
      lastMs: null,
    }));
    setEndpoints(eps);
    setStage("testing");
    setElapsed(0);
    setRound(0);

    const patch = (id: string, p: Partial<Endpoint>) =>
      setEndpoints((xs) => xs.map((e) => (e.id === id ? { ...e, ...p } : e)));

    // Phase 1: reachability + chain detection (eth_chainId), sequential
    // so the gauge can narrate each endpoint as it comes online.
    for (const ep of eps) {
      if (abortRef.current.stop) return;
      setActiveId(ep.id);
      try {
        const r = await rpcCall(ep.url, "eth_chainId", []);
        const chainId =
          r.verdict === "ok" && typeof r.result === "string" ? r.result : null;
        ep.chainId = chainId;
        ep.status = "ready";
        patch(ep.id, { chainId, status: "ready", lastMs: r.ms });
      } catch {
        ep.status = "cors_blocked";
        patch(ep.id, {
          status: "cors_blocked",
          error:
            "This endpoint does not answer browser requests (no CORS headers on preflight) — dapps cannot call it from a browser either. It may still be fast server-side: measure it from a terminal with the curl below.",
        });
      }
    }
    const live = eps.filter((e) => e.status === "ready");
    if (live.length === 0) {
      setStage("results");
      return;
    }

    // Phase 2: one warmup each (absorbs TCP+TLS so measured rounds see
    // steady-state round trips, same reasoning as the harness).
    for (const ep of live) {
      if (abortRef.current.stop) return;
      setActiveId(ep.id);
      patch(ep.id, { status: "testing" });
      try {
        const w = await rpcCall(ep.url, "eth_getBlockByNumber", ["latest", false]);
        patch(ep.id, { lastMs: w.ms });
      } catch {
        /* keep it in the pool; measured rounds will classify */
      }
    }

    // Phase 3: measured rounds until the clock runs out. Order is
    // re-shuffled every round so network wake-ups hit endpoints evenly.
    const tEnd = performance.now() + durationSec * 1000;
    const t0 = performance.now();
    let roundNo = 0;
    const timer = setInterval(
      () => setElapsed(Math.min(durationSec, (performance.now() - t0) / 1000)),
      200,
    );
    try {
      while (performance.now() < tEnd && !abortRef.current.stop) {
        roundNo += 1;
        setRound(roundNo);
        const order = [...live].sort(() => Math.random() - 0.5);
        const roundBlocks: Record<string, number | null> = {};
        for (const ep of order) {
          if (performance.now() >= tEnd || abortRef.current.stop) break;
          setActiveId(ep.id);
          let sample: Sample;
          try {
            const r = await rpcCall(ep.url, "eth_getBlockByNumber", ["latest", false]);
            sample = { ms: r.ms, verdict: r.verdict, block: r.block, round: roundNo };
          } catch {
            sample = { ms: PROBE_TIMEOUT_MS, verdict: "timeout", block: null, round: roundNo };
          }
          roundBlocks[ep.id] = sample.block;
          ep.samples.push(sample);
          patch(ep.id, { samples: [...ep.samples], lastMs: sample.ms });
          // Politeness gap so we never hammer a provider.
          await new Promise((r) => setTimeout(r, 150));
        }
        // Stale detection: an endpoint more than STALE_BLOCKS behind the
        // best tip seen this round is serving an old head.
        const tips = Object.values(roundBlocks).filter((b): b is number => b != null);
        if (tips.length >= 2) {
          const best = Math.max(...tips);
          for (const ep of live) {
            const b = roundBlocks[ep.id];
            if (b != null && best - b > STALE_BLOCKS) {
              ep.staleRounds += 1;
              patch(ep.id, { staleRounds: ep.staleRounds });
            }
          }
        }
      }
    } finally {
      clearInterval(timer);
    }
    for (const ep of live) patch(ep.id, { status: "done" });
    setActiveId(null);
    // Small beat before the reveal — lets the last needle move land.
    await new Promise((r) => setTimeout(r, 650));
    setStage("results");
  }, [inputs, durationSec]);

  const stop = useCallback(() => {
    abortRef.current.stop = true;
  }, []);

  useEffect(() => () => { abortRef.current.stop = true; }, []);

  const ranked = useMemo(() => {
    const done = endpoints.filter((e) => e.samples.length > 0);
    return done
      .map((e) => ({ ep: e, s: stats(e) }))
      .sort((a, b) => (Number.isNaN(a.s.p50) ? 1 : Number.isNaN(b.s.p50) ? -1 : a.s.p50 - b.s.p50));
  }, [endpoints]);
  const maxP50 = Math.max(...ranked.map((r) => (Number.isNaN(r.s.p50) ? 0 : r.s.p50)), 1);

  const reset = () => {
    abortRef.current.stop = true;
    setStage("setup");
    setEndpoints([]);
    setActiveId(null);
    setElapsed(0);
  };

  return (
    <div className="mt-8">
      <style>{`
        @keyframes st-fade-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
        @keyframes st-fade { from { opacity: 0; } to { opacity: 1; } }
        @keyframes st-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
        .st-stage { animation: st-fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both; }
        .st-row { animation: st-fade-up 0.55s cubic-bezier(0.22,1,0.36,1) both; }
        .st-live { animation: st-pulse 1.6s ease-in-out infinite; }
        .st-bar { transition: width 0.8s cubic-bezier(0.22,1,0.36,1); }
      `}</style>

      {/* ── Stage: setup ─────────────────────────────────────────── */}
      {stage === "setup" && (
        <section className="st-stage card-soft rounded-xl p-5 sm:p-8">
          <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint mb-4">
            1 · Endpoints
          </p>
          <div className="space-y-2">
            {inputs.map((u, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={u}
                  onChange={(e) => setInput(i, e.target.value)}
                  placeholder={EXAMPLE_URLS[i % EXAMPLE_URLS.length]}
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 rounded-md border border-rule bg-transparent px-3 py-2.5 font-mono text-[13px] text-ink placeholder:text-ink-faint/60 focus:border-ink/50 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => removeInput(i)}
                  aria-label="Remove endpoint"
                  className="px-3 rounded-md border border-rule text-ink-faint hover:text-ink hover:border-ink/40 transition-colors"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={addInput}
              className="label-mono text-[11px] border border-rule rounded-md px-3 py-1.5 text-ink-soft hover:text-ink hover:border-ink/40 transition-colors"
            >
              + Add endpoint
            </button>
            <button
              type="button"
              onClick={() => setInputs(EXAMPLE_URLS.slice())}
              className="label-mono text-[11px] text-ink-faint hover:text-ink transition-colors"
            >
              Try with public Ethereum RPCs
            </button>
          </div>

          <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint mt-8 mb-3">
            2 · Duration
          </p>
          <div className="flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button
                key={d.sec}
                type="button"
                onClick={() => setDurationSec(d.sec)}
                className={`label-mono text-[12px] rounded-md px-4 py-2 border transition-colors ${
                  durationSec === d.sec
                    ? "border-ink bg-ink text-paper"
                    : "border-rule text-ink-soft hover:border-ink/40"
                }`}
                style={durationSec === d.sec ? { background: "var(--color-ink)", color: "var(--color-paper, #fff)" } : undefined}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div className="mt-8 flex items-center gap-4">
            <button
              type="button"
              disabled={validCount === 0}
              onClick={start}
              className="display text-lg rounded-full px-8 py-3 border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ letterSpacing: "0.02em" }}
            >
              Start test →
            </button>
            <p className="text-[12px] text-ink-faint max-w-[260px] leading-snug">
              {validCount} endpoint{validCount === 1 ? "" : "s"} ready · HTTPS only ·
              runs entirely in your browser
            </p>
          </div>
        </section>
      )}

      {/* ── Stage: testing ───────────────────────────────────────── */}
      {stage === "testing" && (
        <section className="st-stage">
          <div className="card-soft rounded-xl p-5 sm:p-8">
            <div className="flex items-center justify-between mb-2">
              <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint">
                <span className="st-live inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: "var(--color-good)" }} />
                Testing from your connection · round {round}
              </p>
              <button type="button" onClick={stop} className="label-mono text-[11px] text-ink-faint hover:text-ink">
                Stop early
              </button>
            </div>

            {/* One speedometer per endpoint, all live at once. The
                active one (currently being probed) lifts and gets an
                ink border; the others keep their last reading. */}
            <div
              className={`mt-2 grid gap-4 ${
                endpoints.length <= 1
                  ? "grid-cols-1 max-w-[340px] mx-auto"
                  : endpoints.length === 2
                    ? "grid-cols-1 sm:grid-cols-2"
                    : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
              }`}
            >
              {endpoints.map((ep) => {
                const s = stats(ep);
                const isActive = ep.id === activeId;
                const blocked = ep.status === "cors_blocked";
                return (
                  <div
                    key={ep.id}
                    className="rounded-xl border px-3 pt-3 pb-4 transition-all duration-300"
                    style={{
                      borderColor: isActive ? "var(--color-ink)" : "var(--color-rule, #e2e8f0)",
                      transform: isActive ? "translateY(-2px)" : undefined,
                      boxShadow: isActive ? "0 6px 18px -8px rgba(15,23,42,0.25)" : undefined,
                      opacity: blocked ? 0.55 : 1,
                    }}
                  >
                    {blocked ? (
                      <div className="h-full min-h-[180px] flex flex-col items-center justify-center text-center px-2">
                        <p className="font-mono text-[12px] text-ink truncate max-w-full">{ep.host}</p>
                        <p className="mt-2 label-mono text-[10px] text-ink-faint">no CORS · browser-blocked</p>
                      </div>
                    ) : (
                      <>
                        <Gauge
                          ms={ep.lastMs}
                          label={ep.host}
                          sub={
                            ep.status === "checking"
                              ? "checking reachability"
                              : isActive
                                ? "probing…"
                                : "eth_getBlockByNumber"
                          }
                          className="mx-auto w-full max-w-[240px]"
                        />
                        <div className="mt-2 flex items-center justify-center gap-3 label-mono text-[10px] text-ink-faint tabular-nums">
                          <span>p50 {Number.isNaN(s.p50) ? "—" : `${Math.round(s.p50)}ms`}</span>
                          <span>{s.n} probes</span>
                          <span>{s.successPct}% ok</span>
                          {ep.staleRounds > 0 && (
                            <span style={{ color: "var(--color-warn)" }}>stale ×{ep.staleRounds}</span>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Progress */}
            <div className="mt-6 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-rule, #e2e8f0)" }}>
              <div
                className="h-full rounded-full st-bar"
                style={{ width: `${(elapsed / durationSec) * 100}%`, background: "var(--color-ink)" }}
              />
            </div>
            <p className="mt-1 text-right label-mono text-[10px] text-ink-faint tabular-nums">
              {elapsed.toFixed(0)}s / {durationSec}s
            </p>
          </div>
        </section>
      )}

      {/* ── Stage: results ───────────────────────────────────────── */}
      {stage === "results" && (
        <section className="st-stage">
          {ranked.length > 0 && !Number.isNaN(ranked[0].s.p50) && (
            <div
              className="st-row rounded-xl border-2 border-ink px-5 py-6 sm:px-8 text-center"
              style={{ animationDelay: "0.05s" }}
            >
              <p className="label-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted mb-2">
                Fastest from your connection
              </p>
              <p className="display text-3xl sm:text-4xl text-ink break-all">{ranked[0].ep.host}</p>
              <p className="mt-2 display text-5xl sm:text-6xl tabular-nums" style={{ color: msColor(ranked[0].s.p50) }}>
                {Math.round(ranked[0].s.p50)}<span className="text-xl text-ink-faint ml-1">ms p50</span>
              </p>
            </div>
          )}

          <div className="mt-4 space-y-3">
            {ranked.map(({ ep, s }, i) => (
              <div
                key={ep.id}
                className="st-row card-soft rounded-lg px-4 py-4 sm:px-5"
                style={{ animationDelay: `${0.15 + i * 0.12}s` }}
              >
                <div className="flex items-center gap-3">
                  <span className="label-mono text-[11px] text-ink-faint w-6">{String(i + 1).padStart(2, "0")}</span>
                  <p className="font-mono text-[13px] text-ink truncate flex-1">{ep.host}</p>
                  <span className="display text-xl tabular-nums" style={{ color: Number.isNaN(s.p50) ? "var(--color-ink-faint)" : msColor(s.p50) }}>
                    {Number.isNaN(s.p50) ? "no data" : `${Math.round(s.p50)} ms`}
                  </span>
                </div>
                {!Number.isNaN(s.p50) && (
                  <div className="mt-2.5 ml-9 h-2 rounded-sm overflow-hidden" style={{ background: "color-mix(in srgb, var(--color-ink) 6%, transparent)" }}>
                    <div className="h-full rounded-sm st-bar" style={{ width: `${Math.max(3, (s.p50 / maxP50) * 100)}%`, background: msColor(s.p50), opacity: 0.85 }} />
                  </div>
                )}
                <div className="mt-2 ml-9 flex flex-wrap gap-x-5 gap-y-1 label-mono text-[10px] text-ink-faint tabular-nums">
                  <span>p90 {Number.isNaN(s.p90) ? "—" : `${Math.round(s.p90)}ms`}</span>
                  <span>min {Number.isNaN(s.min) ? "—" : `${Math.round(s.min)}ms`}</span>
                  <span>max {Number.isNaN(s.max) ? "—" : `${Math.round(s.max)}ms`}</span>
                  <span>{s.n} probes</span>
                  <span>{s.successPct}% ok</span>
                  {ep.staleRounds > 0 && <span style={{ color: "var(--color-warn)" }}>stale ×{ep.staleRounds}</span>}
                  {ep.chainId && <span>chain {parseInt(ep.chainId, 16)}</span>}
                </div>
              </div>
            ))}

            {endpoints
              .filter((e) => e.status === "cors_blocked")
              .map((ep, i) => (
                <div key={ep.id} className="st-row card-soft rounded-lg px-4 py-4 sm:px-5 opacity-80" style={{ animationDelay: `${0.2 + (ranked.length + i) * 0.12}s` }}>
                  <p className="font-mono text-[13px] text-ink truncate">{ep.host}</p>
                  <p className="mt-1 text-[12px] text-ink-soft leading-snug">{ep.error}</p>
                  <pre className="mt-2 overflow-x-auto rounded-md px-3 py-2 text-[11px] font-mono" style={{ background: "var(--color-ink)", color: "var(--color-paper, #fff)" }}>
{`curl -s -X POST ${ep.url} -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' \\
  -w 'time: %{time_total}s\\n' -o /dev/null`}
                  </pre>
                </div>
              ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={reset}
              className="display text-base rounded-full px-6 py-2.5 border-2 border-ink text-ink hover:bg-ink hover:text-paper transition-colors"
            >
              ← Test again
            </button>
            <p className="text-[12px] text-ink-faint leading-snug max-w-[420px]">
              Same probe and classification as the public benchmarks
              (rotating-id anti-cache, ok / http_err / jsonrpc_err / stale /
              timeout). Your URLs never left this browser tab.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
