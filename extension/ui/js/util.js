/*
 * SG Mail -- small helpers the windows share: escaping, dates as Outlook
 * groups them, addresses, menus and dialogs drawn in the page.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---- dates ------------------------------------------------------------------------------

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// the first day of the week this locale uses (0 Sunday .. 6 Saturday)
export function weekStartDay() {
  try {
    const info = new Intl.Locale(navigator.language).getWeekInfo?.() || new Intl.Locale(navigator.language).weekInfo;
    if (info && info.firstDay) return info.firstDay % 7;
  } catch (e) {
    // older engines
  }
  return /^en-(US|CA)|^ja|^he/.test(navigator.language) ? 0 : 1;
}

export function startOfWeek(d) {
  const x = startOfDay(d);
  const diff = (x.getDay() - weekStartDay() + 7) % 7;
  return addDays(x, -diff);
}

const dtf = (opts) => new Intl.DateTimeFormat(undefined, opts);
export const fmt = {
  time: d => dtf({ hour: "numeric", minute: "2-digit" }).format(d),
  weekdayTime: d => dtf({ weekday: "short", hour: "numeric", minute: "2-digit" }).format(d),
  short: d => dtf({ year: "numeric", month: "numeric", day: "numeric" }).format(d),
  shortDayTime: d => dtf({ weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d),
  full: d => dtf({ weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d),
  longDate: d => dtf({ weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d),
  monthYear: d => dtf({ month: "long", year: "numeric" }).format(d),
  monthDay: d => dtf({ month: "long", day: "numeric" }).format(d),
  dayNum: d => dtf({ day: "numeric" }).format(d),
  weekdayShort: d => dtf({ weekday: "short" }).format(d),
  weekdayLong: d => dtf({ weekday: "long" }).format(d),
  weekdayNarrow: d => dtf({ weekday: "narrow" }).format(d),
  hour: d => dtf({ hour: "numeric" }).format(d),
};

// Outlook's "By Date" arrangement: Today, Yesterday, the days of this week,
// Last Week, Two Weeks Ago, Three Weeks Ago, Last Month, Older
export function dateGroup(date, now = new Date()) {
  const today = startOfDay(now);
  const d = startOfDay(date);
  if (d > today) return { key: "future", label: "Future", order: 0 };
  if (sameDay(d, today)) return { key: "today", label: "Today", order: 1 };
  if (sameDay(d, addDays(today, -1))) return { key: "yesterday", label: "Yesterday", order: 2 };
  const week = startOfWeek(today);
  if (d >= week) return { key: "day-" + d.getDay(), label: fmt.weekdayLong(d), order: 3 + (6 - ((d.getDay() - weekStartDay() + 7) % 7)) / 10 };
  if (d >= addDays(week, -7)) return { key: "lastweek", label: "Last Week", order: 4 };
  if (d >= addDays(week, -14)) return { key: "2weeks", label: "Two Weeks Ago", order: 5 };
  if (d >= addDays(week, -21)) return { key: "3weeks", label: "Three Weeks Ago", order: 6 };
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (d >= monthStart) return { key: "earliermonth", label: "Earlier this Month", order: 6.5 };
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  if (d >= lastMonth) return { key: "lastmonth", label: "Last Month", order: 7 };
  return { key: "older", label: "Older", order: 8 };
}

// the time a message list shows: a time today, a weekday this week, a date before
export function listTime(date, now = new Date()) {
  const d = new Date(date);
  if (sameDay(d, now)) return fmt.time(d);
  if (d >= startOfWeek(now) && d <= now) return fmt.weekdayTime(d);
  return fmt.short(d);
}

export function sizeText(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---- addresses ----------------------------------------------------------------------------

// "Name <a@b>" -> {name, email}
export function parseAddress(s) {
  s = String(s || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  return { name: "", email: s };
}

// a list typed by the user: split on , or ; outside quotes and <>
export function splitAddresses(text) {
  const out = [];
  let cur = "", quoted = false, angle = 0;
  for (const c of String(text || "")) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "<") angle++;
    else if (!quoted && c === ">") angle = Math.max(0, angle - 1);
    if (!quoted && !angle && (c === "," || c === ";")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function formatAddress(a) {
  if (!a.name || a.name === a.email) return a.email;
  const n = /[,;<>"@()]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${n} <${a.email}>`;
}

export function displayName(s) {
  const a = parseAddress(s);
  return a.name || a.email;
}

export function validEmail(e) {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(e) || /^[^\s@]+@localhost$/.test(e) || /^[^\s@]+@[a-z0-9.-]+\.test$/i.test(e);
}

const AVATAR_COLORS = ["#0078d4", "#8764b8", "#038387", "#ca5010", "#498205", "#c239b3", "#986f0b", "#4f6bed", "#e3008c", "#00b7c3", "#7a7574", "#d13438"];
export function avatar(nameOrEmail) {
  const s = String(nameOrEmail || "?");
  let hash = 0;
  for (const c of s.toLowerCase()) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const words = s.replace(/<.*>/, "").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  let initials = words.length >= 2 ? words[0][0] + words[words.length - 1][0] : (words[0] || s).slice(0, 2);
  return { color: AVATAR_COLORS[hash % AVATAR_COLORS.length], initials: initials.toUpperCase() };
}

// ---- text ---------------------------------------------------------------------------------

export function textToHtml(text) {
  const escaped = esc(text);
  const linked = escaped.replace(/\b(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g, '<a href="$1">$1</a>');
  // quoted lines ("> ...") in a block, as replies show them
  const lines = linked.split(/\r?\n/);
  let out = "", depth = 0;
  for (let line of lines) {
    let d = 0;
    while (line.startsWith("&gt;")) {
      d++;
      line = line.slice(4).replace(/^ /, "");
    }
    while (depth < d) {
      out += '<blockquote class="q">';
      depth++;
    }
    while (depth > d) {
      out += "</blockquote>";
      depth--;
    }
    out += line + "\n";
  }
  while (depth-- > 0) out += "</blockquote>";
  return `<pre class="plain">${out}</pre>`;
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, head")) el.remove();
  for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
  for (const p of doc.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, blockquote")) p.append("\n");
  return (doc.body ? doc.body.textContent : "").replace(/\n{3,}/g, "\n\n").trim();
}

// ---- menus and dialogs, drawn in the page ---------------------------------------------------

let openMenu = null;
export function closeMenu() {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
  }
}

/**
 * A popup menu at (x, y) or under an element. items: [{label, icon, action,
 * disabled, checked, separator, submenu: items}]
 */
export function showMenu(items, at) {
  closeMenu();
  const menu = h("div", { class: "menu", role: "menu" });
  const build = (list, container) => {
    for (const it of list) {
      if (it.separator) {
        container.append(h("div", { class: "menu-sep" }));
        continue;
      }
      if (it.header) {
        container.append(h("div", { class: "menu-header", text: it.header }));
        continue;
      }
      const row = h("div", {
        class: "menu-item" + (it.disabled ? " disabled" : "") + (it.submenu ? " has-sub" : ""),
        role: "menuitem",
        tabindex: "-1",
        "data-id": it.id,
        html: `<span class="mi-icon">${it.checked ? icon("accept", 16) : it.icon ? icon(it.icon, 16) : (it.swatch ? `<span class="swatch" style="background:${esc(it.swatch)}"></span>` : "")}</span><span class="mi-label">${esc(it.label)}</span>${it.shortcut ? `<span class="mi-key">${esc(it.shortcut)}</span>` : ""}${it.submenu ? icon("chevron-right", 14) : ""}`,
      });
      if (it.submenu) {
        const sub = h("div", { class: "menu submenu" });
        build(it.submenu, sub);
        row.append(sub);
      } else if (!it.disabled) {
        row.addEventListener("click", e => {
          e.stopPropagation();
          closeMenu();
          it.action && it.action();
        });
      }
      container.append(row);
    }
  };
  build(items, menu);
  document.body.append(menu);
  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 2;
  } else {
    x = at.x;
    y = at.y;
  }
  const mr = menu.getBoundingClientRect();
  x = Math.min(x, window.innerWidth - mr.width - 4);
  y = Math.min(y, window.innerHeight - mr.height - 4);
  menu.style.left = Math.max(4, x) + "px";
  menu.style.top = Math.max(4, y) + "px";
  openMenu = menu;
  setTimeout(() => menu.querySelector(".menu-item:not(.disabled)")?.focus(), 0);
  return menu;
}
document.addEventListener("mousedown", e => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
document.addEventListener("keydown", e => {
  if (!openMenu) return;
  const items = $$(":scope > .menu-item:not(.disabled)", openMenu);
  const i = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    closeMenu();
    e.preventDefault();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const n = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    n && n.focus();
    e.preventDefault();
  } else if (e.key === "Enter" && i >= 0) {
    items[i].click();
    e.preventDefault();
  }
}, true);

/**
 * A modal dialog in the page. buttons: [{label, value, default, primary}].
 * Resolves with the chosen value (Escape: the cancel button's, or null).
 */
export function dialog({ title, body, buttons = [{ label: "OK", value: true, primary: true }], width = 420, init }) {
  return new Promise(resolve => {
    const shade = h("div", { class: "modal-shade" });
    const box = h("div", { class: "modal", role: "dialog", "aria-label": title, style: `width:${width}px` });
    const content = h("div", { class: "modal-body" });
    if (typeof body === "string") content.innerHTML = body;
    else if (body) content.append(body);
    const bar = h("div", { class: "modal-buttons" });
    const finish = v => {
      shade.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    for (const b of buttons) {
      const btn = h("button", { class: "btn" + (b.primary ? " primary" : ""), text: b.label, "data-value": String(b.value) });
      btn.addEventListener("click", () => finish(typeof b.value === "function" ? b.value(box) : b.value));
      bar.append(btn);
    }
    const onKey = e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const cancel = buttons.find(b => b.cancel);
        finish(cancel ? cancel.value : null);
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const def = buttons.find(b => b.primary);
        if (def) {
          e.preventDefault();
          finish(typeof def.value === "function" ? def.value(box) : def.value);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    box.append(h("div", { class: "modal-title", text: title }), content, bar);
    shade.append(box);
    document.body.append(shade);
    init && init(box);
    setTimeout(() => (box.querySelector("input, select, textarea") || box.querySelector(".btn.primary"))?.focus(), 0);
  });
}

export function alertBox(title, message) {
  return dialog({ title, body: `<p>${esc(message)}</p>` });
}

export function confirmBox(title, message, yes = "Yes", no = "No") {
  return dialog({
    title,
    body: `<p>${esc(message)}</p>`,
    buttons: [{ label: yes, value: true, primary: true }, { label: no, value: false, cancel: true }],
  });
}

let toastTimer = null;
export function toast(text, ms = 3500) {
  let t = $("#toast");
  if (!t) {
    t = h("div", { id: "toast", class: "toast", role: "status" });
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// the light or dark look: the system's, or the gates' override
export function applyLook() {
  const q = window.matchMedia("(prefers-color-scheme: dark)");
  const set = () => document.documentElement.classList.toggle("dark", q.matches);
  q.addEventListener("change", set);
  set();
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// the gates' hook: what the window shows, written for them to read
export async function testDump(name, data) {
  try {
    await messenger.sgmail.writeTestFile(name, JSON.stringify(data, null, 1));
  } catch (e) {
    // not under a gate
  }
}

// the address books' contacts matching what was typed (MV3: query; MV2: quickSearch)
// remote: the organisation's directories too (LDAP books: a Microsoft
// account's, through DavMail)
export async function searchAddressBooks(term, remote = false) {
  const api = messenger.addressBooks.contacts || messenger.contacts;
  if (api.query) return api.query({ searchString: term, includeRemote: remote });
  return api.quickSearch(term);
}
