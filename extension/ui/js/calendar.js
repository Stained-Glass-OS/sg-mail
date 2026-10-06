/*
 * SG Mail -- Calendar: Day, Work Week, Week and Month views, the date
 * navigator and the list of calendars (each in its colour, shown or not),
 * new appointments and meetings, reminders as desktop notifications, and
 * .ics import and export. The calendars and events are Thunderbird's
 * (its calendar manager, through the sgmail experiment): local calendars,
 * CalDAV and iCalendar subscriptions, whatever Thunderbird can reach.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, $$, esc, fmt, startOfDay, addDays, sameDay, startOfWeek, weekStartDay, showMenu, toast, dialog, confirmBox, debounce, testDump, searchAddressBooks, displayName } from "./util.js";

const SLOT_H = 24;              // half an hour
const WORK_START = 8, WORK_END = 17;

export class CalendarModule {
  constructor(app) {
    this.app = app;
    this.view = "workweek";
    this.date = startOfDay(new Date());
    this.calendars = [];
    this.hidden = new Set();
    this.events = [];
    this.selectedKey = null;
    this.selection = null;      // {start, end, allDay} of a picked slot
    this.side = $("#side-calendar");
    this.main = $("#module-calendar");
    this.refreshSoon = debounce(() => this.refresh(), 200);
  }

  async start() {
    const st = await messenger.storage.local.get(["calView", "calHidden"]).catch(() => ({}));
    if (st.calView) this.view = st.calView;
    this.hidden = new Set(st.calHidden || []);
    messenger.sgmail.onCalendarChanged.addListener(() => this.loadCalendars().then(() => this.refreshSoon()));
    messenger.sgmail.onAlarm.addListener(ev => this.onAlarm(ev));
    try {
      await messenger.sgmail.ensureCalendar();
    } catch (e) {
      console.error("sg-mail: calendar", e);
    }
    await this.loadCalendars();
    this.renderSide();
    // reminders: each minute, the events whose reminder time has come
    const st2 = await messenger.storage.local.get("remindedKeys").catch(() => ({}));
    this.reminded = new Set(st2.remindedKeys || []);
    this.reminderSince = Date.now();
    this.checkReminders();
    setInterval(() => this.checkReminders(), 15000);
  }

  async checkReminders() {
    const now = Date.now();
    let events = [];
    try {
      events = await messenger.sgmail.calendarItems(this.calendars.map(c => c.id), now - 3600000, now + 8 * 86400000);
    } catch (e) {
      return;
    }
    for (const ev of events) {
      if (ev.reminder < 0) continue;
      const at = ev.start - ev.reminder * 60000;
      // due now, and not one missed while SG Mail was closed long ago
      if (at <= now && at > this.reminderSince - 5 * 60000 && ev.end > now) this.onAlarm(ev);
    }
  }

  async loadCalendars() {
    try {
      this.calendars = (await messenger.sgmail.calendars()).filter(c => !c.disabled);
    } catch (e) {
      console.error("sg-mail: calendars", e);
      this.calendars = [];
    }
    if (!this.main.hidden) this.renderSide();
  }

  visibleIds() {
    return this.calendars.filter(c => !this.hidden.has(c.id)).map(c => c.id);
  }

  writableCalendars() {
    return this.calendars.filter(c => !c.readOnly);
  }

  defaultCalendar() {
    // one's own: another person's calendar (a delegate's) only when chosen
    const w = this.writableCalendars().filter(c => !c.shared);
    return w.find(c => !this.hidden.has(c.id)) || w[0] || null;
  }

  show() {
    this.renderSide();
    this.render();
    this.refresh();
  }

  // ---- the ribbon ----------------------------------------------------------------------------

  ribbon() {
    const viewBtn = (id, ic, label, key) => ({ id: "view-" + id, icon: ic, label, large: true, shortcut: key, action: () => this.setView(id) });
    return {
      tabs: [
        { id: "home", label: "Home", groups: [
          { label: "New", items: [
            { id: "new-appointment", icon: "appointment-new", label: "New Appointment", large: true, shortcut: "Ctrl+N", action: () => this.newEvent({}) },
            { id: "new-meeting", icon: "meeting-new", label: "New Meeting", large: true, shortcut: "Ctrl+Shift+Q", action: () => this.newEvent({ meeting: true }) },
            { id: "new-items", icon: "mail-new", label: "New Items", large: true, menu: () => [
              { label: "Appointment", icon: "appointment-new", action: () => this.newEvent({}) },
              { label: "All Day Event", icon: "calendar", action: () => this.newEvent({ allDay: true }) },
              { label: "Meeting", icon: "meeting-new", action: () => this.newEvent({ meeting: true }) },
              { separator: true },
              { label: "E-mail Message", icon: "mail-new", action: () => this.app.mail.compose({ mode: "new" }) },
            ] },
          ] },
          { label: "Go To", items: [
            { id: "today", icon: "today", label: "Today", large: true, shortcut: "Ctrl+T", action: () => this.today() },
            { id: "next7", icon: "view-week", label: "Next 7 Days", large: true, action: () => {
              this.date = startOfDay(new Date());
              this.setView("next7");
            } },
          ] },
          { label: "Arrange", items: [
            viewBtn("day", "view-day", "Day", "Ctrl+Alt+1"),
            viewBtn("workweek", "view-workweek", "Work Week", "Ctrl+Alt+2"),
            viewBtn("week", "view-week", "Week", "Ctrl+Alt+3"),
            viewBtn("month", "view-month", "Month", "Ctrl+Alt+4"),
          ] },
          { label: "Manage Calendars", items: [
            { id: "open-calendar", icon: "folder-open", label: "Open Calendar", large: true, menu: () => [
              { label: "Open Shared Calendar…", icon: "shared-calendar", action: () => this.openShared() },
              { label: "From Internet / Network (CalDAV, iCalendar)…", action: () => messenger.sgmail.openTool("newCalendar") },
              { label: "From File (.ics)…", action: () => this.importIcs() },
            ] },
            { col: [
              { id: "export-ics", icon: "export", label: "Export (.ics)", action: () => this.exportIcs() },
              { id: "calendar-settings", icon: "settings", label: "Calendar Settings", action: () => messenger.sgmail.openTool("options") },
            ] },
          ] },
          { label: "Send/Receive", items: [
            { id: "send-receive", icon: "sync", label: "Send/ Receive", title: "Send/Receive All Folders", large: true, shortcut: "F9", action: () => this.app.sendReceive() },
          ] },
        ] },
        { id: "view", label: "View", groups: [
          { label: "Arrangement", items: [
            viewBtn("day", "view-day", "Day", "Ctrl+Alt+1"),
            viewBtn("workweek", "view-workweek", "Work Week", "Ctrl+Alt+2"),
            viewBtn("week", "view-week", "Week", "Ctrl+Alt+3"),
            viewBtn("month", "view-month", "Month", "Ctrl+Alt+4"),
          ] },
        ] },
      ],
    };
  }

  markViewButtons() {
    if (!this.app.ribbon) return;
    for (const v of ["day", "workweek", "week", "month"]) this.app.ribbon.toggle("view-" + v, this.view === v);
  }

  setView(v) {
    this.view = v;
    messenger.storage.local.set({ calView: v }).catch(() => {});
    if (this.app.module !== "calendar") this.app.showModule("calendar");
    this.render();
    this.refresh();
  }

  today() {
    this.date = startOfDay(new Date());
    this.render();
    this.refresh();
  }

  step(dir) {
    if (this.view === "month") this.date = new Date(this.date.getFullYear(), this.date.getMonth() + dir, 1);
    else this.date = addDays(this.date, dir * (this.view === "day" ? 1 : 7));
    this.render();
    this.refresh();
  }

  // the days a view shows
  days() {
    if (this.view === "day") return [this.date];
    if (this.view === "next7") return [...Array(7)].map((_, i) => addDays(this.date, i));
    const ws = startOfWeek(this.date);
    if (this.view === "week") return [...Array(7)].map((_, i) => addDays(ws, i));
    if (this.view === "workweek") {
      // Monday to Friday of the week the date is in
      const monday = addDays(startOfDay(this.date), -((this.date.getDay() + 6) % 7));
      return [...Array(5)].map((_, i) => addDays(monday, i));
    }
    // month: six weeks from the week of the 1st
    const first = new Date(this.date.getFullYear(), this.date.getMonth(), 1);
    const start = startOfWeek(first);
    return [...Array(42)].map((_, i) => addDays(start, i));
  }

  range() {
    const d = this.days();
    return [d[0], addDays(d[d.length - 1], 1)];
  }

  title() {
    const d = this.days();
    if (this.view === "day") return fmt.longDate(d[0]);
    if (this.view === "month") return fmt.monthYear(this.date);
    const a = d[0], b = d[d.length - 1];
    if (a.getMonth() === b.getMonth()) return `${fmt.monthDay(a)} – ${fmt.dayNum(b)}, ${a.getFullYear()}`;
    return `${fmt.monthDay(a)} – ${fmt.monthDay(b)}, ${b.getFullYear()}`;
  }

  // ---- the side: date navigator and the calendars --------------------------------------------

  renderSide() {
    const side = h("div", { class: "cal-side" });
    side.append(this.miniMonth(this.navMonth || new Date(this.date.getFullYear(), this.date.getMonth(), 1)));
    const group = (title, list) => {
      if (!list.length) return;
      side.append(h("div", { class: "cal-list-head", html: `${icon("chevron-down", 12)} ${esc(title)}` }));
      for (const c of list) side.append(this.calendarRow(c));
    };
    group("My Calendars", this.calendars.filter(c => !c.shared));
    // other people's calendars opened here (Open Shared Calendar)
    group("Shared Calendars", this.calendars.filter(c => c.shared));
    if (!this.calendars.length) side.append(h("p", { style: "color:var(--muted);padding:6px", text: "No calendars." }));
    const add = h("button", { class: "btn link", style: "margin:8px 4px", html: `${icon("appointment-new", 14)} Add calendar…` });
    add.addEventListener("click", () => messenger.sgmail.openTool("newCalendar"));
    side.append(add);
    this.side.replaceChildren(side);
  }

  calendarRow(c) {
    const on = !this.hidden.has(c.id);
    const row = h("div", { class: "cal-item", "data-id": c.id, title: c.name + (c.readOnly ? " (read-only)" : "") + (c.shared ? `\n${c.shared}` : ""),
      html: `<span class="cal-check" style="border-color:${esc(c.color)};background:${on ? esc(c.color) : "transparent"};color:#fff">${on ? icon("accept", 12).replace(/#107c10/g, "#fff") : ""}</span>` +
        `<span class="cal-name">${esc(c.name)}</span><span class="cal-acct">${esc(c.shared ? (c.readOnly ? "Read" : "Edit") : c.type === "storage" ? "" : c.type === "caldav" ? "CalDAV" : c.type === "ics" ? "Internet" : c.type)}</span>` });
    row.addEventListener("click", () => this.toggleCalendar(c.id));
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      showMenu([
        { label: on ? "Hide Calendar" : "Show Calendar", action: () => this.toggleCalendar(c.id) },
        { label: "Export (.ics)…", icon: "export", action: () => this.exportIcs([c.id]) },
        { label: "Import into This Calendar…", icon: "import", disabled: c.readOnly, action: () => this.importIcs(c.id) },
        ...(c.shared ? [{ separator: true }, { label: "Remove Calendar", icon: "delete", action: () => this.removeShared(c) }] : []),
      ], { x: e.clientX, y: e.clientY });
    });
    return row;
  }

  // Open Shared Calendar: a colleague's calendar on the same calendar
  // server, by their name or address (what they let one see: read, or edit
  // as a delegate)
  async openShared() {
    const input = h("input", { type: "text", id: "shared-name", style: "flex:1", placeholder: "Name or e-mail address", autocomplete: "off" });
    const v = await dialog({
      title: "Open a Shared Calendar",
      body: h("div", {}, h("p", { text: "Whose calendar do you want to open?" }), h("div", { class: "form-row" }, h("label", { text: "Name:" }), input)),
      buttons: [{ label: "OK", primary: true, value: box => box.querySelector("#shared-name").value.trim() }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    // a name: the address from the address book
    let email = v, name = "";
    const m = v.match(/<([^>]+)>/);
    if (m) {
      email = m[1];
      name = v.replace(/<[^>]+>/, "").replace(/"/g, "").trim();
    } else if (!v.includes("@")) {
      try {
        const found = await searchAddressBooks(v);
        const card = found.find(n => /^EMAIL/mi.test(n.vCard || ""));
        if (card) {
          email = ((card.vCard.match(/^EMAIL[^:]*:(.*)$/mi) || [])[1] || "").trim();
          name = ((card.vCard.match(/^FN[^:]*:(.*)$/mi) || [])[1] || v).trim();
        }
      } catch (e) {
        // no address books
      }
    }
    if (!email.includes("@")) return dialog({ title: "Open a Shared Calendar", body: `<p>SG Mail does not know "${esc(v)}". Type their e-mail address.</p>` });
    this.app.setStatus(`Looking for ${email}'s calendar…`);
    let r;
    try {
      r = await messenger.sgmail.findSharedCalendars(email);
    } catch (e) {
      r = { calendars: [], error: e.message };
    }
    if (!r.calendars.length) {
      this.app.setStatus("");
      return dialog({ title: "Open a Shared Calendar", body: `<p id="shared-error">${esc(r.error || "No calendar was found.")}</p>` });
    }
    let chosen = r.calendars;
    if (r.calendars.length > 1) {
      const box = h("div", {}, h("p", { text: `${email} has shared these calendars with you:` }),
        r.calendars.map((c, i) => h("label", { class: "form-row", style: "gap:6px" }, h("input", { type: "checkbox", value: String(i), checked: i === 0 }), `${c.name}${c.writable ? " (can edit)" : ""}`)));
      const pick = await dialog({ title: "Open a Shared Calendar", body: box,
        buttons: [{ label: "Open", primary: true, value: b => [...b.querySelectorAll("input:checked")].map(i => Number(i.value)) }, { label: "Cancel", value: null, cancel: true }] });
      if (!pick || !pick.length) return;
      chosen = pick.map(i => r.calendars[i]);
    }
    const owner = name || displayName(email);
    const colors = ["#8764b8", "#038387", "#ca5010", "#498205", "#c239b3", "#986f0b"];
    for (const [i, c] of chosen.entries()) {
      try {
        await messenger.sgmail.openSharedCalendar({ url: c.url, name: `${owner} - ${c.name}`, color: c.color || colors[(this.calendars.length + i) % colors.length],
          owner: email, writable: c.writable, username: c.username });
      } catch (e) {
        toast("The calendar could not be opened: " + e.message);
      }
    }
    await this.loadCalendars();
    this.renderSide();
    this.refresh();
    this.app.setStatus(`${owner}'s calendar is open`);
  }

  async removeShared(c) {
    if (!(await confirmBox("SG Mail", `Remove "${c.name}" from your calendars? It stays as it is for its owner.`, "Remove", "Cancel"))) return;
    try {
      await messenger.sgmail.removeCalendar(c.id);
    } catch (e) {
      return toast("Could not remove it: " + e.message);
    }
    await this.loadCalendars();
    this.renderSide();
    this.refresh();
  }

  miniMonth(month) {
    const box = h("div", { class: "mini-month" });
    const head = h("div", { class: "mm-head" });
    const prev = h("button", { title: "Previous month", html: icon("chevron-left", 14) });
    const next = h("button", { title: "Next month", html: icon("chevron-right", 14) });
    prev.addEventListener("click", () => {
      this.navMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
      this.renderSide();
    });
    next.addEventListener("click", () => {
      this.navMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);
      this.renderSide();
    });
    head.append(prev, h("span", { text: fmt.monthYear(month) }), next);
    const grid = h("div", { class: "mm-grid" });
    const ws = weekStartDay();
    for (let i = 0; i < 7; i++) grid.append(h("div", { class: "mm-dow", text: fmt.weekdayNarrow(new Date(2024, 0, 7 + ((ws + i) % 7))) }));
    const start = startOfWeek(month);
    const [vs, ve] = this.range();
    const today = new Date();
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const cls = ["mm-day"];
      if (d.getMonth() !== month.getMonth()) cls.push("other");
      if (d >= vs && d < ve && this.view !== "month") cls.push("in-view");
      if (sameDay(d, today)) cls.push("today");
      const cell = h("div", { class: cls.join(" "), text: d.getDate(), title: fmt.longDate(d) });
      cell.addEventListener("click", () => {
        this.date = d;
        if (this.view === "month" && d.getMonth() !== this.date.getMonth()) this.date = d;
        this.render();
        this.refresh();
        this.renderSide();
      });
      grid.append(cell);
    }
    box.append(head, grid);
    return box;
  }

  async toggleCalendar(id) {
    if (this.hidden.has(id)) this.hidden.delete(id);
    else this.hidden.add(id);
    await messenger.storage.local.set({ calHidden: [...this.hidden] }).catch(() => {});
    this.renderSide();
    this.refresh();
  }

  // ---- the views ---------------------------------------------------------------------------------

  render() {
    this.cancelDraft();
    this.markViewButtons();
    const wrap = h("div", { class: "cal-main" });
    const head = h("div", { class: "cal-head" });
    const nav = h("div", { class: "nav" });
    const prev = h("button", { id: "cal-prev", title: "Back", html: icon("chevron-left", 18) });
    const next = h("button", { id: "cal-next", title: "Forward", html: icon("chevron-right", 18) });
    prev.addEventListener("click", () => this.step(-1));
    next.addEventListener("click", () => this.step(1));
    nav.append(prev, next);
    const todayBtn = h("button", { class: "btn small", text: "Today" });
    todayBtn.addEventListener("click", () => this.today());
    head.append(todayBtn, nav, h("span", { class: "cal-title", id: "cal-title", text: this.title() }), h("span", { class: "spacer" }));
    this.body = h("div", { class: "cal-body" });
    wrap.append(head, this.body);
    this.main.replaceChildren(wrap);
    if (this.view === "month") this.renderMonth();
    else this.renderGrid();
    this.app.setTitle("Calendar");
  }

  renderGrid() {
    const days = this.days();
    const cols = `56px repeat(${days.length}, 1fr)`;
    const tg = h("div", { class: "tg" });
    const dayHead = h("div", { class: "tg-days", style: `grid-template-columns:${cols}` });
    dayHead.append(h("div", { class: "tg-gutter-head" }));
    const today = new Date();
    for (const d of days) {
      dayHead.append(h("div", { class: "tg-dayhead" + (sameDay(d, today) ? " today" : ""),
        html: `<span class="num">${d.getDate()}</span><span class="dow">${esc(fmt.weekdayLong(d))}</span>` }));
    }
    this.allDayRow = h("div", { class: "tg-allday", style: `grid-template-columns:${cols}` });
    this.allDayRow.append(h("div", { class: "tg-gutter-head", text: "" }));
    this.allCells = days.map(d => {
      const c = h("div", { class: "tg-allcell", "data-day": d.getTime() });
      c.addEventListener("mousedown", e => {
        if (e.target !== c || e.button !== 0) return;
        this.selectDays(e, d, () => this.allCells.map((el, i) => ({ day: days[i], el })));
      });
      c.addEventListener("dblclick", e => {
        if (e.target === c) this.newEvent({ start: d.getTime(), end: addDays(d, 1).getTime(), allDay: true });
      });
      this.allDayRow.append(c);
      return c;
    });
    const scroll = h("div", { class: "tg-scroll", id: "cal-scroll" });
    const grid = h("div", { class: "tg-grid", style: `grid-template-columns:${cols}` });
    const hours = h("div", { class: "tg-hours" });
    for (let i = 0; i < 24; i++) hours.append(h("div", { class: "tg-hour", text: i ? fmt.hour(new Date(2024, 0, 1, i)) : "" }));
    grid.append(hours);
    this.cols = days.map(d => {
      const col = h("div", { class: "tg-col", "data-day": d.getTime() });
      for (let s = 0; s < 48; s++) {
        const hour = s / 2;
        const work = d.getDay() > 0 && d.getDay() < 6 && hour >= WORK_START && hour < WORK_END;
        const slot = h("div", { class: "tg-slot " + (work ? "work" : "off"), "data-slot": s });
        col.append(slot);
      }
      this.wireColumn(col, d);
      grid.append(col);
      return { day: d, el: col };
    });
    scroll.append(grid);
    tg.append(dayHead, this.allDayRow, scroll);
    this.body.replaceChildren(tg);
    // the working day in view
    scroll.scrollTop = (WORK_START - 0.5) * 2 * SLOT_H;
    this.paintNow();
  }

  paintNow() {
    clearInterval(this.nowTimer);
    const paint = () => {
      for (const n of this.main.querySelectorAll(".tg-now")) n.remove();
      const now = new Date();
      const c = (this.cols || []).find(x => sameDay(x.day, now));
      if (!c) return;
      const y = (now.getHours() * 60 + now.getMinutes()) / 30 * SLOT_H;
      c.el.append(h("div", { class: "tg-now", style: `top:${y}px` }));
    };
    paint();
    this.nowTimer = setInterval(paint, 60000);
  }

  wireColumn(col, day) {
    let dragFrom = null;
    const slotAt = e => {
      const r = col.getBoundingClientRect();
      return Math.max(0, Math.min(47, Math.floor((e.clientY - r.top) / SLOT_H)));
    };
    const paintSel = (a, b) => {
      this.cancelDraft();
      for (const s of this.main.querySelectorAll(".tg-slot.sel, .tg-allcell.sel")) s.classList.remove("sel");
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (const s of col.querySelectorAll(".tg-slot")) if (+s.dataset.slot >= lo && +s.dataset.slot <= hi) s.classList.add("sel");
      const start = new Date(day);
      start.setMinutes(lo * 30);
      const end = new Date(day);
      end.setMinutes((hi + 1) * 30);
      this.selection = { start: start.getTime(), end: end.getTime(), allDay: false };
    };
    col.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest(".ev, .ev-draft")) return;
      dragFrom = slotAt(e);
      paintSel(dragFrom, dragFrom);
      this.selectEvent(null);
      const move = ev => paintSel(dragFrom, slotAt(ev));
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
    col.addEventListener("dblclick", e => {
      if (e.target.closest(".ev")) return;
      const s = slotAt(e);
      if (!this.selection || this.selection.start > day.getTime() + s * 30 * 60000 || this.selection.end <= day.getTime() + s * 30 * 60000) paintSel(s, s);
      this.newEvent(Object.assign({}, this.selection));
    });
    col.addEventListener("contextmenu", e => {
      if (e.target.closest(".ev")) return;
      e.preventDefault();
      const s = slotAt(e);
      if (!this.selection) paintSel(s, s);
      showMenu([
        { label: "New Appointment", icon: "appointment-new", action: () => this.newEvent(Object.assign({}, this.selection)) },
        { label: "New All Day Event", icon: "calendar", action: () => this.newEvent({ start: day.getTime(), end: addDays(day, 1).getTime(), allDay: true }) },
        { label: "New Meeting Request", icon: "meeting-new", action: () => this.newEvent(Object.assign({ meeting: true }, this.selection)) },
        { separator: true },
        { label: "Today", icon: "today", action: () => this.today() },
      ], { x: e.clientX, y: e.clientY });
    });
  }

  renderMonth() {
    const days = this.days();
    const mg = h("div", { class: "mg" });
    const dows = h("div", { class: "mg-dows" });
    for (let i = 0; i < 7; i++) dows.append(h("div", { text: fmt.weekdayLong(days[i]) }));
    const weeks = h("div", { class: "mg-weeks" });
    const today = new Date();
    this.monthCells = [];
    for (let w = 0; w < 6; w++) {
      const row = h("div", { class: "mg-week" });
      for (let i = 0; i < 7; i++) {
        const d = days[w * 7 + i];
        const cell = h("div", { class: "mg-day" + (d.getMonth() !== this.date.getMonth() ? " other" : "") + (sameDay(d, today) ? " today" : ""), "data-day": d.getTime() });
        cell.append(h("div", { class: "mg-num", text: d.getDate() === 1 ? fmt.monthDay(d) : d.getDate() }));
        cell.addEventListener("mousedown", e => {
          if (e.target.closest(".mg-ev, .ev-draft") || e.button !== 0) return;
          this.selectDays(e, d, () => this.monthCells);
        });
        cell.addEventListener("dblclick", e => {
          if (e.target.closest(".mg-ev")) return;
          this.newEvent({ start: d.getTime(), end: addDays(d, 1).getTime(), allDay: true });
        });
        row.append(cell);
        this.monthCells.push({ day: d, el: cell });
      }
      weeks.append(row);
    }
    mg.append(dows, weeks);
    this.body.replaceChildren(mg);
  }

  async refresh() {
    if (this.main.hidden || !this.body) return;
    const [start, end] = this.range();
    const token = (this.loadToken = Symbol("load"));
    let events = [];
    try {
      events = await messenger.sgmail.calendarItems(this.visibleIds(), start.getTime(), end.getTime());
    } catch (e) {
      console.error("sg-mail: events", e);
    }
    if (this.loadToken !== token) return;
    this.events = events;
    this.app.setStatus(`Items: ${events.length}`);
    if (this.view === "month") this.placeMonth();
    else this.placeGrid();
    this.dump();
  }

  key(ev) {
    return `${ev.calendarId}|${ev.id}|${ev.occurrence || ""}`;
  }

  eventEl(ev, cls, style, html = "") {
    const el = h("div", {
      html,
      class: cls + (ev.myStatus === "TENTATIVE" || ev.myStatus === "NEEDS-ACTION" ? " tentative" : "") + (this.selectedKey === this.key(ev) ? " selected" : ""),
      style: `--ev-color:${ev.color};${style || ""}`,
      title: `${ev.title}${ev.location ? "\n" + ev.location : ""}\n${ev.allDay ? "All day" : fmt.time(new Date(ev.start)) + " – " + fmt.time(new Date(ev.end))}`,
      "data-key": this.key(ev),
    });
    if (!ev.readOnly) {
      // the edges to drag: top and bottom in the day grid, the right end of
      // an all-day or month item
      const edges = cls === "ev" ? ["start", "end"] : ["end"];
      for (const edge of edges) el.append(h("div", { class: `ev-handle ${edge}`, "data-edge": edge }));
    }
    el.addEventListener("mousedown", e => {
      e.stopPropagation();
      this.selectEvent(ev);
      if (e.button === 0 && !ev.readOnly) {
        const handle = e.target.closest(".ev-handle");
        this.beginDrag(e, ev, el, handle ? handle.dataset.edge : "move", cls === "ev" ? "grid" : cls === "mg-ev" ? "month" : "allday");
      }
    });
    el.addEventListener("dblclick", e => {
      e.stopPropagation();
      this.openEvent(ev);
    });
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      e.stopPropagation();
      this.selectEvent(ev);
      showMenu([
        { label: "Open", action: () => this.openEvent(ev) },
        { separator: true },
        { label: "Delete", icon: "delete", disabled: ev.readOnly, action: () => this.deleteEvent(ev) },
      ], { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  placeGrid() {
    for (const el of this.main.querySelectorAll(".ev")) el.remove();
    for (const c of this.cols) {
      const dayStart = c.day.getTime(), dayEnd = addDays(c.day, 1).getTime();
      const timed = this.events.filter(e => !e.allDay && e.start < dayEnd && e.end > dayStart)
        .map(e => ({ ev: e, s: Math.max(e.start, dayStart), e: Math.min(Math.max(e.end, e.start + 15 * 60000), dayEnd) }));
      // overlapping events side by side
      timed.sort((a, b) => a.s - b.s || b.e - a.e);
      let cluster = [], clusterEnd = 0;
      const flush = () => {
        const columns = [];
        for (const t of cluster) {
          let i = columns.findIndex(end => end <= t.s);
          if (i < 0) {
            i = columns.length;
            columns.push(0);
          }
          columns[i] = t.e;
          t.col = i;
        }
        for (const t of cluster) t.cols = columns.length;
        cluster = [];
      };
      for (const t of timed) {
        if (cluster.length && t.s >= clusterEnd) flush();
        cluster.push(t);
        clusterEnd = Math.max(clusterEnd, t.e);
      }
      flush();
      for (const t of timed) {
        const top = (t.s - dayStart) / 60000 / 30 * SLOT_H;
        const height = Math.max(SLOT_H - 2, (t.e - t.s) / 60000 / 30 * SLOT_H - 2);
        const w = 100 / t.cols;
        const el = this.eventEl(t.ev, "ev", `top:${top}px;height:${height}px;left:calc(${t.col * w}% + 1px);width:calc(${w}% - 4px)`,
          `<div class="ev-title">${esc(t.ev.title || "(No title)")}</div>` +
          (t.ev.location ? `<div class="ev-sub">${esc(t.ev.location)}</div>` : "") +
          (t.ev.recurring ? `<div class="ev-sub">${icon("repeat", 11)}</div>` : ""));
        c.el.append(el);
      }
    }
    for (let i = 0; i < this.cols.length; i++) {
      const d = this.cols[i].day, dEnd = addDays(d, 1).getTime();
      const cell = this.allCells[i];
      for (const ev of this.events.filter(e => e.allDay && e.start < dEnd && e.end > d.getTime())) {
        const el = this.eventEl(ev, "ev allday", "", `<span class="ev-title">${esc(ev.title || "(No title)")}</span>`);
        cell.append(el);
      }
    }
  }

  placeMonth() {
    for (const el of this.main.querySelectorAll(".mg-ev, .mg-more")) el.remove();
    for (const c of this.monthCells) {
      const dEnd = addDays(c.day, 1).getTime();
      const list = this.events.filter(e => e.start < dEnd && e.end > c.day.getTime());
      list.sort((a, b) => (b.allDay - a.allDay) || a.start - b.start);
      const max = Math.max(1, Math.floor((c.el.clientHeight - 20) / 19));
      for (const ev of list.slice(0, max)) {
        const el = this.eventEl(ev, "mg-ev", "", esc((ev.allDay ? "" : fmt.time(new Date(ev.start)) + " ") + (ev.title || "(No title)")));
        c.el.append(el);
      }
      if (list.length > max) {
        const more = h("div", { class: "mg-more", text: `${list.length - max} more…` });
        more.addEventListener("click", () => {
          this.date = c.day;
          this.setView("day");
        });
        c.el.append(more);
      }
    }
  }

  selectEvent(ev) {
    this.selectedKey = ev ? this.key(ev) : null;
    this.selectedEvent = ev;
    for (const el of this.main.querySelectorAll("[data-key]")) el.classList.toggle("selected", el.dataset.key === this.selectedKey);
    if (ev) {
      for (const s of this.main.querySelectorAll(".tg-slot.sel, .tg-allcell.sel, .mg-day.sel")) s.classList.remove("sel");
      this.selection = null;
    }
  }

  // ---- drag: days picked in the month or the all-day row -----------------------------------------

  selectDays(e, day, cells) {
    this.cancelDraft();
    this.selectEvent(null);
    const paint = (a, b) => {
      const lo = Math.min(a.getTime(), b.getTime()), hi = Math.max(a.getTime(), b.getTime());
      for (const s of this.main.querySelectorAll(".tg-slot.sel, .tg-allcell.sel, .mg-day.sel")) s.classList.remove("sel");
      for (const c of cells()) if (c.day.getTime() >= lo && c.day.getTime() <= hi) c.el.classList.add("sel");
      this.selection = { start: lo, end: addDays(new Date(hi), 1).getTime(), allDay: true };
    };
    paint(day, day);
    const move = m => {
      const c = this.cellAt(cells(), m.clientX, m.clientY);
      if (c) paint(day, c.day);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  // the day cell (or grid column) under a point: by the cells' boxes, the
  // nearest in each direction when outside them
  cellAt(cells, x, y) {
    let best = null, bestD = Infinity;
    for (const c of cells) {
      const r = c.el.getBoundingClientRect();
      const dx = x < r.left ? r.left - x : x >= r.right ? x - r.right + 1 : 0;
      const dy = y === null ? 0 : y < r.top ? r.top - y : y >= r.bottom ? y - r.bottom + 1 : 0;
      const d = dx + dy;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  // ---- drag: an event moved, or made longer or shorter --------------------------------------------

  beginDrag(e, ev, el, edge, kind) {
    const x0 = e.clientX, y0 = e.clientY;
    const cells = () => kind === "grid" ? this.cols : kind === "month" ? this.monthCells : this.allCells.map((c, i) => ({ day: this.cols[i].day, el: c }));
    const from = this.cellAt(cells(), x0, kind === "month" ? y0 : null);
    if (!from) return;
    let active = false, change = null;
    const finish = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("keydown", key, true);
      this.paintDrag(null);
      el.classList.remove("dragging");
    };
    const move = m => {
      if (!active) {
        if (Math.abs(m.clientX - x0) + Math.abs(m.clientY - y0) < 5) return;
        active = true;
        el.classList.add("dragging");
      }
      const to = this.cellAt(cells(), m.clientX, kind === "month" ? m.clientY : null);
      const days = Math.round((to.day - from.day) / 86400000);
      // the day grid: quarter hours by the pointer's height
      const minutes = kind === "grid" ? Math.round((m.clientY - y0) / (SLOT_H / 2)) * 15 : 0;
      change = this.dragged(ev, edge, days, minutes);
      this.paintDrag(change, kind);
      m.preventDefault();
    };
    const up = m => {
      finish();
      if (active && change && (change.start !== ev.start || change.end !== ev.end)) this.commitChange(ev, change);
    };
    const key = k => {
      if (k.key === "Escape") {
        k.preventDefault();
        k.stopPropagation();
        change = null;
        finish();
      }
    };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
    document.addEventListener("keydown", key, true);
  }

  // the times an event would have: moved by days and minutes, or one of its
  // ends moved (never shorter than a quarter hour, or a day when all day)
  dragged(ev, edge, days, minutes) {
    const shift = (ms, d, min) => {
      const x = new Date(ms);
      x.setDate(x.getDate() + d);
      return x.getTime() + min * 60000;
    };
    const least = ev.allDay ? 86400000 : 15 * 60000;
    let start = ev.start, end = ev.end;
    if (edge === "move") {
      start = shift(ev.start, days, minutes);
      end = start + (ev.end - ev.start);
    } else if (edge === "end") {
      end = Math.max(start + least, shift(ev.end, days, minutes));
    } else {
      start = Math.min(end - least, shift(ev.start, days, minutes));
    }
    return { start, end, origStart: ev.start };
  }

  paintDrag(change, kind) {
    for (const g of this.main.querySelectorAll(".ev-ghost")) g.remove();
    for (const c of this.main.querySelectorAll(".drop")) c.classList.remove("drop");
    if (!change) return;
    if (kind === "grid") {
      for (const c of this.cols) {
        const ds = c.day.getTime(), de = addDays(c.day, 1).getTime();
        if (change.start >= de || change.end <= ds) continue;
        const s = Math.max(change.start, ds), e = Math.min(change.end, de);
        c.el.append(h("div", { class: "ev-ghost", style: `top:${(s - ds) / 60000 / 30 * SLOT_H}px;height:${Math.max(6, (e - s) / 60000 / 30 * SLOT_H - 2)}px`,
          text: `${fmt.time(new Date(change.start))} – ${fmt.time(new Date(change.end))}` }));
      }
      return;
    }
    const cells = kind === "month" ? this.monthCells : this.allCells.map((c, i) => ({ day: this.cols[i].day, el: c }));
    for (const c of cells) {
      const ds = c.day.getTime(), de = addDays(c.day, 1).getTime();
      if (change.start < de && change.end > ds) c.el.classList.add("drop");
    }
  }

  // the dropped times saved: for an occurrence, this one or the series (as
  // Outlook asks); for a meeting of one's own, an update to the attendees
  async commitChange(ev, change) {
    let series = false;
    if (ev.recurring && ev.occurrence) {
      const v = await dialog({
        title: "Change Repeating Item",
        body: `<p>"${esc(ev.title)}" is a recurring appointment. Do you want to change just this one, or the entire series?</p>`,
        buttons: [{ label: "Just this one", value: "one", primary: true }, { label: "The entire series", value: "series" }, { label: "Cancel", value: null, cancel: true }],
      });
      if (!v) return;
      series = v === "series";
    }
    let send = false;
    if (ev.attendees.length && ev.iAmOrganizer) {
      const v = await dialog({
        title: "Send Update",
        body: `<p>"${esc(ev.title)}" is a meeting. Send an update with the new time to the attendees?</p>`,
        buttons: [{ label: "Send Update", value: "send", primary: true }, { label: "Don't Send", value: "no" }, { label: "Cancel", value: null, cancel: true }],
      });
      if (!v) return;
      send = v === "send";
    }
    // drawn where it was dropped while it is saved
    const was = { start: ev.start, end: ev.end };
    Object.assign(ev, { start: change.start, end: change.end });
    if (this.view === "month") this.placeMonth();
    else this.placeGrid();
    try {
      await messenger.sgmail.moveEvent(ev.calendarId, ev.id, ev.occurrence || null, change, { series, sendInvitations: send });
      this.app.setStatus(`"${ev.title}" moved to ${ev.allDay ? fmt.longDate(new Date(change.start)) : fmt.shortDayTime(new Date(change.start))}`);
    } catch (e) {
      Object.assign(ev, was);
      toast("Could not change it: " + e.message);
    }
    this.refresh();
  }

  // ---- typing on picked time: a new appointment in place ----------------------------------------

  quickCreate(first = "") {
    const sel = this.selection;
    if (!sel || !this.defaultCalendar()) return false;
    this.cancelDraft();
    let host, style = "";
    if (sel.allDay) {
      const cells = this.view === "month" ? this.monthCells : (this.allCells || []).map((c, i) => ({ day: this.cols[i].day, el: c }));
      host = (cells.find(c => c.day.getTime() === sel.start) || {}).el;
    } else {
      const day = startOfDay(new Date(sel.start));
      const c = (this.cols || []).find(x => sameDay(x.day, day));
      host = c && c.el;
      style = `top:${(sel.start - day.getTime()) / 60000 / 30 * SLOT_H}px;height:${Math.max(SLOT_H - 2, (sel.end - sel.start) / 60000 / 30 * SLOT_H - 2)}px`;
    }
    if (!host) return false;
    const input = h("input", { type: "text", class: "ev-input", "aria-label": "Subject", autocomplete: "off" });
    const draft = h("div", { class: "ev-draft" + (sel.allDay ? " allday" : ""), style }, input);
    host.append(draft);
    input.value = first;
    input.focus();
    let done = false;
    const save = async () => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      draft.remove();
      this.draft = null;
      if (!title) return;
      const cal = this.defaultCalendar();
      try {
        await messenger.sgmail.saveEvent({ calendarId: cal.id, title, location: "", description: "", start: sel.start, end: sel.end, allDay: !!sel.allDay,
          attendees: [], reminder: sel.allDay ? 1080 : 15, showAs: sel.allDay ? "free" : "busy", recurrence: null }, {});
      } catch (e) {
        toast("Could not save it: " + e.message);
      }
      this.refresh();
    };
    // clicking elsewhere keeps what was typed, as Outlook; Escape drops it
    this.draft = { el: draft, sel, save };
    input.addEventListener("keydown", k => {
      if (k.key === "Enter") {
        k.preventDefault();
        save();
      } else if (k.key === "Escape") {
        k.preventDefault();
        k.stopPropagation();
        done = true;
        draft.remove();
        this.draft = null;
      }
    });
    input.addEventListener("blur", () => save());
    return true;
  }

  cancelDraft() {
    if (this.draft) this.draft.save();
  }

  // ---- events ----------------------------------------------------------------------------------------

  newEvent({ start, end, allDay, meeting, attendees } = {}) {
    if (!this.writableCalendars().length) {
      toast("There is no calendar to put it in: add one first (Open Calendar).");
      return;
    }
    if (!start) {
      const now = new Date();
      const base = this.selection && this.app.module === "calendar" ? new Date(this.selection.start) : new Date(Math.max(this.date.getTime(), startOfDay(now).getTime()));
      if (!this.selection || this.app.module !== "calendar") {
        // the next half hour of today, or 8:00 of another day
        if (sameDay(base, now)) base.setHours(now.getHours(), now.getMinutes() < 30 ? 30 : 60, 0, 0);
        else base.setHours(WORK_START, 0, 0, 0);
      }
      start = base.getTime();
      end = this.selection && this.app.module === "calendar" ? this.selection.end : start + 30 * 60000;
      allDay = allDay || (this.selection && this.app.module === "calendar" && this.selection.allDay);
    }
    const q = new URLSearchParams({ start: String(start), end: String(end || start + 30 * 60000), calendarId: (this.defaultCalendar() || {}).id || "" });
    if (allDay) q.set("allDay", "1");
    if (meeting) q.set("meeting", "1");
    if (attendees) q.set("attendees", attendees);
    return this.openWindow(q);
  }

  openEvent(ev) {
    const q = new URLSearchParams({ calendarId: ev.calendarId, id: ev.id });
    if (ev.occurrence) q.set("occurrence", String(ev.occurrence));
    return this.openWindow(q);
  }

  openWindow(q) {
    return messenger.windows.create({ type: "popup", url: messenger.runtime.getURL("ui/event.html?" + q.toString()), width: 900, height: 700, allowScriptsToClose: true });
  }

  async deleteEvent(ev) {
    if (ev.readOnly) return;
    let series = false;
    if (ev.recurring && ev.occurrence) {
      const v = await dialog({
        title: "Delete Repeating Item",
        body: `<p>"${esc(ev.title)}" is a recurring appointment. Do you want to delete only this occurrence or the series?</p>`,
        buttons: [{ label: "Delete this occurrence", value: "one", primary: true }, { label: "Delete the series", value: "series" }, { label: "Cancel", value: null, cancel: true }],
      });
      if (!v) return;
      series = v === "series";
    }
    try {
      await messenger.sgmail.deleteEvent(ev.calendarId, ev.id, ev.occurrence || null, { series, sendCancellations: ev.iAmOrganizer && ev.attendees.length > 0 });
      this.selectEvent(null);
      this.refresh();
    } catch (e) {
      toast("Could not delete: " + e.message);
    }
  }

  deleteSelected() {
    if (this.selectedEvent) this.deleteEvent(this.selectedEvent);
  }

  onAlarm(ev) {
    const key = this.key(ev) + "|" + ev.start;
    if (this.reminded && this.reminded.has(key)) return;
    if (this.reminded) {
      this.reminded.add(key);
      messenger.storage.local.set({ remindedKeys: [...this.reminded].slice(-500) }).catch(() => {});
    }
    const when = ev.allDay ? "Today" : `${fmt.time(new Date(ev.start))} – ${fmt.time(new Date(ev.end))}`;
    const id = "sgmail-alarm-" + ev.calendarId + "-" + ev.id + "-" + (ev.occurrence || "");
    this.alarmEvents = this.alarmEvents || new Map();
    this.alarmEvents.set(id, ev);
    messenger.notifications.create(id, {
      type: "basic",
      title: ev.title || "Reminder",
      message: when + (ev.location ? "\n" + ev.location : ""),
      iconUrl: browser.runtime.getURL("icons/sg-mail.svg"),
    }).catch(e => console.error(e));
    this.app.notifications.push({ kind: "reminder", title: ev.title, message: when });
    this.dump();
    if (!this.alarmListener) {
      this.alarmListener = true;
      messenger.notifications.onClicked.addListener(nid => {
        const e = this.alarmEvents.get(nid);
        if (e) {
          this.app.focusWindow();
          this.openEvent(e);
        }
      });
    }
  }

  // ---- .ics ----------------------------------------------------------------------------------------------

  importIcs(calendarId) {
    const input = h("input", { type: "file", accept: ".ics,text/calendar", style: "display:none" });
    input.addEventListener("change", async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return;
      const text = await file.text();
      let target = calendarId;
      if (!target) {
        const cals = this.writableCalendars();
        if (!cals.length) return toast("There is no calendar to import into.");
        const sel = h("select", { id: "imp-cal", style: "flex:1" }, cals.map(c => h("option", { value: c.id, text: c.name })));
        target = await dialog({
          title: "Import Calendar",
          body: h("div", {}, h("p", { text: `Import the events of "${file.name}" into:` }), h("div", { class: "form-row" }, sel)),
          buttons: [{ label: "Import", primary: true, value: box => box.querySelector("#imp-cal").value }, { label: "Cancel", value: null, cancel: true }],
        });
        if (!target) return;
      }
      try {
        const n = await messenger.sgmail.calendarImport(target, text);
        toast(`${n} event${n === 1 ? "" : "s"} imported`);
        this.refresh();
      } catch (e) {
        toast("The file could not be imported: " + e.message);
      }
    });
    document.body.append(input);
    input.click();
  }

  async exportIcs(ids) {
    try {
      const ics = await messenger.sgmail.calendarExport(ids || this.visibleIds());
      const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
      const a = h("a", { href: url, download: "calendar.ics" });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      toast("The calendar could not be exported: " + e.message);
    }
  }

  dump() {
    const data = {
      view: this.view,
      title: this.main.querySelector("#cal-title")?.textContent || "",
      calendars: this.calendars.map(c => ({ name: c.name, type: c.type, shown: !this.hidden.has(c.id), readOnly: c.readOnly, shared: c.shared })),
      groups: [...this.side.querySelectorAll(".cal-list-head")].map(e => e.textContent.trim()),
      events: this.events.map(e => ({ title: e.title, start: e.start, end: e.end, allDay: e.allDay, calendar: e.calendarName, recurring: e.recurring,
        location: e.location, attendees: e.attendees.map(a => a.email + ":" + a.status), myStatus: e.myStatus })),
      drawn: [...this.main.querySelectorAll("[data-key]")].map(el => el.textContent.trim()).slice(0, 200),
      notifications: this.app.notifications,
    };
    testDump("calendar.json", data);
    return data;
  }
}
