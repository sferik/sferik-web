// A contact card, from what finger says. Shared by the shell (finger --vcard,
// and qr, which draws it as a QR code) and the server, where it's /finger as
// text/vcard.
import type { Finger } from "../types.js";

// A contact card (vCard 3.0), with every profile, or (short) just enough
// for a QR code. Long lines fold at 75 characters, as vCard asks.
export function vcard(m: Finger, short = false): string {
  const esc = (v: string) => v.replace(/[\\,;]/g, (c) => `\\${c}`);
  const fold = (line: string) => {
    const parts = [line.slice(0, 75)];
    for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
    return parts.join("\r\n");
  };
  const [first, ...rest] = m.name.split(" ");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${esc(rest.join(" "))};${esc(first)};;;`,
    `FN:${esc(m.name)}`,
    `EMAIL;TYPE=INTERNET:${m.mail}`,
    "TEL;TYPE=CELL:+1 415-312-2382",
    "URL:https://sferik.net",
    ...(short
      ? []
      : [
          `NICKNAME:${m.login}`,
          "BDAY:1983-11-24",
          `NOTE:${esc(m.plan)}`,
          ...m.profiles.map((p) => `X-SOCIALPROFILE;TYPE=${p.network.toLowerCase().replace(/\W/g, "")}:${p.url}`),
        ]),
    "END:VCARD",
  ]
    .map(fold)
    .join("\r\n")
    .concat("\r\n");
}
