/*
 * SG Mail -- the message list: the folder's messages newest first, in
 * Outlook's date groups (Today, Yesterday, ... Older), each row the sender,
 * the subject, the time, the first words of the text, and the attachment,
 * flag and reply marks; unread ones bold with the accent bar. Only the rows
 * in view are drawn, so a folder of tens of thousands scrolls freely.
 * Shown as conversations, the messages of one conversation are one row
 * (its people, subject and newest message) that opens to show them.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, esc, dateGroup, listTime, displayName, debounce } from "./util.js";

const GROUP_H = 28;
const ROW_H = 68;
const COMPACT_H = 30;           // one line a message (the reading pane at the bottom, or off)
const CHILD_H = 46;             // a message under its conversation

// a subject without its Re: / Fw: prefixes
export function baseSubject(s) {
  return String(s || "").replace(/^((re|fw|fwd|aw|wg|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, "").trim();
}

export class MessageList {
  constructor(el, { onSelect, onOpen, onContext, onFlag, onDragStart }) {
    this.el = el;
    this.spacer = el.querySelector(".ml-spacer");
    this.onSelect = onSelect;
    this.onOpen = onOpen;
    this.onContext = onContext;
    this.onFlag = onFlag;
    this.onDragStart = onDragStart;
    this.messages = [];
    this.byId = new Map();
    this.extras = new Map();        // id -> {preview, attachment, replied, forwarded}
    this.rows = [];                 // the layout: {type, top, height, group?, msg?}
    this.order = [];
    this.collapsed = new Set();
    // conversations: message id -> its conversation; the ones opened; the
    // messages of each listed (newest first by the list's order)
    this.conversations = false;
    this.convOf = new Map();
    this.expanded = new Set();
    this.convs = new Map();
    this.selected = new Set();
    this.anchor = null;
    this.focusId = null;
    this.sort = { by: "date", desc: true };
    this.filter = "all";
    this.emptyText = "We didn't find anything to show here.";
    this.drawn = new Map();
    this.fetchExtras = debounce(() => this.loadExtras(), 120);
    el.addEventListener("scroll", () => this.draw());
    el.addEventListener("keydown", e => this.onKey(e));
    new ResizeObserver(() => this.draw()).observe(el);
  }

  setMessages(list, { keepSelection = false } = {}) {
    this.messages = list;
    this.byId = new Map(list.map(m => [m.id, m]));
    if (!keepSelection) {
      this.selected.clear();
      this.anchor = null;
      this.focusId = null;
    } else {
      for (const id of [...this.selected]) if (typeof id !== "string" && !this.byId.has(id)) this.selected.delete(id);
    }
    this.layout();
    // a conversation chosen stays chosen while it is listed
    for (const id of [...this.selected]) if (typeof id === "string" && !this.order.includes(id)) this.selected.delete(id);
    if (!keepSelection) this.el.scrollTop = 0;
    this.draw(true);
  }

  visibleMessages() {
    let list = this.messages;
    if (this.focusFilter) list = list.filter(this.focusFilter);
    if (this.filter === "unread") list = list.filter(m => !m.read || this.selected.has(m.id));
    else if (this.filter === "flagged") list = list.filter(m => m.flagged);
    const dir = this.sort.desc ? -1 : 1;
    const key = {
      date: m => m.date.getTime(),
      from: m => displayName(m.author).toLowerCase(),
      subject: m => (m.subject || "").replace(/^((re|fw|fwd|aw|wg|sv|vs)\s*:\s*)+/i, "").toLowerCase(),
      size: m => m.size,
    }[this.sort.by];
    return [...list].sort((a, b) => {
      const ka = key(a), kb = key(b);
      return (ka < kb ? -1 : ka > kb ? 1 : 0) * dir || (b.date - a.date);
    });
  }

  groupOf(m) {
    if (this.sort.by === "date") return dateGroup(m.date);
    if (this.sort.by === "from") {
      const n = displayName(m.author);
      return { key: "from:" + n.toLowerCase(), label: n };
    }
    return null;
  }

  // what the list shows: messages, or (as conversations) a conversation's
  // messages as one item where it has more than one
  items() {
    const visible = this.visibleMessages();
    this.convs = new Map();
    if (!this.conversations) return visible.map(m => ({ msg: m }));
    const items = [], byKey = new Map();
    for (const m of visible) {
      const k = this.convOf.get(m.id);
      if (!k) {
        items.push({ msg: m });
        continue;
      }
      let it = byKey.get(k);
      if (!it) {
        byKey.set(k, it = { conv: k, msgs: [], msg: m });
        items.push(it);
      }
      it.msgs.push(m);
    }
    return items.map(it => {
      if (!it.conv) return it;
      if (it.msgs.length === 1) return { msg: it.msgs[0] };
      this.convs.set(it.conv, it.msgs);
      return it;
    });
  }

  layout() {
    const rows = [];
    let top = 0, lastGroup = null, groupRow = null;
    this.order = [];
    // every item of the view, also in groups closed (what Ctrl+A selects)
    this.allKeys = [];
    for (const it of this.items()) {
      this.allKeys.push(it.conv ? "c:" + it.conv : it.msg.id);
      if (it.conv && this.expanded.has(it.conv)) for (const c of it.msgs) this.allKeys.push(c.id);
      const m = it.msg;
      const g = this.groupOf(m);
      if (g && (!lastGroup || g.key !== lastGroup.key)) {
        groupRow = { type: "group", group: g, top, height: GROUP_H, count: 0 };
        rows.push(groupRow);
        top += GROUP_H;
        lastGroup = g;
      }
      if (groupRow) groupRow.count++;
      if (g && this.collapsed.has(g.key)) continue;
      const rh = this.compact ? COMPACT_H : ROW_H;
      if (it.conv) {
        rows.push({ type: "conv", conv: it.conv, msgs: it.msgs, msg: m, top, height: rh });
        this.order.push("c:" + it.conv);
        top += rh;
        if (this.expanded.has(it.conv)) {
          for (const c of [...it.msgs].sort((a, b) => b.date - a.date)) {
            const ch = this.compact ? COMPACT_H : CHILD_H;
            rows.push({ type: "msg", msg: c, child: true, top, height: ch });
            this.order.push(c.id);
            top += ch;
          }
        }
        continue;
      }
      rows.push({ type: "msg", msg: m, top, height: rh });
      this.order.push(m.id);
      top += rh;
    }
    this.rows = rows;
    this.total = top;
    this.spacer.style.height = top + "px";
    this.renderEmpty();
  }

  // the conversation a message is listed in (one of more than one message)
  conversationOf(id) {
    const k = this.convOf.get(id);
    return k && this.convs.has(k) ? k : null;
  }

  expand(conv, on) {
    if (on) this.expanded.add(conv);
    else this.expanded.delete(conv);
    this.layout();
    this.draw(true);
  }

  renderEmpty() {
    let e = this.el.querySelector(".ml-empty");
    if (!this.rows.length) {
      if (!e) {
        e = h("div", { class: "ml-empty" });
        this.el.append(e);
      }
      e.textContent = this.loading ? "Loading…" : this.emptyText;
    } else if (e) e.remove();
  }

  setCompact(on) {
    if (!!this.compact === !!on) return;
    this.compact = !!on;
    this.el.classList.toggle("compact", this.compact);
    this.layout();
    this.draw(true);
    if (this.focusId !== null) this.scrollTo(this.focusId);
  }

  setLoading(on) {
    this.loading = on;
    this.renderEmpty();
  }

  draw(force = false) {
    const top = this.el.scrollTop, bottom = top + this.el.clientHeight + 200;
    const want = new Set();
    // find the first row in view (rows are sorted by top)
    let lo = 0, hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.rows[mid].top + this.rows[mid].height < top - 200) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.rows.length && this.rows[i].top < bottom; i++) {
      const r = this.rows[i];
      const key = r.type === "group" ? "g:" + r.group.key : r.type === "conv" ? "c:" + r.conv : "m:" + r.msg.id;
      want.add(key);
      let el = this.drawn.get(key);
      if (!el || force) {
        if (el) el.remove();
        el = r.type === "group" ? this.groupEl(r) : r.type === "conv" ? this.convEl(r) : this.msgEl(r.msg, r.child);
        this.drawn.set(key, el);
        this.el.append(el);
      }
      el.style.top = r.top + "px";
    }
    for (const [key, el] of this.drawn) {
      if (!want.has(key)) {
        el.remove();
        this.drawn.delete(key);
      }
    }
    this.fetchExtras();
  }

  groupEl(r) {
    const collapsed = this.collapsed.has(r.group.key);
    const el = h("div", {
      class: "ml-row ml-group",
      html: `<span class="twisty">${icon(collapsed ? "chevron-right" : "chevron-down", 12)}</span><span>${esc(r.group.label)}</span>` +
        (collapsed ? ` <span class="count">(${r.count})</span>` : ""),
    });
    el.addEventListener("click", () => {
      if (this.collapsed.has(r.group.key)) this.collapsed.delete(r.group.key);
      else this.collapsed.add(r.group.key);
      this.layout();
      this.draw(true);
    });
    return el;
  }

  // a conversation: its people (newest first), how many, its subject, the
  // newest message's time and first words; the arrow opens it
  convEl(r) {
    const key = "c:" + r.conv;
    const msgs = r.msgs;
    const newest = msgs.reduce((a, b) => (b.date > a.date ? b : a), msgs[0]);
    const x = this.extras.get(newest.id) || {};
    const open = this.expanded.has(r.conv);
    const unread = msgs.filter(m => !m.read).length;
    const flagged = msgs.some(m => m.flagged);
    const el = h("div", {
      class: "ml-row ml-msg ml-conv" + (unread ? " unread" : "") + (this.selected.has(key) ? " selected" : "") + (open ? " expanded" : "") + (this.compact ? " compact" : ""),
      role: "option",
      "aria-selected": this.selected.has(key) ? "true" : "false",
      "aria-expanded": open ? "true" : "false",
      "data-id": key,
      draggable: "true",
    });
    const sentLike = this.folderRole === "sent" || this.folderRole === "drafts" || this.folderRole === "outbox";
    const people = [];
    for (const m of [...msgs].sort((a, b) => b.date - a.date)) {
      for (const p of sentLike ? (m.recipients || []) : [m.author]) {
        const n = displayName(p);
        if (n && !people.includes(n)) people.push(n);
      }
    }
    const marks = [];
    if (msgs.some(m => (this.extras.get(m.id) || {}).attachment)) marks.push(icon("attach", 15));
    const twisty = `<button class="ml-twisty" title="${open ? "Collapse" : "Expand"} the conversation">${icon(open ? "chevron-down" : "chevron-right", 12)}</button>`;
    const count = `<span class="ml-count" title="${msgs.length} messages${unread ? `, ${unread} unread` : ""}">${msgs.length}</span>`;
    const subject = esc(baseSubject(newest.subject) || "(no subject)");
    const flag = `<button class="ml-flag${flagged ? " on" : ""}" title="${flagged ? "Clear flag" : "Flag this conversation"}">${icon(flagged ? "flag-filled" : "flag", 15)}</button>`;
    if (this.compact) {
      el.innerHTML = `<div class="ml-line">${twisty}<span class="ml-from">${esc(people.join("; "))}</span>${count}<span class="ml-subject">${subject}</span>` +
        `<span class="ml-icons">${marks.join("")}</span><span class="ml-time">${esc(listTime(newest.date))}</span>${flag}</div>`;
    } else el.innerHTML =
      `<div class="ml-line">${twisty}<span class="ml-from">${esc(people.join("; "))}</span>${count}<span class="ml-icons">${marks.join("")}</span>${flag}</div>` +
      `<div class="ml-line"><span class="ml-subject">${subject}</span><span class="ml-time">${esc(listTime(newest.date))}</span></div>` +
      `<div class="ml-line ml-preview">${esc(x.preview || "")}</div>`;
    el.querySelector(".ml-twisty").addEventListener("mousedown", e => {
      e.stopPropagation();
      e.preventDefault();
    });
    el.querySelector(".ml-twisty").addEventListener("click", e => {
      e.stopPropagation();
      this.expand(r.conv, !open);
    });
    el.querySelector(".ml-flag").addEventListener("click", e => {
      e.stopPropagation();
      this.onFlag(msgs);
    });
    el.addEventListener("mousedown", e => {
      if (e.button === 0) this.clickRow(key, e);
      else if (e.button === 2 && !this.selected.has(key)) this.clickRow(key, {});
    });
    el.addEventListener("dblclick", () => this.onOpen(newest));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      this.onContext(this.selection(), { x: e.clientX, y: e.clientY });
    });
    el.addEventListener("dragstart", e => {
      if (!this.selected.has(key)) this.clickRow(key, {});
      e.dataTransfer.setData("application/x-sgmail-messages", JSON.stringify(this.selection().map(m => m.id)));
      e.dataTransfer.effectAllowed = "copyMove";
      this.onDragStart && this.onDragStart();
    });
    return el;
  }

  msgEl(m, child = false) {
    const x = this.extras.get(m.id) || {};
    const el = h("div", {
      class: "ml-row ml-msg" + (m.read ? "" : " unread") + (this.selected.has(m.id) ? " selected" : "") + (child ? " child" : ""),
      role: "option",
      "aria-selected": this.selected.has(m.id) ? "true" : "false",
      "data-id": m.id,
      draggable: "true",
    });
    const from = this.folderRole === "sent" || this.folderRole === "drafts" || this.folderRole === "outbox"
      ? (m.recipients || []).map(displayName).join("; ") || "(no recipient)"
      : displayName(m.author) || "(unknown sender)";
    const marks = [];
    if (x.replied) marks.push(icon("reply", 15));
    if (x.forwarded) marks.push(icon("forward", 15));
    if (x.attachment) marks.push(icon("attach", 15));
    if (x.priority >= 5) marks.push(icon("importance-high", 15));
    const cats = (m.tags || []).map(t => this.tagColor && this.tagColor(t)).filter(Boolean)
      .map(c => `<span class="ml-cat" style="background:${esc(c)}"></span>`).join("");
    if (child && !this.compact) {
      el.innerHTML =
        `<div class="ml-line"><span class="ml-from">${esc(from)}</span><span class="ml-icons">${cats}${marks.join("")}</span><span class="ml-time">${esc(listTime(m.date))}</span>` +
        `<button class="ml-flag${m.flagged ? " on" : ""}" title="${m.flagged ? "Clear flag" : "Flag this message"}">${icon(m.flagged ? "flag-filled" : "flag", 15)}</button></div>` +
        `<div class="ml-line ml-preview">${esc(x.preview || "")}</div>`;
    } else if (this.compact) {
      el.classList.add("compact");
      el.innerHTML =
        `<div class="ml-line"><span class="ml-from">${esc(from)}</span><span class="ml-subject">${esc((x.hasRe ? "RE: " : "") + (m.subject || "(no subject)"))}</span>` +
        `<span class="ml-icons">${cats}${marks.join("")}</span><span class="ml-time">${esc(listTime(m.date))}</span>` +
        `<button class="ml-flag${m.flagged ? " on" : ""}" title="${m.flagged ? "Clear flag" : "Flag this message"}">${icon(m.flagged ? "flag-filled" : "flag", 15)}</button></div>`;
    } else el.innerHTML =
      `<div class="ml-line"><span class="ml-from">${esc(from)}</span><span class="ml-icons">${cats}${marks.join("")}</span>` +
      `<button class="ml-flag${m.flagged ? " on" : ""}" title="${m.flagged ? "Clear flag" : "Flag this message"}">${icon(m.flagged ? "flag-filled" : "flag", 15)}</button></div>` +
      `<div class="ml-line"><span class="ml-subject">${esc((x.hasRe ? "RE: " : "") + (m.subject || "(no subject)"))}</span><span class="ml-time">${esc(listTime(m.date))}</span></div>` +
      `<div class="ml-line ml-preview">${esc(x.preview || "")}</div>`;
    el.querySelector(".ml-flag").addEventListener("click", e => {
      e.stopPropagation();
      this.onFlag(m);
    });
    el.addEventListener("mousedown", e => {
      if (e.button === 0) this.clickRow(m.id, e);
      else if (e.button === 2 && !this.selected.has(m.id)) this.clickRow(m.id, {});
    });
    el.addEventListener("dblclick", () => this.onOpen(m));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      this.onContext([...this.selected].map(id => this.byId.get(id)).filter(Boolean), { x: e.clientX, y: e.clientY });
    });
    el.addEventListener("dragstart", e => {
      if (!this.selected.has(m.id)) this.clickRow(m.id, {});
      e.dataTransfer.setData("application/x-sgmail-messages", JSON.stringify(this.selection().map(x => x.id)));
      e.dataTransfer.effectAllowed = "copyMove";
      this.onDragStart && this.onDragStart();
    });
    return el;
  }

  clickRow(id, e) {
    if (e.shiftKey && this.anchor !== null) {
      const a = this.order.indexOf(this.anchor), b = this.order.indexOf(id);
      if (!e.ctrlKey) this.selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) this.selected.add(this.order[i]);
    } else if (e.ctrlKey) {
      if (this.selected.has(id)) this.selected.delete(id);
      else this.selected.add(id);
      this.anchor = id;
    } else {
      this.selected.clear();
      this.selected.add(id);
      this.anchor = id;
    }
    this.focusId = id;
    this.el.focus({ preventScroll: true });
    this.paintSelection();
    this.onSelect(this.selection());
  }

  // the selected messages: a conversation's are all of its messages here
  selection() {
    const out = [], seen = new Set();
    for (const k of this.allKeys || this.order) {
      if (!this.selected.has(k)) continue;
      const list = typeof k === "string" ? this.convs.get(k.slice(2)) || [] : [this.byId.get(k)];
      for (const m of list) {
        if (m && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    }
    return out;
  }

  // the conversation selected as one (its row), if that is the selection
  selectedConversation() {
    if (this.selected.size !== 1) return null;
    const k = [...this.selected][0];
    return typeof k === "string" && this.convs.has(k.slice(2)) ? k.slice(2) : null;
  }

  select(id) {
    if (typeof id === "string") {
      if (!this.order.includes(id)) return false;
      this.selected = new Set([id]);
      this.anchor = this.focusId = id;
      this.paintSelection();
      this.scrollTo(id);
      this.onSelect(this.selection());
      return true;
    }
    if (!this.byId.has(id)) return false;
    // its group open, and its conversation
    const g = this.groupOf(this.byId.get(id));
    const conv = this.conversationOf(id);
    if ((g && this.collapsed.has(g.key)) || (conv && !this.expanded.has(conv))) {
      if (g) this.collapsed.delete(g.key);
      if (conv) this.expanded.add(conv);
      this.layout();
      this.draw(true);
    }
    this.selected = new Set([id]);
    this.anchor = this.focusId = id;
    this.paintSelection();
    this.scrollTo(id);
    this.onSelect(this.selection());
    return true;
  }

  // Ctrl+A: every message of the view (a conversation's row stands for all of its)
  selectAll() {
    this.selected = new Set((this.allKeys || this.order).filter(k => typeof k === "string" || !this.conversationOf(k)));
    if (this.focusId === null && this.order.length) this.focusId = this.anchor = this.order[0];
    this.paintSelection();
    this.onSelect(this.selection());
  }

  paintSelection() {
    for (const el of this.el.querySelectorAll(".ml-msg")) {
      const raw = el.dataset.id;
      const on = this.selected.has(raw.startsWith("c:") ? raw : Number(raw));
      el.classList.toggle("selected", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  scrollTo(id) {
    const r = this.rows.find(x => (typeof id === "string" ? x.type === "conv" && "c:" + x.conv === id : x.type === "msg" && x.msg.id === id));
    if (!r) return;
    if (r.top < this.el.scrollTop) this.el.scrollTop = r.top - (r.top > GROUP_H ? GROUP_H : 0);
    else if (r.top + r.height > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = r.top + r.height - this.el.clientHeight;
  }

  onKey(e) {
    if (!this.order.length) return;
    const cur = this.order.indexOf(this.focusId);
    let next = null;
    if (e.key === "ArrowDown") next = Math.min(this.order.length - 1, cur + 1);
    else if (e.key === "ArrowUp") next = Math.max(0, cur - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = this.order.length - 1;
    else if (e.key === "PageDown") next = Math.min(this.order.length - 1, cur + Math.floor(this.el.clientHeight / (this.compact ? COMPACT_H : ROW_H)));
    else if (e.key === "PageUp") next = Math.max(0, cur - Math.floor(this.el.clientHeight / (this.compact ? COMPACT_H : ROW_H)));
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && this.conversations) {
      // a conversation opened and closed by the keys, as a tree
      const k = this.focusId;
      const conv = typeof k === "string" ? k.slice(2) : this.conversationOf(k);
      if (!conv) return;
      e.preventDefault();
      if (e.key === "ArrowRight") {
        if (!this.expanded.has(conv)) this.expand(conv, true);
      } else {
        this.expand(conv, false);
        this.clickRow("c:" + conv, {});
        this.scrollTo("c:" + conv);
      }
      return;
    } else if (e.key === "Enter" && this.focusId !== null) {
      const k = this.focusId;
      this.onOpen(typeof k === "string" ? (this.convs.get(k.slice(2)) || [])[0] : this.byId.get(k));
      e.preventDefault();
      return;
    } else if (e.key === "a" && e.ctrlKey) {
      this.selectAll();
      e.preventDefault();
      return;
    }
    if (next === null) return;
    e.preventDefault();
    const id = this.order[next < 0 ? 0 : next];
    if (e.shiftKey) this.clickRow(id, { shiftKey: true });
    else this.clickRow(id, {});
    this.scrollTo(id);
  }

  // a message changed (read, flagged, ...) or arrived or left
  update(msg) {
    if (!this.byId.has(msg.id)) return;
    Object.assign(this.byId.get(msg.id), msg);
    const el = this.drawn.get("m:" + msg.id);
    if (el) {
      const n = this.msgEl(this.byId.get(msg.id), el.classList.contains("child"));
      n.style.top = el.style.top;
      el.replaceWith(n);
      this.drawn.set("m:" + msg.id, n);
    }
    // its conversation's row too
    const conv = this.conversationOf(msg.id);
    const cel = conv && this.drawn.get("c:" + conv);
    const row = cel && this.rows.find(r => r.type === "conv" && r.conv === conv);
    if (row) {
      const n = this.convEl(row);
      n.style.top = cel.style.top;
      cel.replaceWith(n);
      this.drawn.set("c:" + conv, n);
    }
  }

  add(msgs) {
    let added = false;
    for (const m of msgs) {
      if (this.byId.has(m.id)) continue;
      this.messages.push(m);
      this.byId.set(m.id, m);
      added = true;
    }
    if (added) {
      this.layout();
      this.draw(true);
    }
  }

  remove(ids) {
    const gone = new Set(ids);
    if (![...gone].some(id => this.byId.has(id))) return;
    // a conversation's row goes with its last message here
    const isGone = k => (typeof k === "string" ? (this.convs.get(k.slice(2)) || []).every(m => gone.has(m.id)) : gone.has(k));
    // the selection moves to the next message, as Outlook's
    let nextId = null, nextConv = null;
    if ([...this.selected].some(isGone)) {
      const idx = Math.max(...[...this.selected].map(id => this.order.indexOf(id)));
      for (let i = idx + 1; i < this.order.length; i++) if (!isGone(this.order[i])) {
        nextId = this.order[i];
        break;
      }
      if (nextId === null) for (let i = this.order.length - 1; i >= 0; i--) if (!isGone(this.order[i])) {
        nextId = this.order[i];
        break;
      }
      if (typeof nextId === "string") nextConv = (this.convs.get(nextId.slice(2)) || []).find(m => !gone.has(m.id));
    }
    this.messages = this.messages.filter(m => !gone.has(m.id));
    for (const k of [...this.selected]) if (isGone(k)) this.selected.delete(k);
    for (const id of gone) {
      this.byId.delete(id);
      this.selected.delete(id);
    }
    this.layout();
    this.draw(true);
    // (a conversation left with one message is that message's row)
    if (typeof nextId === "string" && !this.order.includes(nextId)) nextId = nextConv ? nextConv.id : null;
    if (nextId !== null) this.select(nextId);
    else if (!this.selected.size) this.onSelect([]);
  }

  async loadExtras() {
    const want = [];
    for (const key of this.drawn.keys()) {
      if (key.startsWith("c:")) {
        for (const m of this.convs.get(key.slice(2)) || []) if (!this.extras.has(m.id)) want.push(m.id);
        continue;
      }
      if (!key.startsWith("m:")) continue;
      const id = Number(key.slice(2));
      if (!this.extras.has(id)) want.push(id);
    }
    if (!want.length) return;
    for (const id of want) this.extras.set(id, {});     // asked once
    // a little at a time, giving way to the person's own clicks (through a
    // Microsoft account's DavMail gateway a preview is a whole message)
    const idle = async () => {
      while (performance.now() < (window.sgmailBusyUntil || 0)) await new Promise(r => setTimeout(r, 200));
    };
    try {
      const got = [];
      for (let i = 0; i < want.length; i += 8) {
        await idle();
        const part = await messenger.sgmail.messageExtras(want.slice(i, i + 8));
        got.push(...part);
        for (const x of part) {
          this.extras.set(x.id, x);
          const m = this.byId.get(x.id);
          if (m) this.update(m);
        }
      }
      // Thunderbird keeps no first words for messages it has not stored
      // offline: read the text of the ones in view
      for (const x of got.filter(g => !g.preview)) {
        const conv = this.conversationOf(x.id);
        if (!this.drawn.has("m:" + x.id) && !(conv && this.drawn.has("c:" + conv) && (this.convs.get(conv) || [])[0]?.id === x.id)) continue;
        await idle();
        try {
          const parts = await messenger.messages.listInlineTextParts(x.id);
          const plain = parts.find(p => p.contentType === "text/plain");
          let text = plain ? plain.content : "";
          if (!text) {
            const html = parts.find(p => p.contentType === "text/html");
            if (html) text = await messenger.messengerUtilities.convertToPlainText(html.content);
          }
          x.preview = text.replace(/^>.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 200);
          const m = this.byId.get(x.id);
          if (m) this.update(m);
        } catch (e) {
          // the server is away
        }
      }
    } catch (e) {
      console.error("sg-mail: previews", e);
    }
  }

  // what the gates read: the list as drawn, group by group
  dump() {
    return this.rows.map(r => r.type === "group"
      ? { group: r.group.label }
      : r.type === "conv"
      ? { conv: r.conv, subject: baseSubject(r.msg.subject), count: r.msgs.length, unread: r.msgs.filter(m => !m.read).length,
          expanded: this.expanded.has(r.conv), selected: this.selected.has("c:" + r.conv), subjects: r.msgs.map(m => m.subject) }
      : { id: r.msg.id, child: !!r.child, from: displayName(r.msg.author), subject: r.msg.subject, unread: !r.msg.read, flagged: !!r.msg.flagged,
          selected: this.selected.has(r.msg.id), preview: (this.extras.get(r.msg.id) || {}).preview || "", attachment: !!(this.extras.get(r.msg.id) || {}).attachment });
  }
}
