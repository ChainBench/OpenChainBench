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
import { ProviderLogo } from "@/components/provider-logo";
import {
  FEATURED_CHAINS,
  RPC_DIRECTORY,
  directoryEntryForUrl,
  providerForUrl,
  type DirectoryChain,
} from "@/lib/speedtest/rpc-directory";

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

/** Smooth green→amber→red interpolation across the dial (t in 0..1),
 *  Speedtest-style gradient fill but with latency semantics. */
const GRAD_STOPS: [number, [number, number, number]][] = [
  [0.0, [16, 185, 129]], // emerald (fast)
  [0.55, [245, 158, 11]], // amber
  [1.0, [239, 68, 68]], // red (slow)
];
function gradientColor(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < GRAD_STOPS.length; i++) {
    const [t1, c1] = GRAD_STOPS[i];
    const [t0, c0] = GRAD_STOPS[i - 1];
    if (x <= t1) {
      const f = (x - t0) / (t1 - t0);
      const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * f));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(239,68,68)";
}

/** rAF-driven exponential easing towards a moving target — the needle
 *  and the readout glide continuously instead of jumping per sample,
 *  which is what makes the dial read as a live instrument. */
function useEased(target: number | null, tauMs = 220): number | null {
  const [value, setValue] = useState<number | null>(target);
  const valueRef = useRef<number | null>(target);
  useEffect(() => {
    if (target == null) {
      valueRef.current = null;
      setValue(null);
      return;
    }
    if (valueRef.current == null) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const step = (t: number) => {
      const dt = t - last;
      last = t;
      const cur = valueRef.current ?? target;
      const next = cur + (target - cur) * Math.min(1, dt / tauMs);
      valueRef.current = next;
      setValue(next);
      if (Math.abs(target - next) > 0.4) raf = requestAnimationFrame(step);
      else {
        valueRef.current = target;
        setValue(target);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, tauMs]);
  return value;
}

/** Last-N samples as tiny colored bars — motion + history at a glance. */
function MiniSparkline({ samples }: { samples: Sample[] }) {
  const last = samples.slice(-14);
  if (last.length === 0) return <div className="h-[22px]" />;
  return (
    <div className="flex items-end justify-center gap-[3px] h-[22px]" aria-hidden>
      {last.map((s, i) => {
        const h = 4 + (Math.log(Math.max(1, Math.min(1000, s.ms))) / Math.log(1000)) * 18;
        const bad = s.verdict !== "ok";
        return (
          <span
            key={`${s.round}-${i}`}
            className="w-[3px] rounded-full transition-all duration-300"
            style={{
              height: `${h}px`,
              background: bad ? "var(--color-ink-faint)" : msColor(s.ms),
              opacity: 0.35 + (i / last.length) * 0.65,
            }}
          />
        );
      })}
    </div>
  );
}

function Gauge({
  ms,
  label,
  sub,
  live = false,
  className = "mx-auto w-[280px] sm:w-[340px]",
}: {
  ms: number | null;
  label: string;
  sub: string;
  live?: boolean;
  className?: string;
}) {
  const eased = useEased(ms);
  const angle = eased == null ? GAUGE_START : msToAngle(eased);
  const color = eased == null ? "var(--color-ink-faint)" : msColor(eased);
  // Speedtest-style progressive fill: the arc is rendered as many thin
  // segments; those before the needle carry a smooth green→amber→red
  // gradient, the rest stay on the grey track. Because `eased` updates
  // per animation frame, the fill grows/retracts fluidly with the needle.
  const SEGS = 56;
  const fillT = (angle - GAUGE_START) / GAUGE_SWEEP; // 0..1
  return (
    <div className={`relative ${className}`}>
      <svg viewBox="0 0 200 170" className="w-full">
        <defs>
          <linearGradient id="st-needle-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-ink)" stopOpacity="0.9" />
            <stop offset="75%" stopColor="var(--color-ink)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--color-ink)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Track */}
        <path
          d={arcPath(100, 100, 76, GAUGE_START, GAUGE_START + GAUGE_SWEEP)}
          fill="none"
          stroke="var(--color-rule, #e2e8f0)"
          strokeWidth="13"
          strokeLinecap="round"
          opacity="0.7"
        />
        {/* Gradient fill up to the needle */}
        {Array.from({ length: SEGS }, (_, i) => {
          const t0 = i / SEGS;
          if (eased == null || t0 >= fillT) return null;
          const t1 = Math.min((i + 1) / SEGS, fillT);
          const a0 = GAUGE_START + t0 * GAUGE_SWEEP;
          const a1 = GAUGE_START + t1 * GAUGE_SWEEP + 0.4; // overlap kills seams
          return (
            <path
              key={i}
              d={arcPath(100, 100, 76, a0, a1)}
              fill="none"
              stroke={gradientColor(t0)}
              strokeWidth="13"
              strokeLinecap={i === 0 ? "round" : "butt"}
            />
          );
        })}
        {/* Scale labels, inside the dial like the reference */}
        {GAUGE_STOPS.map((stop) => {
          const [x, y] = polar(100, 100, 58, msToAngle(stop));
          return (
            <text
              key={stop}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize="8"
              fontWeight={500}
              fill="var(--color-ink-muted)"
              fontFamily="var(--font-sans, sans-serif)"
            >
              {stop}
            </text>
          );
        })}
        {/* Needle: slim tapered blade fading toward the hub — no heavy
            center cap, instrument-grade. rAF easing drives the rotation
            continuously; a slow wobble runs while live. */}
        {eased != null && (
          <g className={live ? "st-wobble" : undefined} style={{ transformOrigin: "100px 100px" }}>
            <g
              style={{
                transform: `rotate(${angle + 90}deg)`,
                transformOrigin: "100px 100px",
              }}
            >
              <polygon points="97.6,96 102.4,96 100.9,34 99.1,34" fill="url(#st-needle-grad)" />
            </g>
          </g>
        )}
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <div className="text-3xl sm:text-4xl tabular-nums leading-none font-light text-ink">
          {eased == null ? "—" : Math.round(eased)}
          <span className="text-sm ml-1.5 text-ink-faint">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full mr-1 align-middle"
              style={{ background: color }}
            />
            ms
          </span>
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

/** Display name: benchmarked provider name when the URL is from our
 *  directory, bare host otherwise. */
function epLabel(ep: { url: string; host: string }): string {
  return providerForUrl(ep.url) ?? ep.host;
}

export function SpeedtestRpcClient() {
  const [stage, setStage] = useState<Stage>("setup");
  const [inputs, setInputs] = useState<string[]>(["", ""]);
  const [chainQuery, setChainQuery] = useState("");
  const [pickedChain, setPickedChain] = useState<string | null>(null);
  const [prefillState, setPrefillState] = useState<"idle" | "validating" | "done">("idle");
  const [skippedProviders, setSkippedProviders] = useState<string[]>([]);
  const prefillEpoch = useRef(0);
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

  const chainMatches = useMemo(() => {
    const q = chainQuery.trim().toLowerCase();
    if (!q) return [];
    return RPC_DIRECTORY.filter(
      (c) => c.name.toLowerCase().includes(q) || c.slug.includes(q),
    ).slice(0, 8);
  }, [chainQuery]);

  const pickChain = (c: DirectoryChain) => {
    // Fill immediately, then validate each endpoint from THIS browser
    // (eth_chainId, short timeout) and silently drop the ones that
    // reject browser requests — a prefilled endpoint must never show
    // up as a dead "no CORS" tile. Manual URLs keep full feedback.
    const epoch = ++prefillEpoch.current;
    setInputs(c.endpoints.map((e) => e.url));
    setPickedChain(c.slug);
    setChainQuery("");
    setSkippedProviders([]);
    setPrefillState("validating");
    void (async () => {
      const checks = await Promise.all(
        c.endpoints.map(async (e) => {
          try {
            const r = await rpcCall(e.url, "eth_chainId", []);
            return { e, ok: r.verdict === "ok" || r.verdict === "http_err" };
          } catch {
            return { e, ok: false }; // CORS / network-level rejection
          }
        }),
      );
      if (prefillEpoch.current !== epoch) return; // user picked again
      const good = checks.filter((x) => x.ok).map((x) => x.e.url);
      const skipped = checks.filter((x) => !x.ok).map((x) => x.e.provider);
      if (skipped.length > 0) setInputs(good.length > 0 ? good : [""]);
      setSkippedProviders(skipped);
      setPrefillState("done");
    })();
  };

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
            "This endpoint does not answer browser requests (no CORS headers on preflight). Dapps cannot call it from a browser either. It may still be fast server-side: measure it from a terminal with the curl below.",
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

    // Phase 3: measured rounds until the clock runs out. Every endpoint
    // is probed CONCURRENTLY each round (starts staggered by ~90ms so
    // request bursts never align) at roughly one probe per second per
    // endpoint — every needle lives simultaneously, speedtest-style.
    // RPC payloads are a few KB, so uplink contention is negligible
    // against the 10-500ms latencies being measured.
    const tEnd = performance.now() + durationSec * 1000;
    const t0 = performance.now();
    let roundNo = 0;
    const timer = setInterval(
      () => setElapsed(Math.min(durationSec, (performance.now() - t0) / 1000)),
      200,
    );
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      while (performance.now() < tEnd && !abortRef.current.stop) {
        roundNo += 1;
        setRound(roundNo);
        const roundStart = performance.now();
        const order = [...live].sort(() => Math.random() - 0.5);
        const roundBlocks: Record<string, number | null> = {};
        await Promise.all(
          order.map(async (ep, idx) => {
            await sleep(idx * 90);
            if (abortRef.current.stop) return;
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
          }),
        );
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
        // Pace: ~1 round/second regardless of how fast the round ran.
        const roundDur = performance.now() - roundStart;
        if (performance.now() < tEnd) await sleep(Math.max(0, 1050 - roundDur));
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
        @keyframes st-wobble-kf { 0%,100% { transform: rotate(-0.5deg); } 50% { transform: rotate(0.5deg); } }
        .st-wobble { animation: st-wobble-kf 1.7s ease-in-out infinite; }
        .st-stage { animation: st-fade-up 0.5s cubic-bezier(0.22,1,0.36,1) both; }
        .st-row { animation: st-fade-up 0.55s cubic-bezier(0.22,1,0.36,1) both; }
        .st-live { animation: st-pulse 1.6s ease-in-out infinite; }
        .st-bar { transition: width 0.8s cubic-bezier(0.22,1,0.36,1); }
      `}</style>

      {/* ── Stage: setup ─────────────────────────────────────────── */}
      {stage === "setup" && (
        <section className="st-stage card-soft rounded-xl p-5 sm:p-8">
          <p className="label-mono text-[10px] uppercase tracking-[0.2em] text-ink-faint mb-3">
            1 · Endpoints
          </p>

          {/* Prefill from the benchmarked no-key cohort: pick a chain and
              get exactly the endpoints the public per-chain benches probe
              continuously (90 EVM chains, 291 endpoints). */}
          <div className="mb-5 rounded-lg border border-rule px-4 py-3">
            <p className="text-[12px] text-ink-soft mb-2">
              Prefill with the endpoints we already benchmark. Pick a chain:
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {FEATURED_CHAINS.map((slug) => {
                const c = RPC_DIRECTORY.find((x) => x.slug === slug);
                if (!c) return null;
                const activeChip = pickedChain === slug;
                return (
                  <button
                    key={slug}
                    type="button"
                    onClick={() => pickChain(c)}
                    className={`label-mono text-[11px] rounded-full pl-1.5 pr-3 py-1 border transition-colors inline-flex items-center gap-1.5 ${
                      activeChip
                        ? "border-ink text-paper"
                        : "border-rule text-ink-soft hover:border-ink/40 hover:text-ink"
                    }`}
                    style={activeChip ? { background: "var(--color-ink)", color: "var(--color-paper, #fff)" } : undefined}
                  >
                    <ProviderLogo slug={slug} name={c.name} size={16} />
                    {c.name}
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <input
                value={chainQuery}
                onChange={(e) => setChainQuery(e.target.value)}
                placeholder={`Search ${RPC_DIRECTORY.length} benchmarked chains… (e.g. Sonic, Linea, Scroll)`}
                spellCheck={false}
                autoComplete="off"
                className="w-full rounded-md border border-rule bg-transparent px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint/60 focus:border-ink/50 focus:outline-none"
              />
              {chainMatches.length > 0 && (
                <ul className="absolute z-20 mt-1 w-full rounded-md border border-rule bg-paper shadow-lg overflow-hidden" style={{ background: "var(--color-paper, #fff)" }}>
                  {chainMatches.map((c) => (
                    <li key={c.slug}>
                      <button
                        type="button"
                        onClick={() => pickChain(c)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-ink hover:bg-ink/5 transition-colors"
                      >
                        <ProviderLogo slug={c.slug} name={c.name} size={18} />
                        <span className="flex-1">{c.name}</span>
                        <span className="label-mono text-[10px] text-ink-faint">
                          {c.endpoints.length} endpoint{c.endpoints.length > 1 ? "s" : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {pickedChain && (
              <p className="mt-2 label-mono text-[10px]" style={{ color: "var(--color-good)" }}>
                {prefillState === "validating"
                  ? `⏳ ${RPC_DIRECTORY.find((c) => c.slug === pickedChain)?.name}: checking ${inputs.length} benchmarked endpoints from your browser…`
                  : `✓ ${RPC_DIRECTORY.find((c) => c.slug === pickedChain)?.name}: ${inputs.filter(Boolean).length} endpoints ready. Add your own keyed URLs below to race them.`}
              </p>
            )}
            {skippedProviders.length > 0 && (
              <p className="mt-1 label-mono text-[10px] text-ink-faint">
                Skipped {skippedProviders.join(", ")}: no browser (CORS) support. The public bench probes it server-side.
              </p>
            )}
          </div>
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
            {(() => {
              const visible = endpoints.filter((e) => e.status !== "cors_blocked");
              const blocked = endpoints.filter((e) => e.status === "cors_blocked");
              return (
                <>
                  <div
                    className={`mt-2 grid gap-4 ${
                      visible.length <= 1
                        ? "grid-cols-1 max-w-[340px] mx-auto"
                        : visible.length === 2
                          ? "grid-cols-1 sm:grid-cols-2"
                          : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
                    }`}
                  >
                    {visible.map((ep) => {
                      const s = stats(ep);
                      const isActive = ep.id === activeId;
                      const dirEntry = directoryEntryForUrl(ep.url);
                      return (
                        <div
                          key={ep.id}
                          className="rounded-xl border px-3 pt-3 pb-4 transition-all duration-300"
                          style={{
                            borderColor: isActive ? "var(--color-ink)" : "var(--color-rule, #e2e8f0)",
                            transform: isActive ? "translateY(-2px)" : undefined,
                            boxShadow: isActive ? "0 6px 18px -8px rgba(15,23,42,0.25)" : undefined,
                          }}
                        >
                          {dirEntry && (
                            <div className="flex items-center justify-center gap-1.5 -mb-1">
                              <ProviderLogo slug={dirEntry.slug} name={dirEntry.provider} size={18} />
                            </div>
                          )}
                          <Gauge
                            ms={ep.lastMs}
                            label={epLabel(ep)}
                            sub={ep.status === "checking" ? "checking reachability" : ep.host}
                            live={ep.status === "testing"}
                            className="mx-auto w-full max-w-[240px]"
                          />
                          <MiniSparkline samples={ep.samples} />
                          <div className="mt-1.5 flex items-center justify-center gap-3 label-mono text-[10px] text-ink-faint tabular-nums">
                            <span>p50 {Number.isNaN(s.p50) ? "—" : `${Math.round(s.p50)}ms`}</span>
                            <span>{s.n} probes</span>
                            <span>{s.successPct}% ok</span>
                            {ep.staleRounds > 0 && (
                              <span style={{ color: "var(--color-warn)" }}>stale ×{ep.staleRounds}</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {blocked.length > 0 && (
                    <p className="mt-3 label-mono text-[10px] text-ink-faint text-center">
                      Skipped (no browser support): {blocked.map((e) => epLabel(e)).join(", ")}
                    </p>
                  )}
                </>
              );
            })()}

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
              <div className="flex items-center justify-center gap-3">
                {directoryEntryForUrl(ranked[0].ep.url) && (
                  <ProviderLogo
                    slug={directoryEntryForUrl(ranked[0].ep.url)!.slug}
                    name={epLabel(ranked[0].ep)}
                    size={34}
                  />
                )}
                <p className="display text-3xl sm:text-4xl text-ink break-all">{epLabel(ranked[0].ep)}</p>
              </div>
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
                  {directoryEntryForUrl(ep.url) && (
                    <ProviderLogo
                      slug={directoryEntryForUrl(ep.url)!.slug}
                      name={epLabel(ep)}
                      size={20}
                    />
                  )}
                  <p className="font-mono text-[13px] text-ink truncate flex-1">
                    {epLabel(ep)}
                    {providerForUrl(ep.url) && (
                      <span className="text-ink-faint ml-2 text-[11px]">{ep.host}</span>
                    )}
                  </p>
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

            {(() => {
              const blockedDir = endpoints.filter(
                (e) => e.status === "cors_blocked" && directoryEntryForUrl(e.url),
              );
              if (blockedDir.length === 0) return null;
              return (
                <p className="st-row label-mono text-[10px] text-ink-faint text-center pt-1" style={{ animationDelay: `${0.2 + ranked.length * 0.12}s` }}>
                  Not testable from a browser (skipped): {blockedDir.map((e) => epLabel(e)).join(", ")}. The public bench covers {blockedDir.length > 1 ? "them" : "it"} server-side.
                </p>
              );
            })()}
            {endpoints
              .filter((e) => e.status === "cors_blocked" && !directoryEntryForUrl(e.url))
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
