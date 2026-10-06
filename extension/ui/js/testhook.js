/*
 * SG Mail -- the gates' hands: when Thunderbird runs under a gate
 * (SG_MAIL_TEST_OUT; the experiment's onTestRun is silent otherwise), a
 * gate asks a window to click, type, press keys or call one of its named
 * test functions, and gets the answer back. No code is evaluated: only these
 * commands.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

function find(selector, { text, index = 0 } = {}) {
  let list = [...document.querySelectorAll(selector)];
  if (text !== undefined) list = list.filter(el => el.textContent.trim() === text || (el.getAttribute("title") || "") === text);
  const el = list[index];
  if (!el) throw new Error(`nothing matches ${selector}${text !== undefined ? ` "${text}"` : ""}`);
  return el;
}

function mouse(el, type, opts = {}) {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, view: window, button: type === "contextmenu" ? 2 : 0,
    clientX: r.left + Math.min(r.width / 2, 20), clientY: r.top + r.height / 2 }, opts)));
}

const COMMANDS = {
  ping: () => ({ title: document.title, ready: !!window.sgmailReady }),
  click(a) {
    const el = find(a.selector, a);
    el.scrollIntoView?.({ block: "nearest" });
    mouse(el, "mousedown", a);
    mouse(el, "mouseup", a);
    mouse(el, "click", a);
    return true;
  },
  dblclick(a) {
    const el = find(a.selector, a);
    mouse(el, "mousedown", a);
    mouse(el, "mouseup", a);
    mouse(el, "click", a);
    mouse(el, "dblclick", a);
    return true;
  },
  contextmenu(a) {
    const el = find(a.selector, a);
    mouse(el, "mousedown", { button: 2 });
    mouse(el, "contextmenu", a);
    return true;
  },
  type(a) {
    const el = find(a.selector, { index: a.index || 0 });
    el.focus();
    if (el.isContentEditable) {
      if (!a.append) el.innerHTML = "";
      document.execCommand("insertText", false, a.value);
    } else {
      el.value = a.append ? el.value + a.value : a.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  },
  key(a) {
    const el = a.selector ? find(a.selector, a) : (document.activeElement || document.body);
    if (a.selector) el.focus();
    const ev = new KeyboardEvent("keydown", { key: a.key, code: a.code || "", ctrlKey: !!a.ctrl, shiftKey: !!a.shift, altKey: !!a.alt, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented };
  },
  // a mouse drag: pressed on an element (or an element inside it, a.inner),
  // moved in steps to another element's point (a.to) or by (dx, dy), let go
  drag(a) {
    let el = find(a.selector, a);
    if (a.inner) el = el.querySelector(a.inner);
    const at = (e, o) => {
      const r = e.getBoundingClientRect();
      return [r.left + (o.px !== undefined ? o.px : r.width * (o.fx ?? 0.5)) + (o.dx || 0),
        r.top + (o.py !== undefined ? o.py : r.height * (o.fy ?? 0.5)) + (o.dy || 0)];
    };
    const [x0, y0] = at(el, { fx: a.fx, fy: a.fy, px: a.px, py: a.py });
    const [x1, y1] = a.to ? at(find(a.to.selector, a.to), a.to) : [x0 + (a.dx || 0), y0 + (a.dy || 0)];
    const fire = (target, type, x, y) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, buttons: type === "mouseup" ? 0 : 1, clientX: x, clientY: y }));
    fire(el, "mousedown", x0, y0);
    const steps = a.steps || 6;
    for (let i = 1; i <= steps; i++) fire(document, "mousemove", x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
    if (!a.hold) fire(document, "mouseup", x1, y1);
    return { from: [x0, y0], to: [x1, y1] };
  },
  // where an element's point is on the screen (for real pointer input)
  screenPoint(a) {
    let el = find(a.selector, a);
    if (a.inner) el = el.querySelector(a.inner);
    el.scrollIntoView?.({ block: "nearest" });
    const r = el.getBoundingClientRect();
    const s = window.devicePixelRatio || 1;
    return { x: Math.round((window.mozInnerScreenX + r.left + (a.px !== undefined ? a.px : r.width * (a.fx ?? 0.5))) * s),
      y: Math.round((window.mozInnerScreenY + r.top + (a.py !== undefined ? a.py : r.height * (a.fy ?? 0.5))) * s) };
  },
  focus(a) {
    find(a.selector, a).focus();
    return true;
  },
  menu(a) {
    const item = [...document.querySelectorAll(".menu .menu-item")].find(el => el.querySelector(".mi-label")?.textContent.trim() === a.label);
    if (!item) throw new Error(`no menu item "${a.label}"`);
    item.click();
    return true;
  },
  button(a) {
    const b = [...document.querySelectorAll(".modal .btn")].find(el => el.textContent.trim() === a.label);
    if (!b) throw new Error(`no dialog button "${a.label}"`);
    b.click();
    return true;
  },
  text: a => [...document.querySelectorAll(a.selector)].map(el => el.innerText),
  value: a => find(a.selector, a).value,
  count: a => document.querySelectorAll(a.selector).length,
  attr: a => find(a.selector, a).getAttribute(a.name),
  html: a => find(a.selector, a).innerHTML,
  style: a => getComputedStyle(find(a.selector, a))[a.prop],
  rect(a) {
    const el = document.querySelectorAll(a.selector)[a.index || 0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, shown: r.width > 0 && r.height > 0 };
  },
};

const seenKeys = [];

export function installTestHook(name, api = {}) {
  if (!messenger.sgmail || !messenger.sgmail.onTestRun) return;
  // the keys the page saw (a gate's real keystrokes reach it or not)
  document.addEventListener("keydown", e => {
    seenKeys.push(`${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}${e.altKey ? "Alt+" : ""}${e.key}`);
    if (seenKeys.length > 50) seenKeys.shift();
  }, true);
  COMMANDS.keys = () => seenKeys.slice();
  messenger.sgmail.onTestRun.addListener(async req => {
    if (req.target !== name && !(req.target === "compose" && name === "compose") ) return;
    if (req.window && req.window !== location.search) return;
    let reply;
    try {
      const fn = COMMANDS[req.cmd] || api[req.cmd];
      if (!fn) throw new Error(`no command ${req.cmd}`);
      reply = { value: await fn(req.args || {}) };
    } catch (e) {
      reply = { error: String(e && e.message || e) };
    }
    try {
      reply = JSON.parse(JSON.stringify(reply));
    } catch (e) {
      reply = { error: "the answer is not JSON" };
    }
    messenger.sgmail.testReply(req.id, reply);
  });
}
