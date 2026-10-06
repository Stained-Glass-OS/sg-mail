/*
 * SG Mail -- Tasks: the To-Do List (tasks and flagged mail, by when they
 * are due) and the task lists of each calendar, the task's details, new and
 * edited tasks, Mark Complete, Follow Up (Today, Tomorrow, This Week, Next
 * Week, No Date); and the To-Do Bar beside the mail. Tasks are Thunderbird's
 * calendar tasks (iCalendar VTODO: on a CalDAV server with the calendar, or
 * on this computer); flagged mail is Thunderbird's flag (an IMAP \Flagged
 * on the server), its due day kept by SG Mail on this computer.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, esc, fmt, startOfDay, addDays, sameDay, startOfWeek, showMenu, toast, dialog, confirmBox, debounce, testDump, displayName } from "./util.js";
import { roleOf } from "./folders.js";

const STATUS = [["NEEDS-ACTION", "Not Started"], ["IN-PROCESS", "In Progress"], ["COMPLETED", "Completed"], ["WAITING", "Waiting on someone else"], ["DEFERRED", "Deferred"]];
const PRIORITY = [[9, "Low"], [0, "Normal"], [1, "High"]];

const pad = n => String(n).padStart(2, "0");
const dateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const readDateValue = v => {
  if (!v) return null;
  const [y, m, d] = v.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
};

// Outlook's follow-up days: Today, Tomorrow, This Week (its last working
// day, or tomorrow when that is past), Next Week (its Friday), No Date
export function followUpDay(when, now = new Date()) {
  const today = startOfDay(now);
  if (when === "today") return today.getTime();
  if (when === "tomorrow") return addDays(today, 1).getTime();
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  if (when === "thisweek") {
    const friday = addDays(monday, 4);
    return (friday >= today ? friday : today).getTime();
  }
  if (when === "nextweek") return addDays(monday, 11).getTime();
  return null;
}

// the To-Do List's groups by the due day
function dueGroup(due, completed, now = new Date()) {
  if (completed) return { key: "done", label: "Completed", order: 9 };
  if (!due) return { key: "nodate", label: "No Date", order: 7 };
  const today = startOfDay(now), d = startOfDay(new Date(due));
  if (d < today) return { key: "overdue", label: "Overdue", order: 0 };
  if (sameDay(d, today)) return { key: "today", label: "Today", order: 1 };
  if (sameDay(d, addDays(today, 1))) return { key: "tomorrow", label: "Tomorrow", order: 2 };
  const week = startOfWeek(today);
  if (d < addDays(week, 7)) return { key: "thisweek", label: "This Week", order: 3 };
  if (d < addDays(week, 14)) return { key: "nextweek", label: "Next Week", order: 4 };
  return { key: "later", label: "Later", order: 5 };
}

export class TasksModule {
  constructor(app) {
    this.app = app;
    this.side = $("#side-tasks");
    this.main = $("#module-tasks");
    this.scope = "todo";              // "todo" or "cal:ID"
    this.filter = "active";           // active, all, completed, overdue, today
    this.tasks = [];
    this.flagged = [];
    this.flagDue = {};                // flagged mail's due days: Message-ID -> ms
    this.selected = null;             // "t:calendarId|id" or "m:messageId"
    this.todoBar = false;
    this.loadSoon = debounce(() => this.load(), 300);
  }

  async start() {
    const st = await messenger.storage.local.get(["flagDue", "todoBar", "taskFilter"]).catch(() => ({}));
    this.flagDue = st.flagDue || {};
    this.filter = st.taskFilter || "active";
    messenger.sgmail.onCalendarChanged.addListener(() => this.loadSoon());
    messenger.messages.onUpdated.addListener((m, changed) => {
      if (changed && "flagged" in changed) this.loadSoon();
    });
    this.setTodoBar(!!st.todoBar, false);
  }

  show() {
    this.renderFrame();
    this.app.setTitle(this.scope === "todo" ? "To-Do List" : "Tasks");
    this.load();
  }

  shown() {
    return !this.main.hidden;
  }

  // ---- the ribbon -------------------------------------------------------------------------------

  ribbon() {
    const fu = (id, label, when) => ({ id: "fu-" + id, icon: "flag", label, action: () => this.followUp(when) });
    const view = (id, label) => ({ label, checked: this.filter === id, action: () => this.setFilter(id) });
    return {
      tabs: [
        { id: "home", label: "Home", groups: [
          { label: "New", items: [
            { id: "new-task", icon: "task-new", label: "New Task", large: true, shortcut: "Ctrl+N", action: () => this.editTask(null) },
            { id: "new-email", icon: "mail-new", label: "New Email", large: true, action: () => this.app.mail.compose({ mode: "new" }) },
          ] },
          { label: "Delete", items: [
            { id: "delete-task", icon: "delete", label: "Delete", large: true, shortcut: "Delete", action: () => this.deleteSelected() },
          ] },
          { label: "Manage Task", items: [
            { id: "mark-complete", icon: "tasks", label: "Mark Complete", large: true, action: () => this.markComplete(this.selectedItem()) },
            { id: "remove-from-list", icon: "flag-done", label: "Remove from List", large: true, action: () => this.removeFromList(this.selectedItem()) },
          ] },
          { label: "Follow Up", items: [
            { col: [fu("today", "Today", "today"), fu("tomorrow", "Tomorrow", "tomorrow"), fu("thisweek", "This Week", "thisweek")] },
            { col: [fu("nextweek", "Next Week", "nextweek"), fu("nodate", "No Date", null)] },
          ] },
          { label: "Current View", items: [
            { id: "task-view", icon: "filter", label: "Change View", large: true, menu: () => [
              view("active", "Active"), view("today", "Today"), view("overdue", "Overdue"), view("completed", "Completed"), view("all", "All"),
            ] },
          ] },
        ] },
      ],
    };
  }

  updateRibbon() {
    const r = this.app.ribbon;
    if (!r) return;
    const it = this.selectedItem();
    const writable = it && (it.kind === "mail" || !it.task.readOnly);
    for (const id of ["delete-task", "mark-complete", "remove-from-list", "fu-today", "fu-tomorrow", "fu-thisweek", "fu-nextweek", "fu-nodate"]) r.enable(id, !!writable);
  }

  // ---- data --------------------------------------------------------------------------------------

  taskCalendars() {
    return this.app.calendar.calendars.filter(c => c.tasks && !c.disabled);
  }

  writableTaskCalendars() {
    return this.taskCalendars().filter(c => !c.readOnly && !c.shared);
  }

  async load() {
    const token = (this.loadToken = Symbol("tasks"));
    let tasks = [], flagged = [];
    try {
      tasks = await messenger.sgmail.taskItems(this.taskCalendars().map(c => c.id), true);
    } catch (e) {
      console.error("sg-mail: tasks", e);
    }
    try {
      let page = await messenger.messages.query({ flagged: true, messagesPerPage: 500 });
      flagged.push(...page.messages);
      while (page.id && flagged.length < 2000) {
        page = await messenger.messages.continueList(page.id);
        flagged.push(...page.messages);
      }
      flagged = flagged.filter(m => {
        const f = m.folder && this.app.mail.folders.folders.get(m.folder.id);
        return !f || !["trash", "junk"].includes(roleOf(f));
      });
    } catch (e) {
      console.error("sg-mail: flagged mail", e);
    }
    if (this.loadToken !== token) return;
    this.tasks = tasks;
    this.flagged = flagged;
    if (this.shown()) {
      this.renderSide();
      this.renderList();
      this.renderDetail();
      this.updateRibbon();
    }
    this.renderTodoBar();
    this.dump();
  }

  // the items of the list shown: tasks, and (in the To-Do List) flagged mail
  items(scope = this.scope, filter = this.filter) {
    const out = [];
    for (const t of this.tasks) {
      if (scope !== "todo" && scope !== "cal:" + t.calendarId) continue;
      out.push({ key: `t:${t.calendarId}|${t.id}`, kind: "task", title: t.title, due: t.due, completed: t.completed, task: t });
    }
    if (scope === "todo") {
      for (const m of this.flagged) {
        out.push({ key: "m:" + m.id, kind: "mail", title: m.subject || "(no subject)", due: this.flagDue[m.headerMessageId] || null, completed: false, msg: m });
      }
    }
    const today = startOfDay(new Date()).getTime();
    const keep = {
      active: it => !it.completed,
      all: () => true,
      completed: it => it.completed,
      overdue: it => !it.completed && it.due && it.due < today,
      today: it => !it.completed && it.due && it.due < today + 86400000,
    }[filter] || (it => !it.completed);
    return out.filter(keep).sort((a, b) => {
      const ga = dueGroup(a.due, a.completed), gb = dueGroup(b.due, b.completed);
      return ga.order - gb.order || (a.due || 0) - (b.due || 0) || a.title.localeCompare(b.title);
    });
  }

  selectedItem() {
    return this.items(this.scope, "all").find(it => it.key === this.selected) || null;
  }

  // ---- drawing ------------------------------------------------------------------------------------

  renderFrame() {
    const list = h("section", { class: "tk-list-pane" },
      h("div", { class: "list-search" }, h("div", { class: "search-box" },
        h("input", { id: "tk-new", type: "text", placeholder: "Type a new task", "aria-label": "Type a new task", autocomplete: "off" }))),
      h("div", { class: "list-head" }, h("span", { id: "tk-title", class: "tk-title" }),
        h("button", { id: "tk-filter", class: "list-sort", title: "Change View" })),
      h("div", { id: "tk-list", class: "tk-list", role: "listbox", tabindex: "0", "aria-label": "Tasks" }));
    const detail = h("section", { id: "tk-detail", class: "tk-detail", "aria-label": "Task" });
    this.main.replaceChildren(list, detail);
    const input = $("#tk-new");
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && input.value.trim()) {
        this.quickAdd(input.value.trim());
        input.value = "";
      }
    });
    $("#tk-filter").addEventListener("click", e => showMenu([
      { header: "Show" },
      ...[["active", "Active"], ["today", "Today"], ["overdue", "Overdue"], ["completed", "Completed"], ["all", "All"]]
        .map(([id, label]) => ({ label, checked: this.filter === id, action: () => this.setFilter(id) })),
    ], e.currentTarget));
    $("#tk-list").addEventListener("keydown", e => this.onListKey(e));
    this.renderSide();
    this.renderList();
    this.renderDetail();
  }

  renderSide() {
    const box = h("div", { class: "pp-side" });
    box.append(h("div", { class: "fp-section", html: `<span class="twisty">${icon("chevron-down", 12)}</span>My Tasks` }));
    const row = (scope, ic, name, count) => {
      const r = h("div", { class: "fp-row" + (this.scope === scope ? " selected" : ""), "data-scope": scope, style: "padding-left:22px",
        html: `<span class="fp-icon">${icon(ic, 16)}</span><span class="fp-name">${esc(name)}</span><span class="fp-count">${count || ""}</span>` });
      r.addEventListener("click", () => this.setScope(scope));
      box.append(r);
    };
    row("todo", "flag", "To-Do List", this.items("todo", "active").length);
    for (const c of this.taskCalendars()) row("cal:" + c.id, "tasks", `Tasks (${c.name})`, this.items("cal:" + c.id, "active").length);
    this.side.replaceChildren(box);
  }

  renderList() {
    const list = $("#tk-list");
    if (!list) return;
    const label = { active: "Active", all: "All", completed: "Completed", overdue: "Overdue", today: "Today" }[this.filter];
    $("#tk-title").textContent = this.scope === "todo" ? "To-Do List" : `Tasks (${(this.taskCalendars().find(c => "cal:" + c.id === this.scope) || {}).name || ""})`;
    $("#tk-filter").innerHTML = `${esc(label)} ${icon("chevron-down", 10)}`;
    list.replaceChildren();
    let last = null;
    for (const it of this.items()) {
      const g = dueGroup(it.due, it.completed);
      if (!last || last.key !== g.key) {
        list.append(h("div", { class: "ml-group tk-group", text: g.label }));
        last = g;
      }
      list.append(this.rowEl(it));
    }
    if (!list.children.length) list.append(h("div", { class: "ml-empty", text: this.filter === "completed" ? "No completed tasks." : "There are no items to show in this view." }));
  }

  rowEl(it, compact = false) {
    const today = startOfDay(new Date()).getTime();
    const overdue = !it.completed && it.due && it.due < today;
    const el = h("div", { class: "tk-row" + (it.key === this.selected && !compact ? " selected" : "") + (it.completed ? " done" : "") + (overdue ? " overdue" : ""),
      role: "option", "data-key": it.key, tabindex: "-1" });
    const check = h("button", { class: "tk-check" + (it.completed ? " on" : ""), title: it.completed ? "Mark Incomplete" : "Mark Complete",
      html: it.completed ? icon("accept", 14) : "" });
    check.addEventListener("click", e => {
      e.stopPropagation();
      if (it.completed) this.markIncomplete(it);
      else this.markComplete(it);
    });
    const sub = it.kind === "mail" ? `${displayName(it.msg.author)}` : (it.task.calendarName || "");
    el.append(check, h("div", { class: "tk-text" },
      h("div", { class: "tk-name", text: it.title || "(No subject)" }),
      h("div", { class: "tk-sub", html: `${it.kind === "mail" ? icon("mail", 12) + " " : ""}${esc(sub)}${it.due ? ` · Due ${esc(fmt.short(new Date(it.due)))}` : ""}` })),
      h("span", { class: "tk-flag", html: icon(it.completed ? "flag-done" : "flag-filled", 15) }));
    el.addEventListener("mousedown", e => {
      if (e.button !== 0 && e.button !== 2) return;
      if (compact) return;
      this.select(it.key);
    });
    el.addEventListener("dblclick", () => this.open(it));
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (!compact) this.select(it.key);
      showMenu([
        { label: "Open", action: () => this.open(it) },
        { separator: true },
        { label: it.completed ? "Mark Incomplete" : "Mark Complete", icon: "tasks", action: () => (it.completed ? this.markIncomplete(it) : this.markComplete(it)) },
        { label: "Follow Up", icon: "flag", submenu: [["today", "Today"], ["tomorrow", "Tomorrow"], ["thisweek", "This Week"], ["nextweek", "Next Week"], [null, "No Date"]]
          .map(([w, l]) => ({ label: l, action: () => this.followUp(w, it) })) },
        { label: "Remove from List", icon: "flag-done", action: () => this.removeFromList(it) },
        { separator: true },
        { label: "Delete", icon: "delete", disabled: it.kind === "mail", action: () => this.deleteItem(it) },
      ], { x: e.clientX, y: e.clientY });
    });
    return el;
  }

  renderDetail() {
    const box = $("#tk-detail");
    if (!box) return;
    const it = this.selectedItem();
    if (!it) {
      box.replaceChildren(h("div", { class: "rp-empty", html: `${icon("tasks", 64)}<p>Select an item to read</p>` }));
      return;
    }
    const field = (label, value) => value ? h("div", { class: "pp-field" }, h("span", { class: "pp-label", text: label }), h("span", { class: "pp-value", text: value })) : "";
    const head = h("div", { class: "rp-head" }, h("h1", { class: "rp-subject", id: "tk-subject", text: it.title || "(No subject)" }));
    const info = h("div", { class: "pp-card-in tk-info" });
    if (it.kind === "task") {
      const t = it.task;
      const status = (STATUS.find(s => s[0] === t.status) || STATUS[t.completed ? 2 : 0])[1];
      info.append(
        it.due && !it.completed && it.due < startOfDay(new Date()).getTime() ? h("div", { class: "infobar", text: "This task is overdue." }) : "",
        it.completed ? h("div", { class: "infobar", text: `Completed${t.completedAt ? " on " + fmt.longDate(new Date(t.completedAt)) : ""}.` }) : "",
        field("Start date", t.start ? fmt.longDate(new Date(t.start)) : "None"),
        field("Due date", t.due ? fmt.longDate(new Date(t.due)) : "None"),
        field("Status", status),
        field("Priority", (PRIORITY.find(p => p[0] === (t.priority >= 6 ? 9 : t.priority >= 1 && t.priority <= 4 ? 1 : 0)) || PRIORITY[1])[1]),
        field("% Complete", `${t.completed ? 100 : t.percent}%`),
        field("Task list", t.calendarName),
        t.description ? h("div", { class: "tk-notes", text: t.description }) : "");
      const acts = h("div", { class: "pp-actions" });
      const btn = (label, ic, fn) => {
        const b = h("button", { class: "rb", html: `${icon(ic, 16)}<span>${esc(label)}</span>` });
        b.addEventListener("click", fn);
        acts.append(b);
      };
      if (!t.readOnly) {
        btn("Edit", "edit", () => this.editTask(t));
        btn(it.completed ? "Mark Incomplete" : "Mark Complete", "tasks", () => (it.completed ? this.markIncomplete(it) : this.markComplete(it)));
      }
      head.append(acts);
    } else {
      const m = it.msg;
      info.append(
        h("div", { class: "infobar", text: `Follow up.${it.due ? " Due " + fmt.longDate(new Date(it.due)) + "." : ""}` }),
        field("From", m.author),
        field("Received", fmt.full(m.date)),
        field("Folder", (this.app.mail.folders.folders.get(m.folder && m.folder.id) || {}).name || ""));
      const acts = h("div", { class: "pp-actions" });
      const open = h("button", { class: "rb", html: `${icon("mail-read", 16)}<span>Open Message</span>` });
      open.addEventListener("click", () => this.open(it));
      const done = h("button", { class: "rb", html: `${icon("tasks", 16)}<span>Mark Complete</span>` });
      done.addEventListener("click", () => this.markComplete(it));
      acts.append(open, done);
      head.append(acts);
    }
    box.replaceChildren(head, info);
  }

  // the To-Do Bar beside the mail: what is due, newest task typed on top
  setTodoBar(on, remember = true) {
    this.todoBar = !!on;
    const bar = $("#todo-bar");
    if (bar) bar.hidden = !on || this.app.module !== "mail";
    if (remember) messenger.storage.local.set({ todoBar: this.todoBar }).catch(() => {});
    if (on) {
      this.renderTodoBar();
      this.load();
    }
    this.app.updateRibbon();
  }

  renderTodoBar() {
    const bar = $("#todo-bar");
    if (!bar || !this.todoBar) return;
    const input = h("input", { id: "todo-new", type: "text", placeholder: "Type a new task", "aria-label": "Type a new task", autocomplete: "off" });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && input.value.trim()) {
        this.quickAdd(input.value.trim());
        input.value = "";
      }
    });
    const close = h("button", { class: "pp-remove", title: "Close the To-Do Bar", html: icon("close", 14) });
    close.addEventListener("click", () => this.setTodoBar(false));
    const list = h("div", { class: "tk-list todo-list", id: "todo-list" });
    let last = null;
    for (const it of this.items("todo", "active")) {
      const g = dueGroup(it.due, it.completed);
      if (!last || last.key !== g.key) {
        list.append(h("div", { class: "ml-group tk-group", text: g.label }));
        last = g;
      }
      list.append(this.rowEl(it, true));
    }
    if (!list.children.length) list.append(h("div", { class: "ml-empty", text: "Nothing to do." }));
    bar.replaceChildren(h("div", { class: "todo-head" }, h("span", { text: "Tasks" }), close),
      h("div", { class: "list-search" }, h("div", { class: "search-box" }, input)), list);
  }

  // ---- doing ------------------------------------------------------------------------------------

  setScope(scope) {
    this.scope = scope;
    this.selected = null;
    this.app.setTitle(scope === "todo" ? "To-Do List" : "Tasks");
    this.renderSide();
    this.renderList();
    this.renderDetail();
    this.updateRibbon();
    this.dump();
  }

  setFilter(f) {
    this.filter = f;
    messenger.storage.local.set({ taskFilter: f }).catch(() => {});
    this.renderList();
    this.dump();
  }

  select(key) {
    this.selected = key;
    for (const el of this.main.querySelectorAll(".tk-row")) el.classList.toggle("selected", el.dataset.key === key);
    this.renderDetail();
    this.updateRibbon();
    this.dump();
  }

  onListKey(e) {
    const keys = this.items().map(it => it.key);
    if (!keys.length) return;
    const i = keys.indexOf(this.selected);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.select(keys[Math.max(0, Math.min(keys.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]);
    } else if (e.key === "Enter") {
      const it = this.selectedItem();
      if (it) this.open(it);
    }
  }

  open(it) {
    if (it.kind === "mail") return messenger.messageDisplay.open({ messageId: it.msg.id, location: "window" }).catch(() => {});
    return this.editTask(it.task);
  }

  defaultCalendar() {
    const cals = this.writableTaskCalendars();
    if (this.scope.startsWith("cal:")) {
      const c = cals.find(x => "cal:" + x.id === this.scope);
      if (c) return c;
    }
    const d = this.app.calendar.defaultCalendar();
    return (d && cals.find(c => c.id === d.id)) || cals[0] || null;
  }

  // "Type a new task": a task due today, as the classic client makes it
  async quickAdd(title) {
    const cal = this.defaultCalendar();
    if (!cal) return toast("There is no task list to put it in: add a calendar first.");
    try {
      await messenger.sgmail.saveTask({ calendarId: cal.id, title, due: startOfDay(new Date()).getTime(), start: null, status: "NEEDS-ACTION" });
      this.app.setStatus(`Task added: ${title}`);
    } catch (e) {
      toast("The task could not be saved: " + e.message);
    }
    this.load();
  }

  async markComplete(it) {
    if (!it) return;
    try {
      if (it.kind === "mail") {
        // flagged mail done: the flag cleared (Thunderbird keeps no
        // "completed" flag), its due day forgotten
        await messenger.messages.update(it.msg.id, { flagged: false });
        delete this.flagDue[it.msg.headerMessageId];
        await messenger.storage.local.set({ flagDue: this.flagDue }).catch(() => {});
      } else {
        await messenger.sgmail.saveTask({ calendarId: it.task.calendarId, id: it.task.id, completed: true, status: "COMPLETED" });
      }
      this.app.setStatus(`Completed: ${it.title}`);
    } catch (e) {
      toast("Could not mark it complete: " + e.message);
    }
    this.load();
  }

  async markIncomplete(it) {
    if (it.kind !== "task") return;
    try {
      await messenger.sgmail.saveTask({ calendarId: it.task.calendarId, id: it.task.id, completed: false, status: "NEEDS-ACTION", percent: 0 });
    } catch (e) {
      toast("Could not change it: " + e.message);
    }
    this.load();
  }

  async removeFromList(it) {
    if (!it) return;
    if (it.kind === "mail") return this.markComplete(it);
    return this.deleteItem(it);
  }

  async deleteItem(it) {
    if (!it || it.kind !== "task" || it.task.readOnly) return;
    if (!(await confirmBox("SG Mail", `Delete the task "${it.title}"?`, "Delete", "Cancel"))) return;
    try {
      await messenger.sgmail.deleteTask(it.task.calendarId, it.task.id);
      if (this.selected === it.key) this.selected = null;
    } catch (e) {
      toast("Could not delete: " + e.message);
    }
    this.load();
  }

  deleteSelected() {
    return this.deleteItem(this.selectedItem());
  }

  // Follow Up: when it is due (a task's due day, or flagged mail's)
  async followUp(when, it = this.selectedItem()) {
    if (!it) return;
    const due = when ? followUpDay(when) : null;
    try {
      if (it.kind === "mail") {
        if (due) this.flagDue[it.msg.headerMessageId] = due;
        else delete this.flagDue[it.msg.headerMessageId];
        await messenger.storage.local.set({ flagDue: this.flagDue });
      } else {
        await messenger.sgmail.saveTask({ calendarId: it.task.calendarId, id: it.task.id, due, start: due && it.task.start && it.task.start > due ? due : it.task.start });
      }
    } catch (e) {
      toast("Could not change it: " + e.message);
    }
    this.load();
  }

  // flag mail with a follow-up day (Mail's Follow Up menu)
  async flagMail(msgs, when) {
    for (const m of msgs) {
      const due = when ? followUpDay(when) : null;
      if (due) this.flagDue[m.headerMessageId] = due;
      else delete this.flagDue[m.headerMessageId];
      if (!m.flagged) {
        m.flagged = true;
        this.app.mail.list.update(m);
        await messenger.messages.update(m.id, { flagged: true });
      }
    }
    await messenger.storage.local.set({ flagDue: this.flagDue }).catch(() => {});
    this.load();
  }

  // the task window, as a dialog: Subject, Start and Due date, Status,
  // Priority, % Complete, Reminder, the task list, the notes
  async editTask(t) {
    const cals = this.writableTaskCalendars();
    if (!t && !cals.length) return toast("There is no task list to put it in: add a calendar first.");
    const isNew = !t;
    t = t || { calendarId: (this.defaultCalendar() || cals[0]).id, title: "", description: "", start: null, due: null, status: "NEEDS-ACTION", priority: 0, percent: 0, reminder: -1 };
    const body = h("div", { class: "pp-grid tk-form" });
    const f = (label, el, wide = false) => body.append(h("label", { class: "pp-f" + (wide ? " wide" : "") }, h("span", { text: label }), el));
    const status = t.completed ? "COMPLETED" : t.status === "NONE" ? "NEEDS-ACTION" : t.status;
    f("Subject", h("input", { id: "tk-f-title", type: "text", value: t.title }), true);
    f("Start date", h("input", { id: "tk-f-start", type: "date", value: t.start ? dateValue(new Date(t.start)) : "" }));
    f("Due date", h("input", { id: "tk-f-due", type: "date", value: t.due ? dateValue(new Date(t.due)) : "" }));
    f("Status", h("select", { id: "tk-f-status" }, STATUS.map(([v, l]) => h("option", { value: v, text: l, selected: v === status }))));
    const pr = t.priority >= 6 ? 9 : t.priority >= 1 && t.priority <= 4 ? 1 : 0;
    f("Priority", h("select", { id: "tk-f-priority" }, PRIORITY.map(([v, l]) => h("option", { value: String(v), text: l, selected: v === pr }))));
    f("% Complete", h("input", { id: "tk-f-percent", type: "number", min: "0", max: "100", step: "25", value: String(t.completed ? 100 : t.percent || 0) }));
    f("Reminder", h("select", { id: "tk-f-reminder" }, [[-1, "None"], [0, "On the due day"], [1440, "1 day before"], [10080, "1 week before"]]
      .map(([v, l]) => h("option", { value: String(v), text: l, selected: v === t.reminder }))));
    f("Task list", h("select", { id: "tk-f-cal", disabled: !isNew }, (isNew ? cals : this.taskCalendars())
      .map(c => h("option", { value: c.id, text: c.name, selected: c.id === t.calendarId }))), true);
    f("Notes", h("textarea", { id: "tk-f-notes", rows: "6", text: t.description || "" }), true);
    const v = await dialog({
      title: isNew ? "Untitled - Task" : `${t.title || "Untitled"} - Task`,
      body,
      width: 560,
      buttons: [{ label: "Save & Close", primary: true, value: "save" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (v !== "save") return null;
    const q = id => body.querySelector(id);
    const st = q("#tk-f-status").value;
    const task = {
      calendarId: q("#tk-f-cal").value,
      id: isNew ? "" : t.id,
      title: q("#tk-f-title").value.trim(),
      start: readDateValue(q("#tk-f-start").value),
      due: readDateValue(q("#tk-f-due").value),
      status: st,
      completed: st === "COMPLETED",
      priority: Number(q("#tk-f-priority").value),
      percent: Math.max(0, Math.min(100, Number(q("#tk-f-percent").value) || 0)),
      reminder: Number(q("#tk-f-reminder").value),
      description: q("#tk-f-notes").value,
    };
    if (task.percent === 100 && !task.completed) {
      task.completed = true;
      task.status = "COMPLETED";
    }
    if (task.start && task.due && task.due < task.start) return toast("The due date is before the start date."), this.editTask(Object.assign({}, t, task));
    try {
      const r = await messenger.sgmail.saveTask(task);
      this.selected = `t:${r.calendarId}|${r.id}`;
    } catch (e) {
      toast("The task could not be saved: " + e.message);
    }
    this.load();
    return task;
  }

  dump() {
    const data = {
      scope: this.scope,
      filter: this.filter,
      items: this.items().map(it => ({ key: it.key, kind: it.kind, title: it.title, due: it.due, completed: it.completed, group: dueGroup(it.due, it.completed).label,
        status: it.task ? it.task.status : "", percent: it.task ? it.task.percent : 0, calendar: it.task ? it.task.calendarName : "" })),
      selected: this.selected,
      detail: $("#tk-detail") ? $("#tk-detail").innerText.slice(0, 1000) : "",
      todoBar: this.todoBar ? [...document.querySelectorAll("#todo-bar .tk-name")].map(e => e.textContent) : null,
    };
    testDump("tasks.json", data);
    return data;
  }
}
