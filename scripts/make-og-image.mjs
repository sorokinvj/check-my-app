// Generates public/og.png — the card a shared link shows (CHE-108).
//
// Written by hand rather than with next/og: that path renders through satori
// and resvg WebAssembly, and this product serves from workerd, where a preview
// image failing to render would fail silently and leave us back where we
// started. A file on disk cannot fail at request time.
//
// Deliberately typeless: the mark on the brand ground, no words. The title and
// description of a preview come from the meta tags, which are per-page and
// always current; text baked into an image would go stale and be wrong on the
// pages it does not describe.
//
//   node scripts/make-og-image.mjs

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const W = 1200;
const H = 630;

// Brand values, taken from src/app/icon.svg and tailwind.config.ts so the card
// and the product cannot drift apart.
const BG = [8, 9, 12];
const ACCENT = [79, 140, 255];
const INK = [8, 9, 12];

const px = Buffer.alloc(W * H * 3);
const put = (x, y, [r, g, b]) => {
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));

// Ground, with the same faint upward glow the site paints behind its pages.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W * 0.55);
    const dy = (y + H * 0.15) / (H * 0.9);
    const glow = Math.max(0, 1 - Math.hypot(dx, dy)) ** 2 * 0.16;
    put(x, y, mix(BG, ACCENT, glow));
  }
}

// Rounded square, centred: the app icon at poster size.
const S = 300;
const R = 76;
const x0 = (W - S) / 2;
const y0 = (H - S) / 2;
const roundedRect = (x, y) => {
  const dx = Math.max(x0 + R - x, 0, x - (x0 + S - R));
  const dy = Math.max(y0 + R - y, 0, y - (y0 + S - R));
  return R - Math.hypot(dx, dy); // >0 inside, and the value is the edge distance
};

// The checkmark, as two thick segments — the same gesture as the favicon.
const seg = (px1, py1, px2, py2, x, y) => {
  const vx = px2 - px1, vy = py2 - py1;
  const t = Math.min(1, Math.max(0, ((x - px1) * vx + (y - py1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(x - (px1 + t * vx), y - (py1 + t * vy));
};
const cx = x0 + S / 2, cy = y0 + S / 2;
const a = [cx - 66, cy + 6], b = [cx - 20, cy + 52], c = [cx + 68, cy - 46];
const STROKE = 21;

for (let y = y0 - 4; y < y0 + S + 4; y++) {
  for (let x = x0 - 4; x < x0 + S + 4; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    // Antialias by the signed distance, so no edge is a staircase.
    const inside = roundedRect(x, y);
    if (inside <= -1) continue;
    const base = px.subarray((y * W + x) * 3, (y * W + x) * 3 + 3);
    const ground = [base[0], base[1], base[2]];
    const tile = mix(ground, ACCENT, Math.min(1, inside + 1));

    const d = Math.min(seg(a[0], a[1], b[0], b[1], x, y), seg(b[0], b[1], c[0], c[1], x, y));
    put(x, y, mix(tile, INK, Math.min(1, STROKE / 2 - d + 0.5)));
  }
}

// PNG: filter byte 0 per scanline, one IDAT, CRC per chunk.
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("public", { recursive: true });
writeFileSync("public/og.png", png);
console.log(`public/og.png — ${W}×${H}, ${(png.length / 1024).toFixed(0)} KB`);
