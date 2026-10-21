// Checks on the motion pass: reads every <part>.frames.json that
// lab/motion.mjs wrote and reports what a viewer would see go wrong
// while the clip plays.
// usage: node lab/motion-checks.mjs <motionDir> [out.json]
//
//   OVERLAP_RUN   readable texts cover each other for more than 0.2 s    FAIL
//                 (shorter crossings, as rows swap, are WARN)
//   OUT_RUN       readable text past the frame edge for more than 0.1 s  FAIL
//   JUMP          a logo moves more than 48 px between two frames, and   FAIL
//                 2.5x more than in the frames around it (a row
//                 teleporting, not a label riding fast data)
//   FLICKER       the number of readable labels goes up and down more    WARN
//                 than 1.5 times a second (badges flashing on and off)
//   MISSING       frames the probe did not report                       WARN
import fs from "node:fs";
import path from "node:path";

const [dir, outArg] = process.argv.slice(2);
const out = outArg ?? path.join(dir, "motion-checks.json");
const READABLE = 0.6;
const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);
function inter(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  return r > x && btm > y ? { x, y, w: r - x, h: btm - y } : null;
}
const ink = (x) => {
  const h = Math.min(x.vis.h, 0.72 * x.fs);
  return { x: x.vis.x, y: x.vis.y + (x.vis.h - h) / 2, w: x.vis.w, h };
};

// Runs of consecutive frames where pred(frame) returns a non-null example.
function runs(frames, pred) {
  const out = [];
  let cur = null;
  for (const fr of frames) {
    const ex = pred(fr);
    if (ex && cur && fr.f === cur.end + 1) { cur.end = fr.f; }
    else if (ex) { cur && out.push(cur); cur = { start: fr.f, end: fr.f, ex }; }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((r) => ({ ...r, len: r.end - r.start + 1 }));
}

const results = [];
for (const fx of fs.readdirSync(dir).sort()) {
  const d = path.join(dir, fx);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".frames.json")).sort()) {
    const comp = f.replace(".frames.json", "");
    const { fps, dur, frames } = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
    const issues = [];
    const add = (level, code, msg, at) => issues.push({ level, code, msg, at });
    const sec = (fr) => Number((fr / fps).toFixed(2));
    if (fs.existsSync(path.join(d, comp + ".err.txt"))) add("FAIL", "RENDER_ERROR", fs.readFileSync(path.join(d, comp + ".err.txt"), "utf8").split("\n")[0].slice(0, 160), 0);
    if (frames.length < dur * 0.98) add("WARN", "MISSING", `${dur - frames.length} of ${dur} frames not measured`, 0);
    // Now and then a browser tab measures one frame with the whole tree
    // a million pixels off screen (y = -999673) while the encoded frame is
    // fine (checked on the mp4). Those frames are dropped and counted.
    const sane = (b) => Math.abs(b.x) < 10 * fr0.w && Math.abs(b.y) < 10 * fr0.h;
    const fr0 = frames[0] ?? { w: 1920, h: 1080 };
    let glitched = 0;
    for (let k = frames.length - 1; k >= 0; k--) {
      const fr = frames[k];
      if ([...fr.texts.map((x) => x.box), ...(fr.logos ?? []).map((c) => c.box)].some((b) => !sane(b))) {
        frames.splice(k, 1);
        glitched++;
      }
    }
    if (glitched > dur * 0.02) add("WARN", "PROBE_GLITCH", `${glitched} frames measured off screen and dropped`, 0);
    for (const fr of frames) {
      fr.readable = fr.texts.filter((x) => x.op >= READABLE && x.vis && area(x.vis) >= 0.5 * area(x.box));
    }

    const ov = runs(frames, (fr) => {
      const r = fr.readable;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        const a = ink(r[i]), b = ink(r[j]);
        const o = inter(a, b);
        if (!o) continue;
        const small = Math.min(area(a), area(b));
        if (r[i].t === r[j].t && area(o) > 0.8 * small) continue;
        if (area(o) > 0.2 * small) return `"${r[i].t}" / "${r[j].t}"`;
      }
      return null;
    });
    const longOv = ov.filter((r) => r.len > Math.round(0.2 * fps));
    for (const r of longOv) add("FAIL", "OVERLAP_RUN", `${r.ex} overlap for ${(r.len / fps).toFixed(2)} s`, sec(r.start));
    const shortOv = ov.filter((r) => r.len <= Math.round(0.2 * fps));
    if (shortOv.length) add("WARN", "OVERLAP_RUN", `${shortOv.length} brief crossings (${shortOv.reduce((n, r) => n + r.len, 0)} frames), e.g. ${shortOv[0].ex}`, sec(shortOv[0].start));

    const oof = runs(frames, (fr) => {
      for (const x of fr.readable) {
        const b = x.box;
        if (Math.max(-b.x, -b.y, b.x + b.w - fr.w, b.y + b.h - fr.h) > 4) return `"${x.t}"`;
      }
      return null;
    });
    for (const r of oof.filter((r) => r.len > Math.round(0.1 * fps))) add("FAIL", "OUT_RUN", `${r.ex} past the frame edge for ${(r.len / fps).toFixed(2)} s`, sec(r.start));

    // Logos are the stable handle on a row: a name the probe sees in
    // consecutive frames. Several chips can share a name (a podium and its
    // receipt list): match each to the nearest one in the previous frame.
    // A teleport is a displacement that is large AND isolated: a label
    // riding a data spike moves fast for several frames in a row, which
    // is motion, not a jump.
    const steps = new Map(); // name -> [{f, d}]
    for (let k = 1; k < frames.length; k++) {
      const a = frames[k - 1], b = frames[k];
      if (b.f !== a.f + 1) continue;
      // Context is taken from every chip that shows at all (a crossing
      // fade dims a row below READABLE for a few frames mid-glide); only
      // a move between two readable frames can be flagged.
      for (const c of b.logos ?? []) {
        if (c.op < 0.15) continue;
        const prev = (a.logos ?? []).filter((p) => p.name === c.name && p.op >= 0.15);
        if (!prev.length) continue;
        const cx = c.box.x + c.box.w / 2, cy = c.box.y + c.box.h / 2;
        const near = prev.reduce((m, p) => {
          const d = Math.hypot(p.box.x + p.box.w / 2 - cx, p.box.y + p.box.h / 2 - cy);
          return d < m.d ? { d, p } : m;
        }, { d: Infinity, p: null });
        if (!steps.has(c.name)) steps.set(c.name, []);
        steps.get(c.name).push({ f: b.f, d: near.d, readable: c.op >= READABLE && near.p.op >= READABLE });
      }
    }
    let worst = { d: 0 };
    for (const [name, seq] of steps) {
      for (let k = 0; k < seq.length; k++) {
        const before = k > 0 && seq[k - 1].f === seq[k].f - 1 ? seq[k - 1].d : 0;
        const after = k + 1 < seq.length && seq[k + 1].f === seq[k].f + 1 ? seq[k + 1].d : 0;
        const isolated = seq[k].readable && seq[k].d > 2.5 * Math.max(before, after, 4);
        if (isolated && seq[k].d > worst.d) worst = { d: seq[k].d, name, f: seq[k].f };
      }
    }
    if (worst.d > 48) add("FAIL", "JUMP", `${worst.name} jumps ${Math.round(worst.d)} px in one frame`, sec(worst.f));

    // Label count reversals per second, after the intro fade.
    const counts = frames.filter((fr) => fr.f > 30).map((fr) => fr.readable.length);
    let rev = 0, lastSign = 0;
    for (let k = 1; k < counts.length; k++) {
      const s = Math.sign(counts[k] - counts[k - 1]);
      if (s && lastSign && s !== lastSign) rev++;
      if (s) lastSign = s;
    }
    const perSec = rev / Math.max(1, counts.length / fps);
    if (perSec > 1.5) add("WARN", "FLICKER", `labels appear and vanish ${perSec.toFixed(1)} times a second`, 1);

    results.push({ fx, comp, frames: frames.length, dur, maxJumpPx: Math.round(worst.d), flickerPerSec: Number(perSec.toFixed(2)), issues });
  }
}
fs.writeFileSync(out, JSON.stringify(results, null, 1));
const byPart = {};
for (const r of results) {
  byPart[r.comp] ??= { FAIL: 0, WARN: 0, clips: 0 };
  byPart[r.comp].clips++;
  for (const i of r.issues) byPart[r.comp][i.level]++;
}
for (const [k, v] of Object.entries(byPart)) console.log(`${k.padEnd(18)} ${String(v.clips).padStart(3)} clips  FAIL ${v.FAIL}  WARN ${v.WARN}`);
const nFail = results.reduce((n, r) => n + r.issues.filter((i) => i.level === "FAIL").length, 0);
console.log(`motion-checks: ${results.length} clips, ${nFail} FAIL -> ${out}`);
process.exitCode = nFail ? 1 : 0;
