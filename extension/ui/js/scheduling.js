/*
 * SG Mail -- the Scheduling Assistant of the meeting window: each
 * attendee's busy times in a grid of the day (from one's own calendars, the
 * calendars of theirs one has opened, and their calendar server's free/busy
 * where it offers it: CalDAV scheduling), the meeting's time over them, a
 * click to move it, and AutoPick Next: the next time everyone is free in the
 * working day.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, fmt, startOfDay, addDays, sameDay, toast } from "./util.js";

const HOUR_W = 84;                       // a column an hour, halves marked
const WORK_START = 8, WORK_END = 17;
const BUSY = new Set(["busy", "tentative", "unavailable"]);

export class SchedulingAssistant {
  // host: { getTimes() -> {start, end, allDay}, setTimes(start, end), getAttendees() -> [{name, email}],
  //         addAttendee(text), me() -> {name, email} }
  constructor(el, host) {
    this.el = el;
    this.host = host;
    this.cache = new Map();             // email -> {from, to, known, intervals}
    this.day = startOfDay(new Date(host.getTimes().start));
  }

  people() {
    const me = this.host.me();
    const list = [];
    if (me && me.email) list.push({ name: me.name || me.email, email: me.email.toLowerCase(), organizer: true });
    for (const a of this.host.getAttendees()) {
      const e = a.email.toLowerCase();
      if (!list.some(x => x.email === e)) list.push({ name: a.name || a.email, email: e });
    }
    return list;
  }

  async show() {
    this.day = startOfDay(new Date(this.host.getTimes().start));
    this.render();
    await this.load();
  }

  // the free/busy of everyone for two weeks from the day shown
  async load(force = false) {
    const from = this.day.getTime(), to = addDays(this.day, 14).getTime();
    const want = this.people().filter(p => force || !(this.cache.get(p.email) && this.cache.get(p.email).from <= from && this.cache.get(p.email).to >= addDays(this.day, 1).getTime()));
    if (want.length) {
      this.loading = true;
      this.paintRows();
      try {
        const got = await messenger.sgmail.freeBusy(want.map(p => p.email), from, to);
        for (const g of got) this.cache.set(g.email, { from, to, known: g.known, sources: g.sources, intervals: g.intervals });
      } catch (e) {
        toast("Free/busy could not be read: " + e.message);
      }
      this.loading = false;
    }
    this.paintRows();
  }

  render() {
    const prev = h("button", { class: "sa-nav", title: "Previous day", html: icon("chevron-left", 16) });
    const next = h("button", { class: "sa-nav", title: "Next day", html: icon("chevron-right", 16) });
    prev.addEventListener("click", () => this.go(-1));
    next.addEventListener("click", () => this.go(1));
    const auto = h("button", { class: "btn small", id: "sa-autopick", html: `AutoPick Next ${icon("chevron-right", 12)}` });
    auto.addEventListener("click", () => this.autoPick());
    const legend = h("div", { class: "sa-legend" },
      h("span", { class: "sa-key busy" }), "Busy",
      h("span", { class: "sa-key tentative" }), "Tentative",
      h("span", { class: "sa-key unavailable" }), "Out of Office",
      h("span", { class: "sa-key unknown" }), "No Information");
    this.title = h("span", { class: "sa-day", id: "sa-day" });
    const bar = h("div", { class: "sa-bar" }, prev, next, this.title, h("span", { style: "flex:1" }), auto);
    this.names = h("div", { class: "sa-names" });
    this.timeline = h("div", { class: "sa-timeline", style: `width:${24 * HOUR_W}px` });
    this.scroll = h("div", { class: "sa-scroll", id: "sa-scroll" }, this.timeline);
    const grid = h("div", { class: "sa-grid" }, this.names, this.scroll);
    this.el.replaceChildren(bar, grid, legend);
    this.timeline.addEventListener("mousedown", e => {
      if (e.button !== 0) return;
      const r = this.timeline.getBoundingClientRect();
      const minutes = Math.max(0, Math.min(24 * 60 - 30, Math.floor((e.clientX - r.left) / (HOUR_W / 2)) * 30));
      const t = this.host.getTimes();
      const start = this.day.getTime() + minutes * 60000;
      this.host.setTimes(start, start + (t.end - t.start));
      this.paintRows();
    });
    this.paintRows();
    this.scroll.scrollLeft = (WORK_START - 0.5) * HOUR_W;
  }

  go(dir) {
    this.day = addDays(this.day, dir);
    this.paintRows();
    this.load();
  }

  busyOf(email, from, to) {
    const c = this.cache.get(email);
    if (!c || !c.known) return null;
    return c.intervals.filter(iv => BUSY.has(iv.type) && iv.end > from && iv.start < to);
  }

  paintRows() {
    if (!this.timeline) return;
    this.title.textContent = fmt.longDate(this.day);
    const people = this.people();
    const dayStart = this.day.getTime(), dayEnd = addDays(this.day, 1).getTime();
    const x = ms => (Math.max(dayStart, Math.min(dayEnd, ms)) - dayStart) / 3600000 * HOUR_W;
    const head = h("div", { class: "sa-hours" });
    for (let i = 0; i < 24; i++) head.append(h("div", { class: "sa-hour", style: `left:${i * HOUR_W}px;width:${HOUR_W}px`, text: fmt.hour(new Date(2024, 0, 1, i)) }));
    const rows = [head];
    const names = [h("div", { class: "sa-name sa-head", text: "" })];
    const allBusy = [];
    const rowOf = (cls, label, sub, blocks, unknown) => {
      const row = h("div", { class: "sa-row " + cls });
      for (let i = 0; i < 24; i++) {
        const work = this.day.getDay() > 0 && this.day.getDay() < 6 && i >= WORK_START && i < WORK_END;
        row.append(h("div", { class: "sa-cell" + (work ? " work" : ""), style: `left:${i * HOUR_W}px;width:${HOUR_W}px` }));
      }
      if (unknown) row.append(h("div", { class: "sa-block unknown", style: `left:0;width:${24 * HOUR_W}px`, title: "No information" }));
      for (const b of blocks) {
        row.append(h("div", { class: "sa-block " + b.type, "data-start": b.start, "data-end": b.end,
          style: `left:${x(b.start)}px;width:${Math.max(3, x(b.end) - x(b.start))}px`, title: `${b.type === "tentative" ? "Tentative" : b.type === "unavailable" ? "Out of Office" : "Busy"} ${fmt.time(new Date(b.start))} – ${fmt.time(new Date(b.end))}` }));
      }
      rows.push(row);
      names.push(h("div", { class: "sa-name " + cls, title: sub || label }, h("span", { class: "sa-label", text: label }), sub ? h("span", { class: "sa-sub", text: sub }) : ""));
      return row;
    };
    const per = people.map(p => {
      const busy = this.busyOf(p.email, dayStart, dayEnd);
      if (busy) allBusy.push(...busy);
      return { p, busy };
    });
    rowOf("all", "All Attendees", "", allBusy.map(b => Object.assign({}, b, { type: "busy" })), false);
    for (const { p, busy } of per) {
      const c = this.cache.get(p.email);
      const sub = p.organizer ? "Organizer" : this.loading && !c ? "Looking…" : c && c.known ? "" : "No information";
      rowOf("person" + (p.organizer ? " organizer" : ""), p.name, sub, busy || [], !busy && !this.loading).dataset.email = p.email;
    }
    // "Click here to add a name"
    const add = h("input", { type: "text", id: "sa-add", class: "sa-add", placeholder: "Click here to add a name", "aria-label": "Add a name" });
    add.addEventListener("keydown", e => {
      if (e.key === "Enter" && add.value.trim()) {
        this.host.addAttendee(add.value.trim());
        this.paintRows();
        this.load();
        setTimeout(() => this.el.querySelector("#sa-add")?.focus(), 0);
      }
    });
    names.push(h("div", { class: "sa-name sa-addrow" }, add));
    rows.push(h("div", { class: "sa-row sa-addrow" }));
    // the meeting over them
    const t = this.host.getTimes();
    if (t.end > dayStart && t.start < dayEnd) {
      rows.push(h("div", { class: "sa-meeting", id: "sa-meeting", style: `left:${x(t.start)}px;width:${Math.max(4, x(t.end) - x(t.start))}px` }));
    }
    this.timeline.replaceChildren(...rows);
    this.names.replaceChildren(...names);
  }

  // the next half hour from the meeting's start (on) where it fits in the
  // working day and everyone known is free
  async autoPick() {
    const t = this.host.getTimes();
    const len = t.end - t.start;
    let at = t.start + 30 * 60000;
    const limit = t.start + 14 * 86400000;
    const people = this.people();
    // two weeks of free/busy for everyone
    this.day = startOfDay(new Date(at));
    await this.load();
    const busy = people.map(p => this.busyOf(p.email, t.start, limit + len) || []).flat();
    while (at < limit) {
      const d = new Date(at);
      const dayStart = startOfDay(d);
      const minutes = (at - dayStart.getTime()) / 60000;
      const work = d.getDay() > 0 && d.getDay() < 6 && minutes >= WORK_START * 60 && minutes + len / 60000 <= WORK_END * 60;
      if (work && !busy.some(b => b.start < at + len && b.end > at)) {
        this.host.setTimes(at, at + len);
        if (!sameDay(dayStart, this.day)) {
          this.day = dayStart;
          await this.load();
        }
        this.paintRows();
        return true;
      }
      // the next half hour, or the next working morning
      if (d.getDay() === 0 || d.getDay() === 6 || minutes + len / 60000 > WORK_END * 60) at = addDays(dayStart, 1).getTime() + WORK_START * 3600000;
      else if (minutes < WORK_START * 60) at = dayStart.getTime() + WORK_START * 3600000;
      else at += 30 * 60000;
    }
    toast("No free time was found in the next two weeks.");
    return false;
  }

  dump() {
    const hm = ms => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    const dayStart = this.day.getTime(), dayEnd = addDays(this.day, 1).getTime();
    return {
      day: `${this.day.getFullYear()}-${this.day.getMonth() + 1}-${this.day.getDate()}`,
      rows: this.people().map(p => {
        const c = this.cache.get(p.email);
        const busy = this.busyOf(p.email, dayStart, dayEnd);
        return { email: p.email, organizer: !!p.organizer, known: !!(c && c.known), sources: c ? c.sources : [],
          busy: (busy || []).map(b => [hm(b.start), hm(b.end), b.type]) };
      }),
      drawn: [...this.timeline.querySelectorAll(".sa-row.person")].map(r => ({ email: r.dataset.email, blocks: r.querySelectorAll(".sa-block:not(.unknown)").length,
        unknown: !!r.querySelector(".sa-block.unknown") })),
      meeting: (() => {
        const t = this.host.getTimes();
        return [hm(t.start), hm(t.end), `${new Date(t.start).getMonth() + 1}-${new Date(t.start).getDate()}`];
      })(),
    };
  }
}
