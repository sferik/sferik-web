// QR codes (ISO/IEC 18004) for the shell's qr command: byte mode, error
// correction level M, versions 1 to 9, which hold up to 180 bytes. That's
// plenty for a contact card. Returns the modules, true for dark, without the
// quiet zone around them.

// Per version: error correction codewords per block, and the blocks, as
// [how many, data codewords in each].
const BLOCKS: [number, [number, number][]][] = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [
    22,
    [
      [2, 38],
      [2, 39],
    ],
  ],
  [
    22,
    [
      [3, 36],
      [2, 37],
    ],
  ],
];
// The centers of the alignment patterns, per version.
const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

// Arithmetic in GF(256), for the Reed–Solomon codes.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++, x = (x << 1) ^ (x & 128 ? 0x11d : 0)) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

// The error correction codewords for a block of data.
function ecc(data: number[], n: number): number[] {
  let gen = [1];
  for (let i = 0; i < n; i++) gen = [...gen, 0].map((c, j) => c ^ mul(gen[j - 1] ?? 0, EXP[i]));
  const rem = new Array<number>(n).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], factor);
  }
  return rem;
}

// A BCH code: the bits, followed by their remainder by the generator.
const bch = (bits: number, length: number, generator: number) => {
  let rem = bits;
  for (let i = 0; i < length; i++) rem = (rem << 1) ^ ((rem >> (length - 1)) * generator);
  return (bits << length) | rem;
};

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export function qr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const total = (v: number) => BLOCKS[v - 1][1].reduce((sum, [count, size]) => sum + count * size, 0);
  // 4 bits of mode and 8 of length come first.
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((v) => bytes.length + 2 <= total(v));
  if (!version) throw new RangeError(`qr: ${bytes.length} bytes is too long; the most is 180`);
  const size = 17 + version * 4;

  // The data: mode (byte), length, the bytes, a terminator, then padding.
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  const capacity = total(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const codewords = Array.from({ length: total(version) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).join(""), 2));

  // Split into blocks, add error correction to each, then interleave them.
  const [ecLength, groups] = BLOCKS[version - 1];
  const blocks: number[][] = [];
  for (const [count, length] of groups) for (let i = 0; i < count; i++) blocks.push(codewords.splice(0, length));
  const ecBlocks = blocks.map((b) => ecc(b, ecLength));
  const stream: number[] = [];
  for (let i = 0; i < Math.max(...blocks.map((b) => b.length)); i++) for (const b of blocks) if (i < b.length) stream.push(b[i]);
  for (let i = 0; i < ecLength; i++) for (const b of ecBlocks) stream.push(b[i]);

  // The function patterns: finders, timing, alignment, and room for the
  // format and version information.
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ]) {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
  }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const centers = ALIGN[version - 1];
  const last = centers.length - 1;
  for (const [j, cy] of centers.entries())
    for (const [k, cx] of centers.entries()) {
      if ((j === 0 && k === 0) || (j === 0 && k === last) || (j === last && k === 0)) continue; // under a finder
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // The format information (level M, and the mask), twice, and the dark module.
  const format = (draw: (x: number, y: number, dark: boolean) => void, mask: number) => {
    const bits = bch(mask, 10, 0x537) ^ 0x5412; // level M is 00
    const bit = (i: number) => ((bits >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) draw(8, i, bit(i));
    draw(8, 7, bit(6));
    draw(8, 8, bit(7));
    draw(7, 8, bit(8));
    for (let i = 9; i < 15; i++) draw(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) draw(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) draw(8, size - 15 + i, bit(i));
    draw(8, size - 8, true);
  };
  format(set, 0);
  if (version >= 7) {
    const info = bch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const dark = ((info >> i) & 1) === 1;
      set(size - 11 + (i % 3), Math.floor(i / 3), dark);
      set(Math.floor(i / 3), size - 11 + (i % 3), dark);
    }
  }

  // The data, two columns at a time, zigzagging up and down from the
  // bottom right, around the function patterns.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert++) {
      const y = upward ? size - 1 - vert : vert;
      for (const x of [right, right - 1]) {
        if (reserved[y][x]) continue;
        modules[y][x] = ((stream[i >> 3] >> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }

  // Try each mask, and keep the one that's easiest to scan.
  let best: { penalty: number; grid: boolean[][] } | null = null;
  for (const [m, masked] of MASKS.entries()) {
    const grid = modules.map((row, y) => row.map((dark, x) => (reserved[y][x] ? dark : dark !== masked(x, y))));
    format((x, y, dark) => (grid[y][x] = dark), m);
    const penalty = score(grid);
    if (!best || penalty < best.penalty) best = { penalty, grid };
  }
  return best!.grid;
}

// The standard penalty: long runs, 2×2 blocks, finder-like patterns, and
// an unbalanced share of dark modules.
function score(modules: boolean[][]): number {
  const size = modules.length;
  const lines = [...modules, ...modules.map((_, x) => modules.map((row) => row[x]))];
  let penalty = 0;
  for (const line of lines) {
    for (let start = 0, i = 1; i <= size; i++) {
      if (i < size && line[i] === line[start]) continue;
      if (i - start >= 5) penalty += i - start - 2;
      start = i;
    }
    const text = line.map((d) => (d ? "1" : "0")).join("");
    penalty += 40 * (text.match(/(?=10111010000|00001011101)/g)?.length ?? 0);
  }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) penalty += 3;
    }
  const dark = modules.flat().filter(Boolean).length;
  return penalty + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}
