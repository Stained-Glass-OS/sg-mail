/*
 * SG Mail -- the appointment window: Title, Location, Start and End (or all
 * day), the calendar it goes in, Show As, Reminder, Recurrence and the
 * notes; with attendees it is a meeting, and Send invites them (Thunderbird
 * mails the iCalendar request, or the calendar's server does).
 *
 *   event.html?calendarId=ID&id=UID[&occurrence=MS]      open one
 *   event.html?start=MS&end=MS[&allDay=1][&meeting=1][&calendarId=ID]   new
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, $$, esc, fmt, toast, dialog, applyLook, parseAddress, splitAddresses, formatAddress, validEmail, debounce, addDays, startOfDay, testDump, searchAddressBooks } from "./util.js";
import { Ribbon } from "./ribbon.js";
import { installTestHook } from "./testhook.js";
import { SchedulingAssistant } from "./scheduling.js";

const params = new URLSearchParams(location.search);
const state = {
  ev: null,
  isNew: !params.get("id"),
  meeting: params.get("meeting") === "1",
  showAs: "busy",
  reminder: 15,
  recurrence: null,
  dirty: false,
  calendars: [],
  identities: [],
};

const pad = n => String(n).padStart(2, "0");
const dateValue = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeValue = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function readDate(dateId, timeId) {
  const [y, m, d] = $("#" + dateId).value.split("-").map(Number);
  const [hh, mm] = ($("#" + timeId).value || "00:00").split(":").map(Number);
  return new Date(y, m - 1, d, $("#all-day").checked ? 0 : hh, $("#all-day").checked ? 0 : mm);
}

const REMINDERS = [[-1, "None"], [0, "0 minutes"], [5, "5 minutes"], [10, "10 minutes"], [15, "15 minutes"], [30, "30 minutes"], [60, "1 hour"], [120, "2 hours"], [1440, "1 day"], [10080, "1 week"]];

async function init() {
  applyLook();
  const accounts = await messenger.accounts.list(false);
  for (const a of accounts) for (const i of a.identities || []) state.identities.push(i);
  state.calendars = (await messenger.sgmail.calendars()).filter(c => !c.disabled);
  const sel = $("#calendar");
  for (const c of state.calendars) sel.append(h("option", { value: c.id, text: c.name + (c.readOnly ? " (read-only)" : ""), disabled: c.readOnly && state.isNew }));
  if (state.isNew) {
    const start = new Date(Number(params.get("start")) || Date.now());
    const end = new Date(Number(params.get("end")) || start.getTime() + 30 * 60000);
    const allDay = params.get("allDay") === "1";
    state.ev = { calendarId: params.get("calendarId") || (state.calendars.find(c => !c.readOnly) || {}).id, title: "", location: "", description: "",
      start: start.getTime(), end: end.getTime(), allDay, attendees: [], reminder: allDay ? 1080 : 15, showAs: allDay ? "free" : "busy", recurrence: null };
  } else {
    state.ev = await messenger.sgmail.calendarItem(params.get("calendarId"), params.get("id"), params.get("occurrence") ? Number(params.get("occurrence")) : null);
    state.meeting = state.ev.attendees.length > 0;
  }
  const ev = state.ev;
  state.reminder = ev.reminder;
  state.showAs = ev.showAs || "busy";
  state.recurrence = ev.recurrence && ev.recurrence.freq ? ev.recurrence : null;
  sel.value = ev.calendarId || "";
  $("#title").value = ev.title;
  $("#location").value = ev.location;
  $("#description").value = ev.description;
  $("#all-day").checked = ev.allDay;
  const s = new Date(ev.start);
  let e = new Date(ev.end);
  if (ev.allDay) e = addDays(e, -1);     // shown as the last day, kept as the day after
  $("#start-date").value = dateValue(s);
  $("#start-time").value = timeValue(s);
  $("#end-date").value = dateValue(e);
  $("#end-time").value = timeValue(new Date(ev.end));
  $("#attendees").value = ev.attendees.map(a => formatAddress({ name: a.name, email: a.email })).join("; ");
  // a meeting asked for from People: its invitees already in
  if (state.isNew && params.get("attendees")) $("#attendees").value = params.get("attendees");
  // (a meeting from a message: its subject)
  if (state.isNew && params.get("title")) $("#title").value = params.get("title");
  if (ev.organizer && !ev.iAmOrganizer) {
    $("#org-row").hidden = false;
    $("#organizer").textContent = formatAddress(ev.organizer);
  }
  setMeeting(state.meeting);
  syncAllDay();
  buildRibbon();
  wire();
  updateInfo();
  updateTitle();
  if (!state.isNew && (state.ev.readOnly || (state.ev.organizer && !state.ev.iAmOrganizer))) {
    $("#bars").append(h("div", { class: "infobar", html: `${icon("info", 16)}<span>${state.ev.readOnly ? "This calendar is read-only." : "You are not the organizer of this meeting: changes you make stay in your calendar."}</span>` }));
  }
  state.dirty = false;
  state.sched = new SchedulingAssistant($("#sched"), {
    getTimes: () => {
      const allDay = $("#all-day").checked;
      const start = readDate("start-date", "start-time").getTime();
      let end = readDate("end-date", "end-time").getTime();
      if (allDay) end = addDays(startOfDay(new Date(end)), 1).getTime();
      return { start, end: Math.max(end, start), allDay };
    },
    setTimes: (start, end) => {
      const s = new Date(start), e = new Date(end);
      $("#start-date").value = dateValue(s);
      $("#start-time").value = timeValue(s);
      $("#end-date").value = dateValue(e);
      $("#end-time").value = timeValue(e);
      $("#start-date").dispatchEvent(new Event("sync"));
      state.dirty = true;
    },
    getAttendees: () => splitAddresses($("#attendees").value).map(parseAddress).filter(a => a.email),
    addAttendee: text => {
      const v = $("#attendees").value.trim().replace(/[;,]\s*$/, "");
      $("#attendees").value = (v ? v + "; " : "") + text;
      state.dirty = true;
    },
    me: () => {
      const calendar = state.calendars.find(c => c.id === $("#calendar").value);
      const ident = (calendar && calendar.identityKey && state.identities.find(i => i.id === calendar.identityKey)) || state.identities[0];
      if (state.ev.organizer && !state.ev.iAmOrganizer) return state.ev.organizer;
      return ident ? { name: ident.name, email: ident.email } : null;
    },
  });
  window.sgmailEvent = { state, save, dump };
  installTestHook("event", { dump, save: () => !setTimeout(save, 50), close: () => !setTimeout(() => window.close(), 50),
    schedule: () => state.sched.dump(), showScheduling: a => showScheduling(a.on !== false), setRecurrence: a => {
    state.recurrence = a;
    updateInfo();
    return true;
  }, selectCalendarInEvent: a => {
    const c = state.calendars.find(x => x.name === a.name);
    if (!c) throw new Error("no calendar " + a.name);
    $("#calendar").value = c.id;
    return true;
  }, setReminder: a => {
    state.reminder = a.minutes;
    return true;
  } });
  testDump("event-ready.json", dump());
  setTimeout(() => $("#title").focus(), 0);
}

// the Scheduling Assistant in place of the form (a meeting's), and back
async function showScheduling(on) {
  if (on && !state.meeting) {
    setMeeting(true);
  }
  state.scheduling = !!on;
  $("#sched").hidden = !on;
  $(".e-form").hidden = on;
  $("#description").hidden = on;
  buildRibbon();
  if (on) await state.sched.show();
  return true;
}

function setMeeting(on) {
  state.meeting = on;
  $("#att-row").hidden = !on;
  document.title = document.title.replace(/ - (Appointment|Meeting)$/, on ? " - Meeting" : " - Appointment");
}

function updateTitle() {
  document.title = `${$("#title").value || "Untitled"} - ${state.meeting ? "Meeting" : "Appointment"}`;
}

function syncAllDay() {
  const on = $("#all-day").checked;
  $("#start-time").hidden = on;
  $("#end-time").hidden = on;
}

function wire() {
  for (const id of ["title", "location", "description", "attendees", "start-date", "start-time", "end-date", "end-time", "calendar"]) {
    $("#" + id).addEventListener("input", () => {
      state.dirty = true;
      if (id === "title") updateTitle();
    });
  }
  // moving the start keeps the length
  let lastStart = readDate("start-date", "start-time").getTime();
  const moveEnd = () => {
    const ns = readDate("start-date", "start-time").getTime();
    const ne = readDate("end-date", "end-time").getTime() + (ns - lastStart);
    const d = new Date(ne);
    $("#end-date").value = dateValue(d);
    $("#end-time").value = timeValue(d);
    lastStart = ns;
  };
  $("#start-date").addEventListener("change", moveEnd);
  // times set by the Scheduling Assistant: the length kept from there on
  $("#start-date").addEventListener("sync", () => {
    lastStart = readDate("start-date", "start-time").getTime();
  });
  $("#start-time").addEventListener("change", moveEnd);
  $("#all-day").addEventListener("change", () => {
    syncAllDay();
    if ($("#all-day").checked && state.reminder === 15) state.reminder = 1080;
    state.dirty = true;
  });
  wireCompletion($("#attendees"));
  document.addEventListener("keydown", e => {
    if (document.querySelector(".modal-shade")) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if ((ctrl && e.key === "s") || (e.altKey && e.key.toLowerCase() === "s")) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeWindow();
    }
  });
}

function buildRibbon() {
  const reminderLabel = () => (REMINDERS.find(r => r[0] === state.reminder) || [0, `${state.reminder} minutes`])[1];
  const ribbon = new Ribbon($("#ribbon"), {
    tabs: [{ id: "event", label: state.meeting ? "Meeting" : "Appointment", groups: [
      { label: "Actions", items: [
        { id: "save-close", icon: state.meeting ? "send" : "save", label: state.meeting ? (state.isNew ? "Send" : "Send Update") : "Save & Close", large: true, action: () => save() },
        { id: "delete", icon: "delete", label: "Delete", large: true, action: () => remove() },
      ] },
      { label: "Show", items: [
        { id: "show-appointment", icon: "calendar", label: state.meeting ? "Meeting" : "Appointment", large: true, action: () => showScheduling(false) },
        { id: "show-scheduling", icon: "scheduling", label: "Scheduling Assistant", large: true, action: () => showScheduling(true) },
      ] },
      { label: "Attendees", items: [
        { id: "invite", icon: "meeting-new", label: state.meeting ? "Cancel Invitation" : "Invite Attendees", large: true, action: () => {
          setMeeting(!state.meeting);
          buildRibbon();
          if (state.meeting) $("#attendees").focus();
        } },
      ] },
      { label: "Options", items: [
        { col: [
          { id: "show-as", icon: "clock", label: `Show As: ${state.showAs === "free" ? "Free" : "Busy"}`, menu: () => [
            { label: "Free", checked: state.showAs === "free", action: () => { state.showAs = "free"; state.dirty = true; buildRibbon(); } },
            { label: "Busy", checked: state.showAs === "busy", action: () => { state.showAs = "busy"; state.dirty = true; buildRibbon(); } },
          ] },
          { id: "reminder", icon: "bell", label: `Reminder: ${reminderLabel()}`, menu: () => REMINDERS.map(([v, l]) => ({ label: l, checked: state.reminder === v, action: () => { state.reminder = v; state.dirty = true; buildRibbon(); } })) },
        ] },
        { id: "recurrence", icon: "repeat", label: "Recurrence", large: true, action: () => editRecurrence() },
      ] },
    ] }],
  });
  ribbon.toggle("show-scheduling", !!state.scheduling);
  ribbon.toggle("show-appointment", !state.scheduling);
  return ribbon;
}

function updateInfo() {
  const r = state.recurrence;
  if (!r || !r.freq) {
    $("#recur-info").textContent = "";
    return;
  }
  if (r.freq === "custom") {
    $("#recur-info").textContent = "Recurrence: a pattern SG Mail does not edit (kept as it is).";
    return;
  }
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[r.freq];
  let s = r.interval > 1 ? `Occurs every ${r.interval} ${unit}s` : `Occurs every ${unit}`;
  if (r.freq === "weekly" && r.byday && r.byday.length) s += " on " + r.byday.join(", ");
  if (r.count) s += `, ${r.count} times`;
  else if (r.until) s += ` until ${fmt.longDate(new Date(r.until))}`;
  $("#recur-info").textContent = s;
}

async function editRecurrence() {
  const r = state.recurrence && state.recurrence.freq !== "custom" ? state.recurrence : { freq: "weekly", interval: 1, count: 0, until: null, byday: [] };
  const days = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const start = readDate("start-date", "start-time");
  const startDay = days[(start.getDay() + 6) % 7];
  const body = h("div", {});
  body.innerHTML = `
    <div class="form-row"><label>Pattern</label>
      <select id="rc-freq"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select>
      every <input id="rc-int" type="number" min="1" max="99" value="${r.interval || 1}" style="width:60px"> <span id="rc-unit"></span></div>
    <div class="form-row" id="rc-days-row"><label>On</label>${days.map(d => `<label style="min-width:0"><input type="checkbox" value="${d}" ${(r.byday && r.byday.length ? r.byday : [startDay]).includes(d) ? "checked" : ""}> ${d.slice(0, 1)}${d.slice(1).toLowerCase()}</label>`).join(" ")}</div>
    <div class="form-row"><label>Range</label>
      <label style="min-width:0"><input type="radio" name="rc-end" value="never" ${!r.count && !r.until ? "checked" : ""}> No end date</label></div>
    <div class="form-row"><label></label><label style="min-width:0"><input type="radio" name="rc-end" value="count" ${r.count ? "checked" : ""}> End after</label>
      <input id="rc-count" type="number" min="1" value="${r.count || 10}" style="width:70px"> occurrences</div>
    <div class="form-row"><label></label><label style="min-width:0"><input type="radio" name="rc-end" value="until" ${r.until ? "checked" : ""}> End by</label>
      <input id="rc-until" type="date" value="${dateValue(r.until ? new Date(r.until) : addDays(start, 90))}"></div>`;
  const v = await dialog({
    title: "Appointment Recurrence",
    body,
    width: 520,
    init: box => {
      const freq = box.querySelector("#rc-freq");
      freq.value = r.freq;
      const sync = () => {
        box.querySelector("#rc-unit").textContent = { daily: "day(s)", weekly: "week(s)", monthly: "month(s)", yearly: "year(s)" }[freq.value];
        box.querySelector("#rc-days-row").hidden = freq.value !== "weekly";
      };
      freq.addEventListener("change", sync);
      sync();
    },
    buttons: [
      { label: "OK", primary: true, value: box => {
        const freq = box.querySelector("#rc-freq").value;
        const end = box.querySelector("input[name=rc-end]:checked").value;
        return {
          freq,
          interval: Math.max(1, Number(box.querySelector("#rc-int").value) || 1),
          byday: freq === "weekly" ? [...box.querySelectorAll("#rc-days-row input:checked")].map(i => i.value) : [],
          count: end === "count" ? Math.max(1, Number(box.querySelector("#rc-count").value) || 1) : 0,
          until: end === "until" ? new Date(box.querySelector("#rc-until").value + "T23:59:59").getTime() : null,
        };
      } },
      { label: "Remove Recurrence", value: "remove" },
      { label: "Cancel", value: null, cancel: true },
    ],
  });
  if (v === null) return;
  state.recurrence = v === "remove" ? null : v;
  state.dirty = true;
  updateInfo();
}

// ---- attendees ---------------------------------------------------------------------------------------

function wireCompletion(input) {
  const box = $("#complete");
  let items = [], active = -1;
  const current = () => {
    const v = input.value;
    const cut = Math.max(v.lastIndexOf(","), v.lastIndexOf(";"));
    return { before: cut >= 0 ? v.slice(0, cut + 1) + " " : "", term: v.slice(cut + 1).trim() };
  };
  const close = () => {
    box.hidden = true;
    items = [];
  };
  const choose = i => {
    input.value = current().before + formatAddress(items[i]) + "; ";
    close();
  };
  input.addEventListener("input", debounce(async () => {
    const { term } = current();
    if (!term) return close();
    let nodes = [];
    try {
      nodes = await searchAddressBooks(term);
    } catch (e) {
      // none
    }
    items = [];
    for (const n of nodes) {
      const fn = ((n.vCard || "").match(/^FN[^:]*:(.*)$/mi) || [])[1] || "";
      for (const m of (n.vCard || "").matchAll(/^EMAIL[^:]*:(.*)$/gmi)) items.push({ name: fn.trim(), email: m[1].trim() });
    }
    items = items.slice(0, 10);
    if (!items.length) return close();
    active = 0;
    box.replaceChildren(...items.map((c, i) => {
      const d = h("div", { class: i ? "" : "active", html: `${esc(c.name || c.email)} <span class="em">&lt;${esc(c.email)}&gt;</span>` });
      d.addEventListener("mousedown", e => {
        e.preventDefault();
        choose(i);
      });
      return d;
    }));
    const r = input.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.bottom + 2 + "px";
    box.hidden = false;
  }, 150));
  input.addEventListener("keydown", e => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      $$("div", box).forEach((d, i) => d.classList.toggle("active", i === active));
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(active);
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}

// ---- saving --------------------------------------------------------------------------------------------

function collect() {
  const allDay = $("#all-day").checked;
  let start = readDate("start-date", "start-time");
  let end = readDate("end-date", "end-time");
  if (allDay) end = addDays(startOfDay(end), 1);
  const attendees = state.meeting ? splitAddresses($("#attendees").value).map(parseAddress).filter(a => a.email).map(a => {
    const old = state.ev.attendees.find(x => x.email.toLowerCase() === a.email.toLowerCase());
    return { name: a.name, email: a.email, role: "REQ-PARTICIPANT", status: old ? old.status : "NEEDS-ACTION" };
  }) : [];
  const calendar = state.calendars.find(c => c.id === $("#calendar").value);
  const identity = (calendar && calendar.identityKey && state.identities.find(i => i.id === calendar.identityKey)) || state.identities[0];
  return {
    calendarId: $("#calendar").value,
    id: state.isNew ? "" : state.ev.id,
    occurrence: state.ev.occurrence || null,
    title: $("#title").value,
    location: $("#location").value,
    description: $("#description").value,
    start: start.getTime(),
    end: end.getTime(),
    allDay,
    attendees,
    reminder: state.reminder,
    showAs: state.showAs,
    recurrence: state.recurrence,
    identityId: identity ? identity.id : "",
    organizer: state.ev.organizer && !state.ev.iAmOrganizer ? state.ev.organizer : (identity ? { name: identity.name, email: identity.email } : null),
  };
}

function infobar(text) {
  $("#bars").replaceChildren(h("div", { class: "infobar", id: "e-error", html: `${icon("info", 16)}<span>${esc(text)}</span>` }));
}

async function save() {
  const ev = collect();
  if (ev.end < ev.start) return infobar("The end time you entered occurs before the start time.");
  if (state.meeting) {
    const bad = ev.attendees.filter(a => !validEmail(a.email));
    if (bad.length) return infobar(`SG Mail does not recognise ${bad.map(a => a.email).join(", ")}.`);
    if (!ev.attendees.length) return infobar("Add at least one attendee to send this meeting request, or Cancel Invitation.");
  }
  let series = true;
  if (!state.isNew && state.ev.recurring && state.ev.occurrence) {
    const v = await dialog({
      title: "Open Recurring Item",
      body: `<p>"${esc(ev.title)}" is a recurring appointment. Save the change to this occurrence only, or to the series?</p>`,
      buttons: [{ label: "Just this one", value: "one", primary: true }, { label: "The entire series", value: "series" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    series = v === "series";
    if (series) {
      // the series keeps its own start day; only the times change
      const master = await messenger.sgmail.calendarItem(ev.calendarId, state.ev.id, null);
      const ds = ev.start - state.ev.start, de = ev.end - state.ev.end;
      ev.start = master.start + ds;
      ev.end = master.end + de;
      ev.occurrence = null;
    }
  }
  const moving = !state.isNew && ev.calendarId !== state.ev.calendarId;
  try {
    const sendInvitations = state.meeting && (state.isNew || state.ev.iAmOrganizer);
    if (moving) {
      await messenger.sgmail.saveEvent(Object.assign({}, ev, { id: "" }), { asNew: true, sendInvitations: false });
      await messenger.sgmail.deleteEvent(state.ev.calendarId, state.ev.id, null, { series: true });
    } else {
      const r = await messenger.sgmail.saveEvent(ev, { series, sendInvitations });
      testDump("event-result.json", { ok: true, saved: r, event: ev });
    }
  } catch (e) {
    testDump("event-result.json", { ok: false, error: e.message });
    return infobar("The item could not be saved: " + e.message);
  }
  state.dirty = false;
  window.close();
}

async function remove() {
  if (state.isNew) return window.close();
  let series = true;
  if (state.ev.recurring && state.ev.occurrence) {
    const v = await dialog({
      title: "Delete Repeating Item",
      body: "<p>Delete only this occurrence, or the series?</p>",
      buttons: [{ label: "This occurrence", value: "one", primary: true }, { label: "The series", value: "series" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    series = v === "series";
  } else if (!(await dialog({ title: "SG Mail", body: "<p>Delete this item?</p>", buttons: [{ label: "Delete", value: true, primary: true }, { label: "Cancel", value: false, cancel: true }] }))) return;
  try {
    await messenger.sgmail.deleteEvent(state.ev.calendarId, state.ev.id, state.ev.occurrence || null,
      { series, sendCancellations: state.ev.iAmOrganizer && state.ev.attendees.length > 0 });
  } catch (e) {
    return infobar("The item could not be deleted: " + e.message);
  }
  window.close();
}

async function closeWindow() {
  if (state.dirty) {
    const v = await dialog({ title: "SG Mail", body: "<p>Do you want to save changes?</p>",
      buttons: [{ label: "Yes", value: "save", primary: true }, { label: "No", value: "discard" }, { label: "Cancel", value: null, cancel: true }] });
    if (!v) return;
    if (v === "save") return save();
  }
  window.close();
}

function dump() {
  return { title: $("#title").value, meeting: state.meeting, calendar: $("#calendar").value, start: $("#start-date").value + " " + $("#start-time").value,
    end: $("#end-date").value + " " + $("#end-time").value, allDay: $("#all-day").checked, attendees: $("#attendees").value, windowTitle: document.title };
}

init().catch(e => {
  console.error("sg-mail: event", e);
  infobar("This item could not be opened: " + e.message);
});
