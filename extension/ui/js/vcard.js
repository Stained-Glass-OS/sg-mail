/*
 * SG Mail -- contacts as vCards (RFC 6350), as Thunderbird keeps them: read
 * into the fields People shows and edits (name, e-mail addresses, phones,
 * company, job title, address, notes, birthday), and written back keeping
 * every line SG Mail does not edit (UID, photo, Thunderbird's own).
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const EDITED = new Set(["BEGIN", "END", "VERSION", "FN", "N", "EMAIL", "TEL", "ORG", "TITLE", "ADR", "NOTE", "BDAY"]);

function unescapeValue(v) {
  return v.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function escapeValue(v) {
  return String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

// a structured value (N, ADR, ORG): its parts, split on unescaped ;
function parts(v) {
  const out = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    if (v[i] === "\\" && i + 1 < v.length) {
      cur += v[i] + v[i + 1];
      i++;
    } else if (v[i] === ";") {
      out.push(unescapeValue(cur));
      cur = "";
    } else cur += v[i];
  }
  out.push(unescapeValue(cur));
  return out;
}

export function parseLines(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const lines = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // name;params:value (a colon inside a quoted parameter does not end the name)
    let i = 0, quoted = false;
    for (; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ":" && !quoted) break;
    }
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [nameRaw, ...paramList] = head.split(";");
    const name = nameRaw.replace(/^[^.]+\./, "").toUpperCase();     // item1.EMAIL -> EMAIL
    const params = {};
    for (const p of paramList) {
      const [k, v = ""] = p.split("=");
      params[k.toUpperCase()] = v.replace(/^"|"$/g, "");
    }
    lines.push({ name, params, value, line });
  }
  return lines;
}

function typeOf(params) {
  return (params.TYPE || "").toLowerCase().split(",").filter(Boolean);
}

export function parseVCard(text) {
  const c = { first: "", last: "", display: "", emails: [], phones: { work: "", cell: "", home: "" }, company: "", title: "",
    address: { street: "", city: "", region: "", code: "", country: "" }, notes: "", birthday: "" };
  for (const l of parseLines(text)) {
    const v = l.value;
    switch (l.name) {
      case "FN": c.display = unescapeValue(v); break;
      case "N": {
        const p = parts(v);
        c.last = p[0] || "";
        c.first = p[1] || "";
        break;
      }
      case "EMAIL": {
        const e = unescapeValue(v).trim();
        if (!e) break;
        if (l.params.PREF === "1" || typeOf(l.params).includes("pref")) c.emails.unshift(e);
        else c.emails.push(e);
        break;
      }
      case "TEL": {
        const t = typeOf(l.params), num = unescapeValue(v).replace(/^tel:/i, "");
        if (t.some(x => ["fax", "pager", "video", "textphone"].includes(x))) break;
        const kind = t.includes("cell") ? "cell" : t.includes("home") ? "home" : "work";
        if (!c.phones[kind]) c.phones[kind] = num;
        break;
      }
      case "ORG": c.company = parts(v)[0] || ""; break;
      case "TITLE": c.title = unescapeValue(v); break;
      case "ADR": {
        const p = parts(v);
        if (!c.address.street && !c.address.city) c.address = { street: p[2] || "", city: p[3] || "", region: p[4] || "", code: p[5] || "", country: p[6] || "" };
        break;
      }
      case "NOTE": c.notes = unescapeValue(v); break;
      case "BDAY": c.birthday = v; break;
    }
  }
  if (!c.display) c.display = [c.first, c.last].filter(Boolean).join(" ") || c.emails[0] || "";
  return c;
}

// the contact as a vCard: SG Mail's fields, then the lines it keeps as they were
export function toVCard(c, original = "") {
  const out = ["BEGIN:VCARD", "VERSION:4.0"];
  const display = c.display || [c.first, c.last].filter(Boolean).join(" ") || c.emails[0] || "";
  out.push("FN:" + escapeValue(display));
  out.push(`N:${escapeValue(c.last)};${escapeValue(c.first)};;;`);
  c.emails.filter(Boolean).forEach((e, i) => out.push(`EMAIL${i === 0 ? ";PREF=1" : ""}:${escapeValue(e)}`));
  for (const [kind, num] of Object.entries(c.phones || {})) if (num) out.push(`TEL;TYPE=${kind}:${escapeValue(num)}`);
  if (c.company) out.push("ORG:" + escapeValue(c.company));
  if (c.title) out.push("TITLE:" + escapeValue(c.title));
  const a = c.address || {};
  if (a.street || a.city || a.region || a.code || a.country) {
    out.push(`ADR;TYPE=work:;;${[a.street, a.city, a.region, a.code, a.country].map(escapeValue).join(";")}`);
  }
  if (c.notes) out.push("NOTE:" + escapeValue(c.notes));
  if (c.birthday) out.push("BDAY:" + c.birthday);
  for (const l of parseLines(original)) {
    // phones People does not show (fax, pager) kept too
    const other = l.name === "TEL" && typeOf(l.params).some(t => ["fax", "pager", "video", "textphone"].includes(t));
    if (!EDITED.has(l.name) || other) out.push(l.line);
  }
  out.push("END:VCARD");
  return out.join("\r\n") + "\r\n";
}
