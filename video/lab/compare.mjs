// Before/after: per fixture, the base sheet over the candidate sheet, plus
// a changed-frame report (mean absolute pixel difference per still).
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
const [baseFrames, candFrames, baseSheets, candSheets, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const report = [];
for (const fx of fs.readdirSync(candFrames).sort()) {
  const dir = path.join(candFrames, fx);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".png")).sort()) {
    const a = path.join(baseFrames, fx, f), b = path.join(dir, f);
    if (!fs.existsSync(a)) { report.push(`${fx}/${f}\tNEW`); continue; }
    const [ra, rb] = await Promise.all([a, b].map((p) => sharp(p).resize(480, 270).raw().toBuffer()));
    let s = 0; for (let i = 0; i < ra.length; i++) s += Math.abs(ra[i] - rb[i]);
    const mad = s / ra.length;
    if (mad > 0.5) report.push(`${fx}/${f}\t${mad.toFixed(1)}`);
  }
  const A = path.join(baseSheets, `${fx}.jpg`), B = path.join(candSheets, `${fx}.jpg`);
  if (fs.existsSync(A) && fs.existsSync(B)) {
    const [ma, mb] = await Promise.all([sharp(A).metadata(), sharp(B).metadata()]);
    const w = Math.max(ma.width, mb.width), lab = 40;
    const label = (t, c) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${lab}"><text x="12" y="28" font-size="22" font-family="DejaVu Sans,Arial" fill="${c}">${t}</text></svg>`);
    await sharp({ create: { width: w, height: ma.height + mb.height + 2 * lab, channels: 3, background: "#000" } })
      .composite([
        { input: label("BEFORE (baseline)", "#999"), left: 0, top: 0 },
        { input: A, left: 0, top: lab },
        { input: label("AFTER (candidate)", "#ff8a00"), left: 0, top: lab + ma.height },
        { input: B, left: 0, top: 2 * lab + ma.height },
      ]).jpeg({ quality: 80 }).toFile(path.join(out, `${fx}.jpg`));
  }
}
fs.writeFileSync(path.join(out, "changed.tsv"), report.join("\n") + "\n");
console.log(`compare: ${report.length} changed stills`);
