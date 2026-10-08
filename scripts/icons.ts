// Draws the icons that have to be pictures, from public/favicon.svg, which
// is the one browsers show: public/favicon.ico (what's asked for beside a
// PDF, or JSON, which name no icon of their own), public/apple-touch-icon.png
// (an iPhone's home screen), and public/icon-192.png and public/icon-512.png
// (the manifest's, for installing the site). Run `bun run icons` to redraw
// them after the favicon changes.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "public");
const svg = fs.readFileSync(path.join(dir, "favicon.svg"), "utf8");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ colorScheme: "light" });
// Square, for an iPhone, which rounds the corners itself and fills what's clear with black.
async function draw(size: number, square = false): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>body{margin:0;background:${square ? "#1d1d1f" : "transparent"}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.screenshot({ omitBackground: !square });
}
const PNGS: Record<string, [number, boolean?]> = { "apple-touch-icon.png": [180, true], "icon-192.png": [192], "icon-512.png": [512] };
for (const [file, [size, square]] of Object.entries(PNGS)) {
  fs.writeFileSync(path.join(dir, file), await draw(size, square));
  console.log(`Drew public/${file}`);
}
// An .ico with one picture in it, 32 pixels square: a PNG, as it is, after
// six bytes that say there's one and sixteen that say where and how big.
const png = await draw(32);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); // an icon
header.writeUInt16LE(1, 4); // one picture
header.writeUInt8(32, 6); // wide
header.writeUInt8(32, 7); // tall
header.writeUInt16LE(1, 10); // one plane
header.writeUInt16LE(32, 12); // 32 bits a pixel
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18); // where the picture starts
fs.writeFileSync(path.join(dir, "favicon.ico"), Buffer.concat([header, png]));
console.log("Drew public/favicon.ico");
await browser.close();
