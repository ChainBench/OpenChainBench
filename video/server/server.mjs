/**
 * OpenChainBench video renderer — standalone HTTP service.
 *
 * Pipeline: POST /render → render intro + race + results + outro through
 * @remotion/renderer against the pre-built bundle → ffmpeg-concat →
 * content-addressed cache. nginx serves the cached MP4s directly from
 * /v/<hash>.mp4 (zero Express overhead on the hot path).
 *
 * Cache key = sha256(COMP_VERSION | viewId | bench | raceSeconds). Same
 * inputs → instant 200. Bump COMP_VERSION when a composition changes.
 *
 * Hardening (v2):
 *   - rate limit per IP (5 renders / 60s sliding window)
 *   - concurrency limit (2 in-flight max; queue the rest; 503 when overloaded)
 *   - cache size cap (auto-prune oldest when /mnt/video-renderer/cache > 30GB)
 *   - structured JSON logs on stdout (PM2 captures; Datadog-agent ingestible)
 *
 * Auth: every request to /render must carry `X-Render-Token: <RENDER_API_TOKEN>`.
 * `/health` is open so external pings don't need the secret.
 */

import express from "express";
import { renderMedia, selectComposition } from "@remotion/renderer";
import path from "node:path";
import { mkdir, writeFile, unlink, stat, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = "/mnt/video-renderer";
const POC = path.join(ROOT, "poc");
const BUNDLE = path.join(POC, "remotion-bundle");
const CACHE = path.join(ROOT, "cache");
const INTRO = path.join(POC, "public", "intro.mp4");
const INTRO_VERTICAL = path.join(POC, "public", "intro-vertical.mp4");
// Ambient soundtrack, already trimmed to start at the 2s mark of the
// original track. Muxed in post-concat when the request asks for audio:
// looped if needed, cut to the exact video duration, 2.5s fade-out.
const AMBIENT = path.join(POC, "public", "ambient-benchmark.mp3");

const TOKEN = process.env.RENDER_API_TOKEN;
const PORT = Number(process.env.PORT ?? 4200);
const HOST = process.env.HOST ?? "127.0.0.1";

const COMP_VERSION = "v27-review3";

const VIEWS = new Set([
  "BarChartRace",
  "TimeSeriesRace",
  "DonutRace",
  "CountPodium",
]);

/**
 * Output formats. Compositions are registered at 1920x1080 but Remotion
 * lets us override the canvas at render time; components read the real
 * dimensions via useVideoConfig(). "short" renders natively at
 * 1080x1920 (no crop, no scale, same pixel budget as landscape).
 */
const FORMATS = {
  landscape: { width: 1920, height: 1080 },
  short: { width: 1080, height: 1920 },
};

const MIN_SECONDS = 5;
const MAX_SECONDS = 60;
const DEFAULT_SECONDS = 17;
const FPS = 30;

/** Per-IP rolling window. 5 render starts per 60s; cache hits don't count. */
const RATE_CAPACITY = 5;
const RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map();

/** 2 vCPU box → keep concurrency ≤ 2 or Chromium fights ffmpeg for CPU. */
const CONCURRENCY = 2;
const QUEUE_MAX = 6;
let inFlight = 0;
const queue = [];

/** Auto-prune when cache exceeds this size. */
const CACHE_SIZE_LIMIT_BYTES = 30 * 1024 * 1024 * 1024; // 30GB
let lastCacheCheckMs = 0;
const CACHE_CHECK_INTERVAL_MS = 5 * 60_000; // 5 min

function log(level, msg, fields = {}) {
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n",
  );
}

function clampSeconds(s) {
  if (!Number.isFinite(s)) return DEFAULT_SECONDS;
  return Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, Math.round(s)));
}

function hashInputs(viewId, bench, raceSeconds, skipIntro, format, audio, beats) {
  const payload = JSON.stringify({ v: COMP_VERSION, viewId, bench, raceSeconds, skipIntro, format, audio, beats });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function clientIp(req) {
  // Trust X-Forwarded-For only when set by our nginx (we don't expose this
  // service directly to the internet). Fallback to the socket address.
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function rateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) ?? [];
  const fresh = bucket.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_CAPACITY) {
    rateBuckets.set(ip, fresh);
    const oldest = fresh[0];
    return { ok: false, retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000) };
  }
  fresh.push(now);
  rateBuckets.set(ip, fresh);
  // GC stale buckets opportunistically — bound the Map at 1000 IPs.
  if (rateBuckets.size > 1000) {
    const cutoff = now - RATE_WINDOW_MS;
    for (const [k, v] of rateBuckets) {
      const live = v.filter((t) => t > cutoff);
      if (live.length === 0) rateBuckets.delete(k);
      else if (live.length !== v.length) rateBuckets.set(k, live);
    }
  }
  return { ok: true };
}

async function maybePruneCache() {
  const now = Date.now();
  if (now - lastCacheCheckMs < CACHE_CHECK_INTERVAL_MS) return;
  lastCacheCheckMs = now;
  try {
    const files = (await readdir(CACHE))
      .filter((f) => f.endsWith(".mp4") && !f.startsWith("_"))
      .map((f) => {
        const full = path.join(CACHE, f);
        const st = statSync(full);
        return { full, mtimeMs: st.mtimeMs, size: st.size };
      });
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_SIZE_LIMIT_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let removed = 0;
    for (const f of files) {
      if (total <= CACHE_SIZE_LIMIT_BYTES * 0.9) break;
      await unlink(f.full).catch(() => {});
      total -= f.size;
      removed++;
    }
    if (removed > 0) log("info", "cache_pruned", { removed, total_after: total });
  } catch (e) {
    log("error", "cache_prune_failed", { error: e instanceof Error ? e.message : String(e) });
  }
}

function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (inFlight < CONCURRENCY) {
      inFlight++;
      return resolve();
    }
    if (queue.length >= QUEUE_MAX) {
      return reject(Object.assign(new Error("server_busy"), { status: 503 }));
    }
    queue.push(resolve);
  });
}

function releaseSlot() {
  inFlight--;
  const next = queue.shift();
  if (next) {
    inFlight++;
    next();
  }
}

if (!TOKEN) {
  console.error("[fatal] RENDER_API_TOKEN env var is required");
  process.exit(1);
}
if (!existsSync(BUNDLE)) {
  console.error(`[fatal] bundle missing at ${BUNDLE} — run npm run build:remotion in ${POC}`);
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    comp_version: COMP_VERSION,
    uptime: process.uptime(),
    in_flight: inFlight,
    queued: queue.length,
  });
});

app.use((req, res, next) => {
  if (req.headers["x-render-token"] !== TOKEN) {
    return res.status(403).json({ error: "forbidden" });
  }
  next();
});

app.post("/render", async (req, res) => {
  const t0 = Date.now();
  const ip = clientIp(req);
  try {
    const { datasetId, viewId, bench } = req.body ?? {};
    const raceSeconds = clampSeconds(req.body?.raceSeconds ?? DEFAULT_SECONDS);
    const skipIntro = !!req.body?.skipIntro;
    const format = req.body?.format ?? "landscape";
    const audio = !!req.body?.audio;
    const beats = !!req.body?.beats;

    if (!bench || !Array.isArray(bench.providers) || bench.providers.length === 0) {
      return res.status(400).json({ error: "missing or empty bench payload" });
    }
    if (!VIEWS.has(viewId)) {
      return res.status(400).json({ error: `unknown view: ${viewId}` });
    }
    if (!(format in FORMATS)) {
      return res.status(400).json({ error: `unknown format: ${format}` });
    }
    const { width, height } = FORMATS[format];

    await mkdir(CACHE, { recursive: true });

    const cacheKey = hashInputs(viewId, bench, raceSeconds, skipIntro, format, audio, beats);
    const cachedPath = path.join(CACHE, `${cacheKey}.mp4`);

    // Cache hit fast-path. Doesn't consume a rate slot or concurrency slot.
    if (existsSync(cachedPath)) {
      const s = await stat(cachedPath);
      if (s.size > 0) {
        log("info", "render_cache_hit", { cacheKey, viewId, ip, ms: Date.now() - t0 });
        return res.json({
          url: `/v/${cacheKey}.mp4`,
          cached: true,
          ms: Date.now() - t0,
        });
      }
    }

    // Fresh render — apply rate + concurrency gates.
    const rl = rateLimit(ip);
    if (!rl.ok) {
      log("warn", "rate_limited", { ip, retryAfterSec: rl.retryAfterSec });
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      return res.status(429).json({ error: "rate_limited", retry_after_sec: rl.retryAfterSec });
    }

    try {
      await acquireSlot();
    } catch (e) {
      log("warn", "queue_full", { ip, queue_len: queue.length });
      return res.status(503).json({ error: "server_busy", retry_after_sec: 30 });
    }

    try {
      await maybePruneCache();

      const inputProps = { theme: "dark", bench, beats };
      const raceDuration = raceSeconds * FPS;

      const stamp = Date.now();
      const racePath = path.join(CACHE, `_race-${stamp}.mp4`);
      const resultsPath = path.join(CACHE, `_results-${stamp}.mp4`);
      const outroPath = path.join(CACHE, `_outro-${stamp}.mp4`);

      const [raceComp, resultsComp, outroComp] = await Promise.all([
        selectComposition({ serveUrl: BUNDLE, id: viewId, inputProps }),
        selectComposition({ serveUrl: BUNDLE, id: "ResultsBoard", inputProps }),
        selectComposition({ serveUrl: BUNDLE, id: "Outro", inputProps }),
      ]);

      const renderOpts = {
        serveUrl: BUNDLE,
        codec: "h264",
        inputProps,
        imageFormat: "jpeg",
        jpegQuality: 90,
        x264Preset: "veryfast",
        // crf 19: x264 default-ish quality; 22 banded visibly on the dark
        // gradients. bt709 pins Chrome's colors so darks survive upload
        // re-encodes by the platforms.
        crf: 19,
        colorSpace: "bt709",
        chromiumOptions: { gl: "angle" },
        concurrency: 2,
        logLevel: "warn",
      };

      await Promise.all([
        renderMedia({
          ...renderOpts,
          composition: { ...raceComp, durationInFrames: raceDuration, width, height },
          outputLocation: racePath,
        }),
        renderMedia({
          ...renderOpts,
          composition: { ...resultsComp, width, height },
          outputLocation: resultsPath,
        }),
        renderMedia({
          ...renderOpts,
          composition: { ...outroComp, width, height },
          outputLocation: outroPath,
        }),
      ]);

      const segments = [];
      const introPath = format === "short" ? INTRO_VERTICAL : INTRO;
      if (!skipIntro && existsSync(introPath)) segments.push(introPath);
      segments.push(racePath, resultsPath, outroPath);

      const listPath = path.join(CACHE, `_concat-${stamp}.txt`);
      await writeFile(listPath, segments.map((s) => `file '${s}'`).join("\n") + "\n");

      const withAudio = audio && existsSync(AMBIENT);
      const concatTarget = withAudio ? path.join(CACHE, `_silent-${stamp}.mp4`) : cachedPath;
      try {
        execSync(
          `ffmpeg -y -f concat -safe 0 -i ${listPath} -c copy -movflags +faststart ${concatTarget}`,
          { stdio: "pipe" },
        );
      } catch {
        execSync(
          `ffmpeg -y -f concat -safe 0 -i ${listPath} -c:v libx264 -preset veryfast -crf 19 -tune animation -x264-params aq-mode=3:aq-strength=0.8 -pix_fmt yuv420p -movflags +faststart ${concatTarget}`,
          { stdio: "pipe" },
        );
      }

      if (withAudio) {
        // Cut the soundtrack to the exact video duration with a 2.5s
        // fade-out into the end. -stream_loop covers videos longer than
        // the track (131s); video stream is copied untouched.
        const dur = parseFloat(
          execSync(
            `ffprobe -v error -show_entries format=duration -of csv=p=0 ${concatTarget}`,
            { stdio: "pipe" },
          ).toString().trim(),
        );
        const fadeStart = Math.max(0, dur - 2.5).toFixed(3);
        execSync(
          `ffmpeg -y -i ${concatTarget} -stream_loop -1 -i ${AMBIENT} -filter_complex "[1:a]atrim=0:${dur.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st=${fadeStart}:d=2.5[a]" -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 160k -t ${dur.toFixed(3)} -movflags +faststart ${cachedPath}`,
          { stdio: "pipe" },
        );
        await unlink(concatTarget).catch(() => {});
      }

      await Promise.all([
        unlink(listPath).catch(() => {}),
        unlink(racePath).catch(() => {}),
        unlink(resultsPath).catch(() => {}),
        unlink(outroPath).catch(() => {}),
      ]);

      const ms = Date.now() - t0;
      log("info", "render_done", { cacheKey, viewId, raceSeconds, format, audio, beats, ip, datasetId, ms });

      res.json({
        url: `/v/${cacheKey}.mp4`,
        cached: false,
        ms,
        datasetId,
      });
    } finally {
      releaseSlot();
    }
  } catch (e) {
    log("error", "render_failed", {
      ip,
      error: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? e.stack : undefined,
    });
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(PORT, HOST, () => {
  log("info", "server_started", {
    host: HOST,
    port: PORT,
    bundle: BUNDLE,
    cache: CACHE,
    comp_version: COMP_VERSION,
    concurrency: CONCURRENCY,
    rate: `${RATE_CAPACITY}/${RATE_WINDOW_MS / 1000}s`,
    cache_limit_gb: CACHE_SIZE_LIMIT_BYTES / 1024 / 1024 / 1024,
  });
});
