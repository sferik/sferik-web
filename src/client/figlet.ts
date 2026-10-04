// FIGlet's standard font, with its controlled smushing rules (1–4): big
// letters from text. Shared by the shell's figlet command and the server,
// which draws the home page's name with it.

export interface Font {
  hardblank: string;
  height: number;
  glyphs: Record<number, string[]>;
}

// A font from its .flf file.
export function parseFont(flf: string): Font {
  const lines = flf.split("\n");
  const [header] = lines;
  const [, hardblank, height, , , , comments] = /^flf2a(.) (\d+) (\d+) (\d+) (-?\d+) (\d+)/.exec(header)!;
  const glyphs: Record<number, string[]> = {};
  let at = 1 + Number(comments);
  const h = Number(height);
  for (let code = 32; code < 127; code++) {
    const rows = lines.slice(at, at + h).map((row) => row.replace(/\s+$/, "").replace(/(.)\1?$/, ""));
    glyphs[code] = rows;
    at += h;
  }
  return { hardblank, height: h, glyphs };
}

function smushChar(a: string, b: string, hardblank: string): string | null {
  if (a === " ") return b;
  if (b === " ") return a;
  if (a === hardblank || b === hardblank) return null;
  if (a === b) return a; // rule 1: equal characters
  const under = "|/\\[]{}()<>";
  if (a === "_" && under.includes(b)) return b; // rule 2: underscore
  if (b === "_" && under.includes(a)) return a;
  const classes = ["|", "/\\", "[]", "{}", "()", "<>"]; // rule 3: hierarchy
  const ca = classes.findIndex((c) => c.includes(a));
  const cb = classes.findIndex((c) => c.includes(b));
  if (ca >= 0 && cb >= 0 && ca !== cb) return ca > cb ? a : b;
  if ("[] ][ {} }{ () )(".split(" ").includes(a + b)) return "|"; // rule 4: opposite pair
  return null;
}
export type Mode = "full" | "kern" | "smush";
function addGlyph(lines: string[], glyph: string[], mode: Mode, hardblank: string): string[] {
  if (!lines[0].length || mode === "full") return lines.map((l, i) => l + glyph[i]);
  let overlap = Infinity;
  lines.forEach((l, i) => {
    const trail = l.length - l.replace(/ +$/, "").length;
    const lead = glyph[i].length - glyph[i].replace(/^ +/, "").length;
    let o = trail + lead;
    const a = l[l.length - 1 - trail];
    const b = glyph[i][lead];
    if (mode === "smush" && a && b && smushChar(a, b, hardblank)) o++;
    overlap = Math.min(overlap, o, glyph[i].length);
  });
  return lines.map((l, i) => {
    const g = glyph[i];
    const keep = l.slice(0, Math.max(0, l.length - overlap));
    let merged = "";
    for (let k = 0; k < overlap; k++) {
      // The overlap was chosen so every overlapping pair smushes.
      merged += smushChar(l[l.length - overlap + k], g[k], hardblank);
    }
    return keep + merged + g.slice(overlap);
  });
}
export function figletLines(font: Font, text: string, width: number, mode: Mode): string[][] {
  const blocks = [];
  let lines = Array(font.height).fill("");
  for (const ch of text) {
    const glyph = font.glyphs[ch.charCodeAt(0)] ?? font.glyphs[63];
    const next = addGlyph(lines, glyph, mode, font.hardblank);
    if (Math.max(...next.map((l) => l.length)) > width && lines[0].length) {
      blocks.push(lines);
      lines = addGlyph(Array(font.height).fill(""), glyph, mode, font.hardblank);
    } else lines = next;
  }
  blocks.push(lines);
  return blocks.map((b) => b.map((l) => l.split(font.hardblank).join(" ")));
}
