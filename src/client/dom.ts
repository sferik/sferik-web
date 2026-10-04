// Small DOM helpers shared by the page (site.ts) and the shell (shell.ts).

export const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector<T>(s);
export const $$ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => [...root.querySelectorAll<T>(s)];
export const fmt = (n: number) => n.toLocaleString("en-US");
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : String(v));
  }
  node.append(...kids);
  return node;
}
