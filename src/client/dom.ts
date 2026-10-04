// Small DOM helpers shared by the page (site.ts) and the shell (shell.ts).

export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];
export const fmt = (n: number) => n.toLocaleString("en-US");
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// The option nearest a word, within two edits (for "did you mean?"), if any.
export function closest(word: string, options: string[]): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length];
  };
  let best: string | undefined;
  let least = 3;
  for (const option of options) {
    const d = distance(word.toLowerCase(), option.toLowerCase());
    if (d < least) [best, least] = [option, d];
  }
  return best;
}

export function span(text: string, cls?: string): HTMLSpanElement {
  const node = document.createElement("span");
  if (cls) node.className = cls;
  node.textContent = text;
  return node;
}

type Attrs = Record<string, string | number | boolean | null | undefined>;

// el("a", { href }, "text") — attributes, then children. `html` sets innerHTML.
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") node.innerHTML = String(v);
    else if (k === "style")
      node.style.cssText = String(v); // through the CSSOM, which a strict CSP allows
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...kids);
  return node;
}
