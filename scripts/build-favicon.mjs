/**
 * Regenerates src/app/favicon.ico from public/logo.png.
 *
 * Kept as a script because the file is binary and nobody will remember how
 * it was made. Two constraints are easy to get wrong and both were:
 *
 *  - Next's ICO decoder rejects non-RGBA payloads outright ("The PNG is not
 *    in RGBA format!"), and `next build` fails. flatten() alone produces
 *    RGB, so ensureAlpha() is required after it.
 *  - The background matches icon.tsx (#f8f3eb) and the 10 % padding keeps
 *    the mark off the edge at 16 px, where it otherwise fills the tab.
 *
 * Run: node scripts/build-favicon.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dir = readdirSync("node_modules/.pnpm").find((d) => d.startsWith("sharp@"));
const sharp = require(path.resolve("node_modules/.pnpm", dir, "node_modules/sharp"));

const SIZES = [16, 32, 48, 64];
const BG = { r: 248, g: 243, b: 235, alpha: 1 };

const pngs = [];
for (const s of SIZES) {
  const pad = Math.round(s * 0.1);
  const buf = await sharp("public/logo.png")
    .resize(s - 2 * pad, s - 2 * pad, { fit: "contain", background: BG })
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: BG })
    .flatten({ background: BG })
    .ensureAlpha()
    .png({ compressionLevel: 9, palette: false, force: true })
    .toBuffer();
  const meta = await sharp(buf).metadata();
  if (meta.channels !== 4) throw new Error(`${s}px is ${meta.channels}-channel, Next needs RGBA`);
  pngs.push({ s, buf });
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);

const entries = Buffer.alloc(16 * pngs.length);
let offset = 6 + 16 * pngs.length;
pngs.forEach((e, i) => {
  const o = i * 16;
  entries.writeUInt8(e.s, o);
  entries.writeUInt8(e.s, o + 1);
  entries.writeUInt16LE(1, o + 4);
  entries.writeUInt16LE(32, o + 6);
  entries.writeUInt32LE(e.buf.length, o + 8);
  entries.writeUInt32LE(offset, o + 12);
  offset += e.buf.length;
});

const out = Buffer.concat([header, entries, ...pngs.map((e) => e.buf)]);
writeFileSync("src/app/favicon.ico", out);
console.log(`favicon.ico: ${out.length} bytes, ${SIZES.join("/")} px, all RGBA`);
