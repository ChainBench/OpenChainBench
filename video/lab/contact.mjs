// contact sheet per fixture with sharp: rows = compositions, cols = frames
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
const [src, out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const LEFT = 190, GAP = 6, TOP = 44;
let W = 384, H = 216;
const ORDER = ["BarChartRace", "TimeSeriesRace", "DonutRace", "CountPodium", "ResultsBoard", "Outro"];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
for (const fx of fs.readdirSync(src).sort()) {
  const d = path.join(src, fx);
  if (!fs.statSync(d).isDirectory()) continue;
  const rows = {};
  for (const f of fs.readdirSync(d).sort()) {
    if (!f.endsWith(".png")) continue;
    const comp = f.slice(0, f.lastIndexOf("-"));
    (rows[comp] ??= []).push(path.join(d, f));
  }
  const comps = ORDER.filter((c) => rows[c]);
  // Portrait renders (short format) keep their aspect instead of being
  // cropped into a landscape cell.
  const first = await sharp(rows[comps[0]][0]).metadata();
  [W, H] = first.height > first.width ? [216, 384] : [384, 216];
  const cols = Math.max(...comps.map((c) => rows[c].length));
  const width = LEFT + cols * (W + GAP), height = TOP + comps.length * (H + GAP);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><style>text{font-family:DejaVu Sans,Arial;}</style>`;
  svg += `<text x="12" y="28" font-size="20" fill="#ff8a00">${esc(fx)}</text>`;
  const composites = [];
  for (const [r, c] of comps.entries()) {
    const y = TOP + r * (H + GAP);
    const errs = fs.readdirSync(d).filter((f) => f.startsWith(c + "-") && f.endsWith(".err.txt")).length;
    svg += `<text x="12" y="${y + H / 2}" font-size="16" fill="#ddd">${c}</text>`;
    if (errs) svg += `<text x="12" y="${y + H / 2 + 22}" font-size="14" fill="#ff4040">${errs} render error(s)</text>`;
    for (const [i, p] of rows[c].entries()) {
      composites.push({ input: await sharp(p).resize(W, H).png().toBuffer(), left: LEFT + i * (W + GAP), top: y });
    }
  }
  svg += `</svg>`;
  await sharp({ create: { width, height, channels: 3, background: "#121214" } })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, ...composites])
    .jpeg({ quality: 86 })
    .toFile(path.join(out, `${fx}.jpg`));
  console.log(fx, comps.length, "rows");
}
