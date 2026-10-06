/*
 * SG Mail -- the parts of Thunderbird the WebExtension APIs do not reach:
 * making a main window SG Mail's window, Send/Receive, sending a message
 * written in our own compose window, the calendar (Thunderbird's calendar
 * manager: calendars, events, invitations, reminders), and Thunderbird's
 * own tools (account setup, account settings, settings, address book).
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionUtils } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
var { getFolder } = ChromeUtils.importESModule("resource:///modules/ExtensionAccounts.sys.mjs");
var { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
var lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  cal: "resource:///modules/calendar/calUtils.sys.mjs",
  CalEvent: "resource:///modules/CalEvent.sys.mjs",
  CalTodo: "resource:///modules/CalTodo.sys.mjs",
  CalAttendee: "resource:///modules/CalAttendee.sys.mjs",
  CalAlarm: "resource:///modules/CalAlarm.sys.mjs",
  CalRecurrenceInfo: "resource:///modules/CalRecurrenceInfo.sys.mjs",
});
var { ExtensionError } = ExtensionUtils;
// what the shared calendars and automatic replies need in this scope
for (const name of ["fetch", "DOMParser", "TextDecoder", "btoa", "URL"]) {
  try {
    if (!(name in globalThis)) Cu.importGlobalProperties([name]);
  } catch (e) {
    // not offered here
  }
}

// Thunderbird's own bars hidden while our tab is showing; its tab strip
// back (without its own mail tab) while one of its tools is open.
const CHROME_CSS = `
:root[sgmail] #spacesToolbar, :root[sgmail] #spacesPinnedButton, :root[sgmail] #status-bar,
:root[sgmail] unified-toolbar, :root[sgmail] #toolbar-menubar { display: none !important; }
:root[sgmail][sgmail-own] #navigation-toolbox { display: none !important; }
:root[sgmail] #tabmail-tabs tab.tabmail-tab:first-of-type:not([sgmail-tab]) { display: none !important; }
:root[sgmail] #tabmail-tabs tab[sgmail-tab] .tab-close-button { display: none !important; }
:root[sgmail] #messengerBody, :root[sgmail] #titlebar { margin-inline-start: 0 !important; }
:root[sgmail] .contentTabInstance[sgmail-panel] .contentTabToolbox { display: none !important; }
`;

function mainWindow() {
  return Services.wm.getMostRecentWindow("mail:3pane");
}

function folderOf(folderId) {
  try {
    return getFolder(folderId).folder;
  } catch (e) {
    throw new ExtensionError(`No folder ${folderId}`);
  }
}

// ---- the calendar, as plain objects ----------------------------------------------------

function jsDate(dt) {
  return dt ? lazy.cal.dtz.dateTimeToJsDate(dt).getTime() : null;
}

function calDateTime(ms, allDay) {
  const d = new Date(ms);
  if (allDay) {
    const dt = lazy.cal.createDateTime();
    dt.resetTo(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, lazy.cal.dtz.floating);
    dt.isDate = true;
    return dt;
  }
  return lazy.cal.dtz.jsDateToDateTime(d, lazy.cal.dtz.defaultTimezone);
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function recurrenceOf(item) {
  const info = item.recurrenceInfo;
  if (!info) return null;
  for (const ritem of info.getRecurrenceItems()) {
    if (ritem instanceof Ci.calIRecurrenceRule && !ritem.isNegative) {
      const r = { freq: ritem.type.toLowerCase(), interval: ritem.interval || 1, count: 0, until: null, byday: [] };
      if (ritem.isByCount) r.count = ritem.count > 0 ? ritem.count : 0;
      else if (ritem.untilDate) r.until = jsDate(ritem.untilDate);
      for (const d of ritem.getComponent("BYDAY")) {
        // 1 = Sunday .. 7 = Saturday (no week number in what we write)
        if (d >= 1 && d <= 7) r.byday.push(DAYS[d - 1]);
      }
      return r;
    }
  }
  return { freq: "custom", interval: 1, count: 0, until: null, byday: [] };
}

function reminderOf(item) {
  for (const alarm of item.getAlarms()) {
    if (alarm.related === Ci.calIAlarm.ALARM_RELATED_START && alarm.offset) {
      return Math.max(0, Math.round(-alarm.offset.inSeconds / 60));
    }
  }
  return -1;
}

function addressOf(att) {
  if (!att) return null;
  return { name: att.commonName || "", email: (att.id || "").replace(/^mailto:/i, "") };
}

function myIdentityEmails() {
  return new Set(MailServices.accounts.allIdentities.map(i => (i.email || "").toLowerCase()));
}

// ---- the Focused Inbox's people ------------------------------------------------------------

// the addresses this person has written to (their Sent folders) or replied
// to (their Inboxes), looked at again at most once a minute
let correspondents = { at: 0, set: new Set() };

function emailsIn(text) {
  if (!text) return [];
  return (MailServices.headerParser.extractHeaderAddressMailboxes(text) || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function knownCorrespondents() {
  if (Date.now() - correspondents.at < 60000) return correspondents.set;
  const set = new Set();
  for (const folder of MailServices.accounts.allFolders) {
    const sent = folder.getFlag(Ci.nsMsgFolderFlags.SentMail);
    const inbox = folder.getFlag(Ci.nsMsgFolderFlags.Inbox);
    if (!sent && !inbox) continue;
    let db;
    try {
      db = folder.msgDatabase;
    } catch (e) {
      continue;
    }
    if (!db) continue;
    let n = 0;
    try {
      for (const hdr of db.enumerateMessages()) {
        if (++n > 20000) break;
        if (sent) {
          for (const e of emailsIn(hdr.recipients)) set.add(e);
          for (const e of emailsIn(hdr.ccList)) set.add(e);
        } else if (hdr.flags & Ci.nsMsgMessageFlags.Replied) {
          for (const e of emailsIn(hdr.author)) set.add(e);
        }
      }
    } catch (e) {
      console.error("sg-mail: correspondents", folder.name, e);
    }
  }
  correspondents = { at: Date.now(), set };
  return set;
}

function hasContact(email) {
  try {
    return !!MailServices.ab.cardForEmailAddress(email);
  } catch (e) {
    return false;
  }
}

function eventObject(item, calendar) {
  const parent = item.parentItem && item.parentItem !== item ? item.parentItem : item;
  const start = item.startDate;
  const allDay = !!(start && start.isDate);
  const mine = myIdentityEmails();
  const attendees = item.getAttendees().map(a => ({
    name: a.commonName || "",
    email: (a.id || "").replace(/^mailto:/i, ""),
    role: a.role || "REQ-PARTICIPANT",
    status: a.participationStatus || "NEEDS-ACTION",
  }));
  const me = attendees.find(a => mine.has(a.email.toLowerCase()));
  const organizer = addressOf(item.organizer);
  return {
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.getProperty("color") || "#0078d4",
    readOnly: !!calendar.readOnly,
    id: item.id,
    occurrence: item.recurrenceId ? jsDate(item.recurrenceId) : null,
    title: item.title || "",
    location: item.getProperty("LOCATION") || "",
    description: item.getProperty("DESCRIPTION") || "",
    start: jsDate(start),
    end: jsDate(item.endDate || start),
    allDay,
    recurring: !!parent.recurrenceInfo,
    recurrence: recurrenceOf(parent),
    reminder: reminderOf(item),
    organizer,
    iAmOrganizer: !organizer || mine.has(organizer.email.toLowerCase()),
    attendees,
    myStatus: me ? me.status : "",
    showAs: item.getProperty("TRANSP") === "TRANSPARENT" ? "free" : "busy",
  };
}

function calendarById(id) {
  const c = lazy.cal.manager.getCalendarById(id);
  if (!c) throw new ExtensionError(`No calendar ${id}`);
  return c;
}

async function itemsOf(calendar, filter, start, end) {
  const out = [];
  for await (const batch of lazy.cal.iterate.streamValues(calendar.getItems(filter, 0, start, end))) {
    out.push(...batch);
  }
  return out;
}

async function masterItem(calendar, id) {
  const item = await calendar.getItem(id);
  if (!item) throw new ExtensionError(`No event ${id}`);
  return item;
}

function applyEvent(item, ev) {
  item.title = ev.title || "";
  item.setProperty("LOCATION", ev.location || "");
  if (ev.description) item.setProperty("DESCRIPTION", ev.description);
  else item.deleteProperty("DESCRIPTION");
  item.startDate = calDateTime(ev.start, ev.allDay);
  let end = ev.end;
  if (ev.allDay) {
    // the end of an all-day event is the day after its last
    const s = new Date(ev.start), e = new Date(ev.end);
    if (e.getFullYear() === s.getFullYear() && e.getMonth() === s.getMonth() && e.getDate() === s.getDate()) {
      end = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime();
    }
  }
  item.endDate = calDateTime(end, ev.allDay);
  item.setProperty("TRANSP", ev.showAs === "free" ? "TRANSPARENT" : "OPAQUE");

  // recurrence
  if (ev.recurrence && ev.recurrence.freq && ev.recurrence.freq !== "custom") {
    const info = new lazy.CalRecurrenceInfo(item);
    const rule = lazy.cal.createRecurrenceRule();
    rule.type = ev.recurrence.freq.toUpperCase();
    rule.interval = Math.max(1, ev.recurrence.interval || 1);
    if (ev.recurrence.count > 0) rule.count = ev.recurrence.count;
    else if (ev.recurrence.until) rule.untilDate = calDateTime(ev.recurrence.until, true);
    else rule.count = -1;
    if (rule.type === "WEEKLY" && ev.recurrence.byday && ev.recurrence.byday.length) {
      rule.setComponent("BYDAY", ev.recurrence.byday.map(d => DAYS.indexOf(d) + 1).filter(n => n > 0));
    }
    info.appendRecurrenceItem(rule);
    item.recurrenceInfo = info;
  } else if (!ev.recurrence || !ev.recurrence.freq) {
    item.recurrenceInfo = null;
  }

  // reminder
  item.clearAlarms();
  if (ev.reminder >= 0) {
    const alarm = new lazy.CalAlarm();
    alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
    alarm.offset = lazy.cal.createDuration();
    alarm.offset.inSeconds = -60 * ev.reminder;
    alarm.action = "DISPLAY";
    item.addAlarm(alarm);
  }

  // attendees: a meeting has an organizer (us) and its invitees
  item.removeAllAttendees();
  if (ev.attendees && ev.attendees.length) {
    const identity = ev.identityId ? MailServices.accounts.getIdentity(ev.identityId) : null;
    const orgEmail = (ev.organizer && ev.organizer.email) || (identity && identity.email);
    if (orgEmail) {
      const org = new lazy.CalAttendee();
      org.id = "mailto:" + orgEmail;
      org.commonName = (ev.organizer && ev.organizer.name) || (identity && identity.fullName) || "";
      org.role = "CHAIR";
      org.participationStatus = "ACCEPTED";
      org.isOrganizer = true;
      item.organizer = org;
    }
    for (const a of ev.attendees) {
      const att = new lazy.CalAttendee();
      att.id = "mailto:" + a.email;
      att.commonName = a.name || "";
      att.role = a.role || "REQ-PARTICIPANT";
      att.participationStatus = a.status || "NEEDS-ACTION";
      att.rsvp = "TRUE";
      att.userType = "INDIVIDUAL";
      item.addAttendee(att);
    }
  } else {
    item.organizer = null;
  }
}

// The iTIP state of messages shown in the reading pane: message id -> state
const itipStates = new Map();

// ---- conversations ----------------------------------------------------------------------

// the Message-IDs a message names: its own, and those it answers (References,
// or In-Reply-To when there are none: Thunderbird keeps them as one list)
function referencesOf(hdr) {
  const refs = [];
  for (let i = 0; i < hdr.numReferences; i++) {
    const r = hdr.getStringReference(i);
    if (r) refs.push(r);
  }
  return refs;
}

// the folders of an account a conversation is looked for in: all but
// Deleted Items, Junk Email and the Outbox (Sent Items is where one's own
// replies are)
function conversationFolders(server) {
  const skip = Ci.nsMsgFolderFlags.Trash | Ci.nsMsgFolderFlags.Junk | Ci.nsMsgFolderFlags.Queue | Ci.nsMsgFolderFlags.Virtual;
  return server.rootFolder.descendants.filter(f => !(f.flags & skip) && !f.noSelect);
}

// ---- tasks --------------------------------------------------------------------------------

function taskObject(item, calendar) {
  const status = item.status || "NONE";
  return {
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.getProperty("color") || "#0078d4",
    readOnly: !!calendar.readOnly,
    id: item.id,
    title: item.title || "",
    description: item.getProperty("DESCRIPTION") || "",
    start: jsDate(item.entryDate),
    due: jsDate(item.dueDate),
    completed: !!item.isCompleted,
    completedAt: jsDate(item.completedDate),
    percent: item.percentComplete || 0,
    status: item.getProperty("X-SGMAIL-STATUS") || status,
    priority: item.priority || 0,
    reminder: reminderOf(item),
  };
}

// a day as a calendar date (no time): tasks are due on days, as Outlook's
function calDate(ms) {
  return ms ? calDateTime(ms, true) : null;
}

// ---- free/busy ------------------------------------------------------------------------------

const FB_TYPES = { 0: "unknown", 1: "free", 2: "busy", 4: "unavailable", 8: "tentative" };

// one attendee's busy times from Thunderbird's free/busy providers (a
// CalDAV server with scheduling: the attendee's own calendar server)
function serverFreeBusy(email, start, end) {
  return new Promise(resolve => {
    const out = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(out);
    };
    try {
      lazy.cal.freeBusyService.getFreeBusyIntervals("mailto:" + email, start, end, Ci.calIFreeBusyInterval.BUSY_ALL, {
        QueryInterface: ChromeUtils.generateQI(["calIGenericOperationListener"]),
        onResult(op, result) {
          for (const iv of result || []) {
            const type = FB_TYPES[iv.freeBusyType] || "busy";
            if (type === "free" || type === "unknown") continue;
            out.push({ start: jsDate(iv.interval.start), end: jsDate(iv.interval.end), type });
          }
          if (!op || !op.isPending) finish();
        },
      });
    } catch (e) {
      console.error("sg-mail: free/busy", e);
      finish();
    }
    setTimeout(finish, 15000);
  });
}

// busy times from events: what Show As says (Free counts as nothing)
function busyFromEvents(items) {
  const out = [];
  for (const item of items) {
    if (item.getProperty("TRANSP") === "TRANSPARENT") continue;
    if (item.status === "CANCELLED") continue;
    const s = jsDate(item.startDate), e = jsDate(item.endDate || item.startDate);
    out.push({ start: s, end: Math.max(e, s), type: item.status === "TENTATIVE" ? "tentative" : "busy", title: "" });
  }
  return out;
}

// ---- WebDAV (shared calendars) ---------------------------------------------------------------

// the password Thunderbird keeps for a CalDAV server, for its user
async function davPassword(origin, username) {
  for (const l of await Services.logins.searchLoginsAsync({ origin })) {
    if (!username || l.username === username) return { username: l.username, password: l.password };
  }
  return null;
}

async function davRequest(url, method, body, auth, depth = "1") {
  const headers = { "Content-Type": "application/xml; charset=utf-8", Depth: depth };
  if (auth) headers.Authorization = "Basic " + btoa(unescape(encodeURIComponent(`${auth.username}:${auth.password}`)));
  const r = await fetch(url, { method, headers, body, credentials: "omit", cache: "no-store", redirect: "follow" });
  return { status: r.status, text: await r.text(), url: r.url };
}

const DAV = "DAV:", CALDAV = "urn:ietf:params:xml:ns:caldav", ICAL = "http://apple.com/ns/ical/";

// the collections a PROPFIND (depth 1) answered with: calendars, their names,
// colours and whether this user may write in them
function davCalendars(xml, base) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out = [];
  for (const resp of doc.getElementsByTagNameNS(DAV, "response")) {
    const href = resp.getElementsByTagNameNS(DAV, "href")[0]?.textContent || "";
    let ok = null;
    for (const ps of resp.getElementsByTagNameNS(DAV, "propstat")) {
      if (/\s200\s/.test(" " + (ps.getElementsByTagNameNS(DAV, "status")[0]?.textContent || "") + " ")) ok = ps;
    }
    if (!ok) continue;
    const rt = ok.getElementsByTagNameNS(DAV, "resourcetype")[0];
    if (!rt || !rt.getElementsByTagNameNS(CALDAV, "calendar").length) continue;
    const comps = [...ok.getElementsByTagNameNS(CALDAV, "comp")].map(c => (c.getAttribute("name") || "").toUpperCase());
    if (comps.length && !comps.includes("VEVENT")) continue;
    const privs = [...ok.getElementsByTagNameNS(DAV, "privilege")].map(p => p.firstElementChild?.localName || "");
    out.push({
      url: new URL(href, base).href,
      name: ok.getElementsByTagNameNS(DAV, "displayname")[0]?.textContent || decodeURIComponent(href.replace(/\/$/, "").split("/").pop()),
      color: (ok.getElementsByTagNameNS(ICAL, "calendar-color")[0]?.textContent || "").slice(0, 7),
      writable: privs.some(p => p === "write" || p === "write-content" || p === "all"),
      readable: !privs.length || privs.some(p => p === "read" || p === "all"),
    });
  }
  return out;
}

const PROPFIND_CALENDARS = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">' +
  "<D:prop><D:resourcetype/><D:displayname/><A:calendar-color/><D:current-user-privilege-set/><C:supported-calendar-component-set/></D:prop></D:propfind>";

// ---- ManageSieve (RFC 5804): automatic replies kept on the mail server ------------------------

const SIEVE_BEGIN = "# SG Mail: automatic replies (begin)";
const SIEVE_END = "# SG Mail: automatic replies (end)";

function sieveQuote(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// the vacation block SG Mail writes: the reply, from start to end (UTC), to
// each sender once a week, never to lists or other automatic mail
function sieveBlock(st, addresses) {
  const conds = [];
  if (st.start) conds.push(`currentdate :zone "+0000" :value "ge" "iso8601" ${sieveQuote(new Date(st.start).toISOString().slice(0, 19))}`);
  if (st.end) conds.push(`currentdate :zone "+0000" :value "lt" "iso8601" ${sieveQuote(new Date(st.end).toISOString().slice(0, 19))}`);
  const text = String(st.text || "").replace(/\r?\n/g, "\r\n");
  const lines = [
    SIEVE_BEGIN,
    "# sg-mail: " + JSON.stringify({ start: st.start || 0, end: st.end || 0, text: st.text || "" }),
    'require ["vacation", "date", "relational", "variables"];',
    'set "sgsubject" "";',
    'if header :matches "subject" "*" { set "sgsubject" "${1}"; }',
    `if allof(${["true", ...conds].join(", ")}) {`,
    `  vacation :days 7 :addresses [${addresses.map(sieveQuote).join(", ")}] :subject "Automatic reply: \${sgsubject}" text:`,
    ...text.split("\r\n").map(l => (l.startsWith(".") ? "." + l : l)),
    ".",
    ";",
    "}",
    SIEVE_END,
  ];
  return lines.join("\r\n") + "\r\n";
}

// a script without SG Mail's block, and the settings the block held
function sieveSplit(script) {
  const a = script.indexOf(SIEVE_BEGIN), b = script.indexOf(SIEVE_END);
  if (a < 0 || b < a) return { rest: script, settings: null };
  const block = script.slice(a, b);
  let settings = null;
  const m = block.match(/^# sg-mail: (.*)$/m);
  if (m) {
    try {
      settings = JSON.parse(m[1]);
    } catch (e) {
      settings = {};
    }
  }
  return { rest: script.slice(0, a) + script.slice(b + SIEVE_END.length).replace(/^\r?\n/, ""), settings };
}

// SG Mail's block in a script of the person's own: after its require lines
// (Sieve wants them first), the rest of their rules after it
function sieveMerge(rest, block) {
  const m = rest.match(/^(?:\s*(?:#[^\n]*\n|require\s+[^;]*;))*\s*/);
  const head = m ? m[0] : "";
  return head + (head && !head.endsWith("\n") ? "\r\n" : "") + block + rest.slice(head.length);
}

class SieveClient {
  constructor(host, port) {
    this.host = host;
    this.port = port;
    this.buffer = "";
    this.waiters = [];
  }

  open() {
    const TCP = globalThis.TCPSocket || mainWindow()?.TCPSocket;
    if (!TCP) throw new ExtensionError("No sockets here");
    return new Promise((resolve, reject) => {
      const s = new TCP(this.host, this.port, { binaryType: "string" });
      this.socket = s;
      const timer = setTimeout(() => reject(new ExtensionError("The server did not answer")), 15000);
      s.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      s.ondata = ev => {
        this.buffer += typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
        this.pump();
      };
      s.onerror = ev => {
        clearTimeout(timer);
        this.failed = ev?.name || "error";
        reject(new ExtensionError(`ManageSieve ${this.host}:${this.port}: ${ev?.message || ev?.name || "no connection"}`));
        this.pump();
      };
      s.onclose = () => {
        this.closed = true;
        this.pump();
      };
    });
  }

  // the server's answer to one command: its lines up to OK, NO or BYE
  // (with the literals {n} in them read whole)
  pump() {
    while (this.waiters.length) {
      const parsed = this.parse();
      if (!parsed) {
        if (this.closed || this.failed) this.waiters.shift().reject(new ExtensionError("The connection closed"));
        else return;
        continue;
      }
      this.waiters.shift().resolve(parsed);
    }
  }

  parse() {
    const lines = [];
    let pos = 0;
    const buf = this.buffer;
    while (true) {
      const nl = buf.indexOf("\r\n", pos);
      if (nl < 0) return null;
      let line = buf.slice(pos, nl);
      pos = nl + 2;
      const lit = line.match(/\{(\d+)\+?\}$/);
      if (lit) {
        // TCPSocket strings are bytes: the literal's length counts bytes
        const n = Number(lit[1]);
        if (buf.length < pos + n) return null;
        line = line.slice(0, -lit[0].length) + JSON.stringify(decodeURIComponent(escape(buf.slice(pos, pos + n))));
        pos += n;
        const nl2 = buf.indexOf("\r\n", pos);
        if (nl2 < 0) return null;
        line += buf.slice(pos, nl2);
        pos = nl2 + 2;
      }
      lines.push(line);
      if (/^(OK|NO|BYE)\b/i.test(line)) {
        this.buffer = buf.slice(pos);
        return { lines: lines.slice(0, -1), status: line.split(/\s/)[0].toUpperCase(), last: line };
      }
    }
  }

  read() {
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.pump();
      setTimeout(() => reject(new ExtensionError("The server did not answer")), 20000);
    });
  }

  async command(text) {
    this.socket.send(unescape(encodeURIComponent(text)) + "\r\n");
    const r = await this.read();
    if (r.status !== "OK") throw new ExtensionError(`ManageSieve: ${r.last.replace(/^NO\s*/i, "")}`);
    return r;
  }

  static literal(text) {
    const bytes = unescape(encodeURIComponent(text));
    return `{${bytes.length}+}\r\n${text}`;
  }

  capabilities(lines) {
    const caps = {};
    for (const l of lines) {
      const m = l.match(/^"([^"]+)"(?:\s+"(.*)")?$/);
      if (m) caps[m[1].toUpperCase()] = m[2] || "";
    }
    return caps;
  }

  async connect(username, password) {
    await this.open();
    let r = await this.read();
    let caps = this.capabilities(r.lines);
    const local = /^(127\.|localhost$|::1$)/.test(this.host);
    if ("STARTTLS" in caps) {
      await this.command("STARTTLS");
      this.socket.upgradeToSecure();
      r = await this.read();
      caps = this.capabilities(r.lines);
      this.secure = true;
    } else if (!local) {
      throw new ExtensionError("The server offers no encryption: SG Mail does not send the password unprotected");
    }
    if (!(caps.SIEVE || "").split(/\s+/).includes("vacation")) this.noVacation = true;
    const plain = btoa(unescape(encodeURIComponent(`\0${username}\0${password}`)));
    await this.command(`AUTHENTICATE "PLAIN" "${plain}"`);
    return caps;
  }

  async scripts() {
    const r = await this.command("LISTSCRIPTS");
    return r.lines.map(l => {
      const m = l.match(/^"((?:[^"\\]|\\.)*)"(\s+ACTIVE)?/i);
      return m ? { name: JSON.parse(`"${m[1]}"`), active: !!m[2] } : null;
    }).filter(Boolean);
  }

  async get(name) {
    const r = await this.command(`GETSCRIPT ${sieveQuote(name)}`);
    const l = r.lines.join("\n");
    try {
      return JSON.parse(l.slice(l.indexOf('"')));
    } catch (e) {
      return "";
    }
  }

  close() {
    try {
      this.socket.send("LOGOUT\r\n");
      this.socket.close();
    } catch (e) {
      // gone
    }
  }
}

// the ManageSieve server and login for an account: the IMAP server's host,
// its user and the password Thunderbird keeps for it
async function sieveFor(accountId, where) {
  const account = MailServices.accounts.getAccount(accountId);
  if (!account) throw new ExtensionError("No such account");
  const server = account.incomingServer;
  if (server.type !== "imap") throw new ExtensionError("Automatic replies on the server need an IMAP account");
  if (server.authMethod === Ci.nsMsgAuthMethod.OAuth2) throw new ExtensionError("This account signs in with its provider's page (OAuth2): SG Mail cannot reach its server's rules");
  let host = server.hostName, port = 4190;
  if (where) {
    const m = String(where).match(/^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/);
    if (m) {
      host = m[1];
      if (m[2]) port = Number(m[2]);
    }
  }
  let password = server.password;
  if (!password) {
    const l = await davPassword("imap://" + server.hostName, server.username);
    password = l && l.password;
  }
  if (!password) throw new ExtensionError("SG Mail does not know this account's password yet: get mail once first");
  const addresses = MailServices.accounts.getIdentitiesForServer(server).map(i => i.email).filter(Boolean);
  return { host, port, username: server.username, password, addresses };
}

this.sgmail = class extends ExtensionCommon.ExtensionAPI {
  onShutdown() {
    itipStates.clear();
  }

  getAPI(context) {
    const { extension } = context;

    function msgHdr(messageId) {
      const hdr = extension.messageManager.get(messageId);
      if (!hdr) throw new ExtensionError(`No message ${messageId}`);
      return hdr;
    }

    const sg = {
        async isActive() {
          return Services.prefs.getBoolPref("sgmail.profile", false);
        },

        async getEnv(name) {
          if (!/^SG_MAIL_[A-Z0-9_]+$/.test(name)) return null;
          return Services.env.exists(name) ? Services.env.get(name) : null;
        },

        async writeTestFile(name, text) {
          // only for the gates: SG_MAIL_TEST_OUT names their scratch directory
          const dir = Services.env.get("SG_MAIL_TEST_OUT");
          if (!dir || !/^[A-Za-z0-9._-]+$/.test(name)) return false;
          await IOUtils.writeUTF8(PathUtils.join(dir, name), text);
          return true;
        },

        async takeOverWindow(windowId, tabId) {
          const win = extension.windowManager.get(windowId, context).window;
          const doc = win.document;
          const root = doc.documentElement;
          if (!win.sgmailStyled) {
            win.windowUtils.loadSheetUsingURIString("data:text/css," + encodeURIComponent(CHROME_CSS), win.windowUtils.AUTHOR_SHEET);
            win.sgmailStyled = true;
          }
          root.setAttribute("sgmail", "true");
          // Ctrl+Q is Outlook's Mark as Read here, not Quit (File > Exit quits)
          for (const id of ["key_quitApplication"]) {
            const key = doc.getElementById(id);
            if (key) {
              key.removeAttribute("reserved");
              key.setAttribute("disabled", "true");
            }
          }

          const tabmail = doc.getElementById("tabmail");
          const nativeTab = extension.tabManager.get(tabId).nativeTab;
          if (nativeTab.tabNode) nativeTab.tabNode.setAttribute("sgmail-tab", "true");
          nativeTab.browser?.closest(".contentTabInstance")?.setAttribute("sgmail-panel", "true");
          const update = () => {
            // Thunderbird's own mail view is not shown: a tool tab closing
            // (account setup finished) comes back to SG Mail's
            if (tabmail.currentTabInfo?.mode?.name === "mail3PaneTab" && tabmail.tabInfo.includes(nativeTab)) {
              tabmail.switchToTab(nativeTab);
              return;
            }
            const own = tabmail.currentTabInfo === nativeTab;
            root.toggleAttribute("sgmail-own", own);
            // our page's title is the window's whole title ("Inbox - ... - SG Mail");
            // Thunderbird's tools get " - SG Mail" after theirs
            root.setAttribute("titlemodifier", own ? "" : "SG Mail");
            root.setAttribute("titlemenuseparator", own ? "" : " - ");
            // our page's title says where we are and ends in "SG Mail" itself
            const want = (nativeTab.title || "SG Mail").trim();
            if (own && doc.title !== want) doc.title = want;
            else tabmail.setDocumentTitle(tabmail.currentTabInfo);
          };
          if (!win.sgmailTabSelect) {
            tabmail.tabContainer.addEventListener("TabSelect", () => win.sgmailTabSelect());
            // tabmail retitles the window when a tab's title changes: ours again
            tabmail.addEventListener("pagetitlechanged", () => win.setTimeout(() => win.sgmailTabSelect(), 0));
          }
          win.sgmailTabSelect = () => {
            try {
              update();
            } catch (e) {
              // the tab is gone
            }
          };
          update();
          return true;
        },

        async showOwnTab(windowId, tabId) {
          const win = extension.windowManager.get(windowId, context).window;
          const tabmail = win.document.getElementById("tabmail");
          tabmail.switchToTab(extension.tabManager.get(tabId).nativeTab);
        },

        async openTool(name) {
          const win = mainWindow();
          if (!win) throw new ExtensionError("No main window");
          switch (name) {
            case "accountSetup":
              win.openAccountSetup();
              break;
            case "accountSettings":
              win.MsgAccountManager();
              break;
            case "options":
              win.openOptionsDialog();
              break;
            case "addressBook":
              win.toAddressBook();
              break;
            case "about":
              win.openAboutDialog();
              break;
            case "filters":
              win.MsgFilters();
              break;
            case "activity":
              win.openActivityMgr();
              break;
            case "newCalendar":
              win.cal.window.openCalendarWizard(win);
              break;
            default:
              throw new ExtensionError(`No tool ${name}`);
          }
          return true;
        },

        async getNewMail(folderId) {
          const win = mainWindow();
          if (!win) return false;
          if (Services.io.offline) return false;
          // each step on its own: one failing (an account that cannot be
          // reached) does not stop the others
          try {
            win.MsgGetMessagesForAllServers(null);
          } catch (e) {
            console.error("sg-mail: get messages", e);
          }
          if (folderId) {
            try {
              folderOf(folderId).updateFolder(win.msgWindow);
            } catch (e) {
              console.error("sg-mail: update folder", e);
            }
          }
          try {
            win.SendUnsentMessages();
          } catch (e) {
            console.error("sg-mail: send unsent", e);
          }
          return true;
        },

        async updateFolder(folderId) {
          const folder = folderOf(folderId);
          const win = mainWindow();
          if (Services.io.offline || folder.server.type === "none") return true;
          return new Promise(resolve => {
            const listener = {
              QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
              OnStartRunningUrl() {},
              OnStopRunningUrl(url, status) {
                resolve(Components.isSuccessCode(status));
              },
            };
            try {
              if (folder.server.type === "imap") {
                folder.QueryInterface(Ci.nsIMsgImapMailFolder).updateFolderWithListener(win ? win.msgWindow : null, listener);
              } else {
                folder.updateFolder(win ? win.msgWindow : null);
                resolve(true);
              }
            } catch (e) {
              resolve(false);
            }
            // a server that never answers must not hold the list
            setTimeout(() => resolve(false), 30000);
          });
        },

        async isOffline() {
          return Services.io.offline;
        },

        async setOffline(offline) {
          const win = mainWindow();
          if (offline !== Services.io.offline) {
            if (win && win.MailOfflineMgr) win.MailOfflineMgr.toggleOfflineStatus();
            else Services.io.offline = offline;
          }
          return Services.io.offline;
        },

        async sendMessage(details) {
          try {
            return await sg._sendMessage(details);
          } catch (e) {
            if (e instanceof ExtensionError) throw e;
            console.error("sg-mail: send", e);
            throw new ExtensionError(String(e && e.message || e) + (e && e.stack ? " @ " + e.stack.split("\n")[0] : ""));
          }
        },

        async _sendMessage(details) {
          const identity = MailServices.accounts.getIdentity(details.identityId);
          if (!identity) throw new ExtensionError("No such sender");
          const account = MailServices.accounts.getAccount(details.accountId) ||
            MailServices.accounts.findAccountForServer(MailServices.accounts.getServersForIdentity(identity)[0]);
          const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
          fields.from = identity.fullName ? MailServices.headerParser.makeMimeAddress(identity.fullName, identity.email) : identity.email;
          fields.to = details.to || "";
          fields.cc = details.cc || "";
          fields.bcc = details.bcc || "";
          fields.subject = details.subject || "";
          if (identity.replyTo) fields.replyTo = identity.replyTo;
          if (identity.organization) fields.organization = identity.organization;
          if (details.references) fields.references = details.references;
          if (details.priority) fields.priority = details.priority;
          // automatic replies say so (RFC 3834), and keep no copy in Sent Items
          for (const [k, v] of Object.entries(details.headers || {})) {
            if (/^(Auto-Submitted|X-Auto-Response-Suppress)$/i.test(k)) fields.setRawHeader(k, String(v));
          }
          if (details.noCopy) fields.fcc = "nocopy://";
          fields.useMultipartAlternative = true;
          const tmpFiles = [];
          for (const a of details.attachments || []) {
            const dir = PathUtils.join(PathUtils.tempDir, "sg-mail-" + Services.uuid.generateUUID().toString().slice(1, 9));
            await IOUtils.makeDirectory(dir);
            const safe = (a.name || "attachment").replace(/[\/\\\0]/g, "_");
            const path = PathUtils.join(dir, safe);
            await IOUtils.write(path, a.data instanceof ArrayBuffer ? new Uint8Array(a.data) : new Uint8Array(a.data));
            tmpFiles.push(dir);
            const att = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
            att.url = PathUtils.toFileURI(path);
            att.name = a.name || "attachment";
            att.contentType = a.contentType || "application/octet-stream";
            fields.addAttachment(att);
          }

          const modes = {
            now: Services.io.offline ? Ci.nsIMsgSend.nsMsgQueueForLater : Ci.nsIMsgSend.nsMsgDeliverNow,
            later: Ci.nsIMsgSend.nsMsgQueueForLater,
            draft: Ci.nsIMsgSend.nsMsgSaveAsDraft,
          };
          const mode = modes[details.mode || "now"];
          const compTypes = {
            new: Ci.nsIMsgCompType.New,
            reply: Ci.nsIMsgCompType.ReplyToSender,
            replyAll: Ci.nsIMsgCompType.ReplyAll,
            forward: Ci.nsIMsgCompType.ForwardInline,
            draft: Ci.nsIMsgCompType.Draft,
          };
          // the original may be gone meanwhile (Quick Steps: Reply & Delete)
          let original = null;
          try {
            original = details.originalMessageId ? msgHdr(details.originalMessageId) : null;
          } catch (e) {
            original = null;
          }
          const originalURI = original ? original.folder.getUriForMsg(original) : "";
          const replace = details.replaceDraftMessageId ? msgHdr(details.replaceDraftMessageId) : null;

          const send = Cc["@mozilla.org/messengercompose/send;1"].createInstance(Ci.nsIMsgSend);
          const result = await new Promise(resolve => {
            const listener = {
              QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener", "nsIMsgCopyServiceListener"]),
              onStartSending() {},
              onSendProgress() {},
              onStatus() {},
              onStopSending(msgId, status) {
                if (!Components.isSuccessCode(status)) resolve({ ok: false, error: `Sending failed (0x${(status >>> 0).toString(16)})` });
                else if (mode !== Ci.nsIMsgSend.nsMsgDeliverNow) resolve({ ok: true, messageId: msgId, queued: mode === Ci.nsIMsgSend.nsMsgQueueForLater });
                else if (details.noCopy) resolve({ ok: true, messageId: msgId, copied: false });
                else this.sent = msgId;
              },
              onGetDraftFolderURI() {},
              onSendNotPerformed(msgId, status) {
                resolve({ ok: false, error: "Not sent" });
              },
              onTransportSecurityError(msgId, status, secInfo, location) {
                resolve({ ok: false, error: "The server's certificate was not accepted: " + location });
              },
              // the copy to Sent finished (or failed): the send is complete
              onStartCopy() {},
              onProgress() {},
              setMessageKey() {},
              getMessageId() {
                return null;
              },
              onStopCopy(status) {
                resolve({ ok: true, messageId: this.sent || "", copied: Components.isSuccessCode(status) });
              },
            };
            send
              .createAndSendMessage(
                null, identity, account ? account.key : "", fields, false, false, mode, replace,
                "text/html", details.html || "", null, null, listener, "", originalURI,
                compTypes[details.compType || "new"] ?? Ci.nsIMsgCompType.New)
              .catch(e => resolve({ ok: false, error: String(e) }));
            // no copy to Sent configured: done when sent
            setTimeout(() => {
              if (listener.sent !== undefined) resolve({ ok: true, messageId: listener.sent, copied: false });
            }, 20000);
          });
          for (const dir of tmpFiles) IOUtils.remove(dir, { recursive: true }).catch(() => {});
          if (result.ok && original && mode !== Ci.nsIMsgSend.nsMsgSaveAsDraft) {
            const state = details.compType === "forward" ? Ci.nsIMsgFolder.nsMsgDispositionState_Forwarded : Ci.nsIMsgFolder.nsMsgDispositionState_Replied;
            if (details.compType !== "new" && details.compType !== "draft") original.folder.addMessageDispositionState(original, state);
          }
          if (result.ok && replace && mode !== Ci.nsIMsgSend.nsMsgSaveAsDraft) {
            // the draft it was written from goes when it is sent
            try {
              replace.folder.deleteMessages([replace], null, true, false, null, false);
            } catch (e) {
              console.error(e);
            }
          }
          return result;
        },

        async markDisposition(messageId, kind) {
          const hdr = msgHdr(messageId);
          hdr.folder.addMessageDispositionState(hdr, kind === "forwarded"
            ? Ci.nsIMsgFolder.nsMsgDispositionState_Forwarded : Ci.nsIMsgFolder.nsMsgDispositionState_Replied);
          return true;
        },

        async messageState(messageId) {
          const hdr = msgHdr(messageId);
          return {
            replied: !!(hdr.flags & Ci.nsMsgMessageFlags.Replied),
            forwarded: !!(hdr.flags & Ci.nsMsgMessageFlags.Forwarded),
          };
        },

        // what the message list shows beside the headers: the first words of
        // the text (Thunderbird makes them, fetching a little of the message
        // from an IMAP server), whether it has attachments, replied/forwarded
        async messageExtras(ids, fetch = true) {
          const byFolder = new Map();
          const hdrs = [];
          for (const id of ids) {
            let hdr;
            try {
              hdr = msgHdr(id);
            } catch (e) {
              continue;
            }
            hdrs.push([id, hdr]);
            if (fetch && !hdr.getStringProperty("preview")) {
              if (!byFolder.has(hdr.folder)) byFolder.set(hdr.folder, []);
              byFolder.get(hdr.folder).push(hdr.messageKey);
            }
          }
          if (!Services.io.offline) {
            await Promise.all([...byFolder].map(([folder, keys]) => new Promise(resolve => {
              try {
                const isAsync = folder.fetchMsgPreviewText(keys, {
                  OnStartRunningUrl() {},
                  OnStopRunningUrl() {
                    resolve();
                  },
                });
                if (!isAsync) resolve();
              } catch (e) {
                resolve();
              }
              setTimeout(resolve, 15000);
            })));
          }
          return hdrs.map(([id, hdr]) => ({
            id,
            preview: hdr.getStringProperty("preview") || "",
            attachment: !!(hdr.flags & Ci.nsMsgMessageFlags.Attachment),
            replied: !!(hdr.flags & Ci.nsMsgMessageFlags.Replied),
            forwarded: !!(hdr.flags & Ci.nsMsgMessageFlags.Forwarded),
            priority: hdr.priority,
            // Thunderbird keeps "Re:" apart from the subject
            hasRe: !!(hdr.flags & Ci.nsMsgMessageFlags.HasRe),
          }));
        },

        // what the Focused Inbox decides by, message by message: the
        // sender, whether SG Mail's person knows them (a contact, someone
        // they have written or replied to, themselves) and whether the
        // message is bulk mail (a mailing list's or a sender's newsletter
        // headers, kept in the message database: mailnews.customDBHeaders)
        async focusInfo(ids, fresh = false) {
          if (fresh) correspondents.at = 0;
          const known = knownCorrespondents();
          const mine = myIdentityEmails();
          const out = [];
          for (const id of ids) {
            let hdr;
            try {
              hdr = msgHdr(id);
            } catch (e) {
              continue;
            }
            const email = (MailServices.headerParser.extractHeaderAddressMailboxes(hdr.mime2DecodedAuthor || hdr.author) || "").split(",")[0].trim().toLowerCase();
            let knownBy = "";
            if (mine.has(email)) knownBy = "me";
            else if (email && hasContact(email)) knownBy = "contact";
            else if (known.has(email)) knownBy = "correspondent";
            else if (hdr.flags & Ci.nsMsgMessageFlags.Replied) knownBy = "correspondent";
            let bulk = "";
            const prop = n => hdr.getStringProperty(n) || "";
            const precedence = prop("precedence").toLowerCase();
            const auto = prop("auto-submitted").toLowerCase();
            if (prop("list-unsubscribe")) bulk = "list-unsubscribe";
            else if (prop("list-id")) bulk = "list-id";
            else if (/^(bulk|list|junk)$/.test(precedence)) bulk = "precedence";
            else if (auto && auto !== "no") bulk = "auto-submitted";
            else if (prop("feedback-id")) bulk = "feedback-id";
            else if (/^(no-?reply|do-?not-?reply|newsletters?|news|notifications?|notify|marketing|promotions?|mailer-daemon|bounces?)([+._-]|@)/.test(email)) bulk = "automated sender";
            out.push({ id, email, known: knownBy, bulk });
          }
          return out;
        },

        // Outlook's Rules > Always Move Messages From: a Thunderbird filter
        // on the account, run on new mail
        async createMoveRule(folderId, email, targetFolderId) {
          const folder = folderOf(folderId);
          const target = folderOf(targetFolderId);
          const list = folder.server.getFilterList(null);
          const name = `Always move messages from ${email}`;
          for (let i = 0; i < list.filterCount; i++) {
            if (list.getFilterAt(i).filterName === name) list.removeFilterAt(i--);
          }
          const filter = list.createFilter(name);
          const term = filter.createTerm();
          term.attrib = Ci.nsMsgSearchAttrib.Sender;
          term.op = Ci.nsMsgSearchOp.Contains;
          term.booleanAnd = true;
          const value = term.value;
          value.attrib = Ci.nsMsgSearchAttrib.Sender;
          value.str = email;
          term.value = value;
          filter.appendTerm(term);
          const action = filter.createAction();
          action.type = Ci.nsMsgFilterAction.MoveToFolder;
          action.targetFolderUri = target.URI;
          filter.appendAction(action);
          filter.filterType = Ci.nsMsgFilterType.InboxRule | Ci.nsMsgFilterType.Manual;
          filter.enabled = true;
          list.insertFilterAt(0, filter);
          list.saveToDefaultFile();
          return name;
        },

        async remoteContentAllowed(email) {
          // Thunderbird's own list of senders whose pictures may load
          if (!email) return false;
          const uri = Services.io.newURI("mailto:" + email);
          const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
          return Services.perms.testPermissionFromPrincipal(principal, "image") === Services.perms.ALLOW_ACTION;
        },

        async allowRemoteContent(email) {
          const uri = Services.io.newURI("mailto:" + email);
          const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {});
          Services.perms.addFromPrincipal(principal, "image", Services.perms.ALLOW_ACTION);
          return true;
        },

        // ---- calendar -------------------------------------------------------------

        async calendars() {
          return lazy.cal.manager.getCalendars().map(c => ({
            id: c.id,
            name: c.name,
            type: c.type,
            color: c.getProperty("color") || "#0078d4",
            readOnly: !!c.readOnly,
            disabled: !!c.getProperty("disabled"),
            identityKey: c.getProperty("imip.identity.key") || "",
            uri: c.uri ? c.uri.spec : "",
            // another person's calendar opened here (their address)
            shared: c.getProperty("sgmail.shared") || "",
            tasks: c.getProperty("capabilities.tasks.supported") !== false,
          }));
        },

        // Outlook always has a Calendar: a local one when there is none to write in
        async ensureCalendar() {
          const writable = lazy.cal.manager.getCalendars().filter(c => !c.readOnly && !c.getProperty("disabled") && !c.getProperty("sgmail.shared"));
          if (writable.length) return null;
          const c = lazy.cal.manager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
          c.name = "Calendar";
          c.setProperty("color", "#0f6cbd");
          c.setProperty("calendar-main-in-composite", true);
          const identity = MailServices.accounts.defaultAccount?.defaultIdentity;
          if (identity) c.setProperty("imip.identity.key", identity.key);
          lazy.cal.manager.registerCalendar(c);
          return c.id;
        },

        async calendarItems(calendarIds, startMs, endMs) {
          const start = lazy.cal.dtz.jsDateToDateTime(new Date(startMs), lazy.cal.dtz.defaultTimezone);
          const end = lazy.cal.dtz.jsDateToDateTime(new Date(endMs), lazy.cal.dtz.defaultTimezone);
          const filter = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
          const out = [];
          for (const id of calendarIds) {
            const calendar = lazy.cal.manager.getCalendarById(id);
            if (!calendar || calendar.getProperty("disabled")) continue;
            try {
              for (const item of await itemsOf(calendar, filter, start, end)) out.push(eventObject(item, calendar));
            } catch (e) {
              console.error("sg-mail: calendar", calendar.name, e);
            }
          }
          out.sort((a, b) => a.start - b.start);
          return out;
        },

        async calendarItem(calendarId, id, occurrence) {
          const calendar = calendarById(calendarId);
          let item = await masterItem(calendar, id);
          if (occurrence && item.recurrenceInfo) {
            item = item.recurrenceInfo.getOccurrenceFor(calDateTime(occurrence, false)) || item;
          }
          return eventObject(item, calendar);
        },

        async saveEvent(ev, options = {}) {
          const calendar = calendarById(ev.calendarId);
          if (calendar.readOnly) throw new ExtensionError("This calendar is read-only.");
          let item, old = null;
          if (ev.id && !options.asNew) {
            old = await masterItem(calendar, ev.id);
            if (ev.occurrence && !options.series && old.recurrenceInfo) {
              // one occurrence: an exception to the series
              const occ = old.recurrenceInfo.getOccurrenceFor(calDateTime(ev.occurrence, false));
              const exc = occ.clone();
              const evNoRec = Object.assign({}, ev, { recurrence: null });
              applyEvent(exc, evNoRec);
              exc.recurrenceInfo = null;
              const master = old.clone();
              master.recurrenceInfo.modifyException(exc, true);
              item = await calendar.modifyItem(master, old);
              if (options.sendInvitations) lazy.cal.itip.checkAndSend(Ci.calIOperationListener.MODIFY, item, old, { responseMode: Ci.calIItipItem.AUTO });
              return { calendarId: calendar.id, id: item.id };
            }
            item = old.clone();
            if (ev.recurrence && ev.recurrence.freq === "custom") ev = Object.assign({}, ev, { recurrence: { freq: "custom" } });
            applyEvent(item, ev);
          } else {
            item = new lazy.CalEvent();
            item.id = lazy.cal.getUUID();
            applyEvent(item, ev);
          }
          if (ev.identityId && item.getAttendees().length) {
            const identity = MailServices.accounts.getIdentity(ev.identityId);
            if (identity && !calendar.getProperty("imip.identity.key")) calendar.setProperty("imip.identity.key", identity.key);
          }
          // Thunderbird mails the invitations of items marked so
          if (options.sendInvitations && item.getAttendees().length) item.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
          const saved = old ? await calendar.modifyItem(item, old) : await calendar.addItem(item);
          if (options.sendInvitations && saved.getAttendees().length) {
            lazy.cal.itip.checkAndSend(old ? Ci.calIOperationListener.MODIFY : Ci.calIOperationListener.ADD, saved, old,
              { responseMode: Ci.calIItipItem.AUTO });
          }
          return { calendarId: calendar.id, id: saved.id };
        },

        async deleteEvent(calendarId, id, occurrence, options = {}) {
          const calendar = calendarById(calendarId);
          const item = await masterItem(calendar, id);
          if (occurrence && item.recurrenceInfo && !options.series) {
            const master = item.clone();
            master.recurrenceInfo.removeOccurrenceAt(calDateTime(occurrence, false));
            await calendar.modifyItem(master, item);
            return true;
          }
          await calendar.deleteItem(item);
          if (options.sendCancellations && item.getAttendees().length) {
            lazy.cal.itip.checkAndSend(Ci.calIOperationListener.DELETE, item, null, { responseMode: Ci.calIItipItem.AUTO });
          }
          return true;
        },

        // an event dragged to another time or day, or made longer or
        // shorter: only its times change. An occurrence of a series becomes
        // an exception to it, or the whole series moves by as much as the
        // occurrence moved (a weekly series follows to its new weekday).
        async moveEvent(calendarId, id, occurrence, change, options = {}) {
          const calendar = calendarById(calendarId);
          if (calendar.readOnly) throw new ExtensionError("This calendar is read-only.");
          const old = await masterItem(calendar, id);
          const allDay = !!(old.startDate && old.startDate.isDate);
          const setTimes = (item, start, end) => {
            if (allDay && end <= start) end = start + 86400000;
            item.startDate = calDateTime(start, allDay);
            item.endDate = calDateTime(end, allDay);
            // Thunderbird mails the update of items marked so
            if (options.sendInvitations && item.getAttendees().length > 0) item.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
          };
          let saved;
          if (occurrence && old.recurrenceInfo && !options.series) {
            const occ = old.recurrenceInfo.getOccurrenceFor(calDateTime(occurrence, allDay));
            if (!occ) throw new ExtensionError("No such occurrence");
            const exc = occ.clone();
            setTimes(exc, change.start, change.end);
            const master = old.clone();
            if (options.sendInvitations && master.getAttendees().length) master.setProperty("X-MOZ-SEND-INVITATIONS", "TRUE");
            master.recurrenceInfo.modifyException(exc, true);
            saved = await calendar.modifyItem(master, old);
          } else {
            const item = old.clone();
            if (occurrence && old.recurrenceInfo) {
              const from = change.origStart ?? occurrence;
              const start = jsDate(old.startDate) + (change.start - from);
              const shift = (new Date(start).getDay() - new Date(jsDate(old.startDate)).getDay() + 7) % 7;
              setTimes(item, start, start + (change.end - change.start));
              if (shift) {
                for (const r of item.recurrenceInfo.getRecurrenceItems()) {
                  if (!(r instanceof Ci.calIRecurrenceRule)) continue;
                  const days = r.getComponent("BYDAY");
                  if (days.length && days.every(d => d >= 1 && d <= 7)) r.setComponent("BYDAY", days.map(d => ((d - 1 + shift) % 7) + 1));
                }
              }
            } else {
              setTimes(item, change.start, change.end);
            }
            saved = await calendar.modifyItem(item, old);
          }
          if (options.sendInvitations && saved.getAttendees().length) {
            lazy.cal.itip.checkAndSend(Ci.calIOperationListener.MODIFY, saved, old, { responseMode: Ci.calIItipItem.AUTO });
          }
          return { calendarId: calendar.id, id: saved.id };
        },

        async calendarImport(calendarId, ics) {
          const calendar = calendarById(calendarId);
          const parser = Cc["@mozilla.org/calendar/ics-parser;1"].createInstance(Ci.calIIcsParser);
          parser.parseString(ics);
          let n = 0;
          for (const item of parser.getItems()) {
            if (!(item instanceof Ci.calIEvent) && !item.isEvent?.()) continue;
            const copy = item.clone();
            copy.calendar = calendar;
            const existing = await calendar.getItem(copy.id);
            if (existing) await calendar.modifyItem(copy, existing);
            else await calendar.addItem(copy);
            n++;
          }
          return n;
        },

        async calendarExport(calendarIds) {
          const serializer = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
          for (const id of calendarIds) {
            const calendar = calendarById(id);
            serializer.addItems(await itemsOf(calendar, Ci.calICalendar.ITEM_FILTER_TYPE_EVENT, null, null));
          }
          return serializer.serializeToString();
        },

        async itipInfo(messageId, ics, method) {
          const hdr = msgHdr(messageId);
          const itipItem = Cc["@mozilla.org/calendar/itip-item;1"].createInstance(Ci.calIItipItem);
          itipItem.init(ics);
          lazy.cal.itip.initItemFromMsgData(itipItem, method || "", hdr);
          const state = await new Promise(resolve => {
            lazy.cal.itip.processItipItem(itipItem, (item, rc, actionFunc, foundItems) => resolve({ itipItem: item, rc, actionFunc, foundItems }));
          });
          itipStates.set(messageId, state);
          const data = lazy.cal.itip.getOptionsText(state.itipItem, state.rc, state.actionFunc, state.foundItems);
          const buttons = new Set(data.showItems || []);
          const ev = state.itipItem.getItemList()[0];
          const actions = [];
          if (buttons.has("imipAcceptButton") || buttons.has("imipAcceptRecurrencesButton")) actions.push("accept");
          if (["imipTentativeButton", "imipTentativeRecurrencesButton", "imipAcceptButton_Tentative", "imipAcceptRecurrencesButton_Tentative"]
            .some(b => buttons.has(b))) actions.push("tentative");
          if (buttons.has("imipDeclineButton") || buttons.has("imipDeclineRecurrencesButton")) actions.push("decline");
          if (buttons.has("imipAddButton")) actions.push("add");
          if (buttons.has("imipUpdateButton")) actions.push("update");
          if (buttons.has("imipDeleteButton")) actions.push("delete");
          if (buttons.has("imipReconfirmButton")) actions.push("reconfirm");
          // the calendars it could go in (Thunderbird would ask with a dialog
          // of its own; SG Mail's reading pane offers the choice instead)
          const itip = lazy.cal.itip;
          let cals = lazy.cal.manager.getCalendars().filter(c => itip.isSchedulingCalendar(c) && !c.getProperty("disabled") && !c.readOnly);
          const matching = ev ? cals.filter(c => itip.getInvitedAttendee(ev, c) != null) : [];
          if (matching.length) cals = matching;
          // network calendars first: the account's own, rather than this computer's
          cals.sort((a, b) => (a.type === "storage") - (b.type === "storage"));
          return {
            calendars: cals.map(c => ({ id: c.id, name: c.name, color: c.getProperty("color") || "" })),
            method: state.itipItem.receivedMethod,
            label: data.label || "",
            actions,
            event: ev ? eventObject(ev, ev.calendar || { id: "", name: "", getProperty: () => null, readOnly: true }) : null,
          };
        },

        // ---- conversations --------------------------------------------------------

        // what puts messages in one conversation: their Message-IDs and the
        // ones they answer
        async conversationInfo(ids) {
          const out = [];
          for (const id of ids) {
            let hdr;
            try {
              hdr = msgHdr(id);
            } catch (e) {
              continue;
            }
            out.push({ id, msgid: hdr.messageId || "", refs: referencesOf(hdr) });
          }
          return out;
        },

        // the messages of a conversation anywhere in the account (Sent Items
        // too; not Deleted Items or Junk Email): those whose Message-ID is
        // one of msgids or that answer one, and so on
        async conversationMessages(folderId, msgids) {
          const server = folderOf(folderId).server;
          const want = new Set(msgids.filter(Boolean));
          const found = new Map();
          const folders = conversationFolders(server);
          for (let pass = 0; pass < 3; pass++) {
            const before = want.size;
            for (const folder of folders) {
              let db;
              try {
                db = folder.msgDatabase;
              } catch (e) {
                continue;
              }
              if (!db) continue;
              let n = 0;
              for (const hdr of db.enumerateMessages()) {
                if (++n > 50000) break;
                const key = folder.URI + "#" + hdr.messageKey;
                if (found.has(key)) continue;
                const refs = referencesOf(hdr);
                if (want.has(hdr.messageId) || refs.some(r => want.has(r))) {
                  found.set(key, hdr);
                  want.add(hdr.messageId);
                  for (const r of refs) want.add(r);
                }
              }
            }
            if (want.size === before) break;
          }
          const out = [];
          for (const hdr of found.values()) {
            try {
              const m = extension.messageManager.convert(hdr);
              out.push({ id: m.id, msgid: hdr.messageId, refs: referencesOf(hdr), sent: !!(hdr.folder.flags & Ci.nsMsgFolderFlags.SentMail),
                folderId: m.folder ? m.folder.id : "", folderName: hdr.folder.prettyName, date: hdr.date / 1000 });
            } catch (e) {
              // not one the extension can see
            }
          }
          out.sort((a, b) => a.date - b.date);
          return out;
        },

        // ---- tasks (Thunderbird's calendar tasks: VTODO) ---------------------------

        async taskItems(calendarIds, includeCompleted = true) {
          const filter = Ci.calICalendar.ITEM_FILTER_TYPE_TODO |
            (includeCompleted ? Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL : Ci.calICalendar.ITEM_FILTER_COMPLETED_NO);
          const out = [];
          for (const id of calendarIds) {
            const calendar = lazy.cal.manager.getCalendarById(id);
            if (!calendar || calendar.getProperty("disabled")) continue;
            if (calendar.getProperty("capabilities.tasks.supported") === false) continue;
            try {
              for (const item of await itemsOf(calendar, filter, null, null)) out.push(taskObject(item, calendar));
            } catch (e) {
              console.error("sg-mail: tasks", calendar.name, e);
            }
          }
          return out;
        },

        async saveTask(task) {
          const calendar = calendarById(task.calendarId);
          if (calendar.readOnly) throw new ExtensionError("This task list is read-only.");
          let old = null, item;
          if (task.id) {
            old = await calendar.getItem(task.id);
            if (!old) throw new ExtensionError(`No task ${task.id}`);
            item = old.clone();
          } else {
            item = new lazy.CalTodo();
            item.id = lazy.cal.getUUID();
          }
          if ("title" in task) item.title = task.title || "";
          if ("description" in task) {
            if (task.description) item.setProperty("DESCRIPTION", task.description);
            else item.deleteProperty("DESCRIPTION");
          }
          if ("start" in task) item.entryDate = calDate(task.start);
          if ("due" in task) item.dueDate = calDate(task.due);
          if ("priority" in task) item.priority = task.priority || 0;
          if ("status" in task || "completed" in task || "percent" in task) {
            let status = task.status || (task.completed ? "COMPLETED" : item.status || "NEEDS-ACTION");
            if (task.completed === false && status === "COMPLETED") status = "NEEDS-ACTION";
            // Outlook's Waiting on someone else and Deferred: kept beside the iCalendar status
            if (status === "WAITING" || status === "DEFERRED") {
              item.setProperty("X-SGMAIL-STATUS", status);
              status = "NEEDS-ACTION";
            } else {
              item.deleteProperty("X-SGMAIL-STATUS");
            }
            if (status === "COMPLETED") {
              item.isCompleted = true;
              item.completedDate = lazy.cal.dtz.jsDateToDateTime(new Date(), lazy.cal.dtz.defaultTimezone);
              item.percentComplete = 100;
              item.status = "COMPLETED";
            } else {
              item.isCompleted = false;
              item.completedDate = null;
              item.status = status === "NONE" ? null : status;
              item.percentComplete = Math.max(0, Math.min(99, task.percent ?? (status === "IN-PROCESS" ? Math.max(1, item.percentComplete) : 0)));
            }
          }
          if ("reminder" in task) {
            item.clearAlarms();
            if (task.reminder >= 0 && item.dueDate) {
              const alarm = new lazy.CalAlarm();
              alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
              alarm.offset = lazy.cal.createDuration();
              alarm.offset.inSeconds = -60 * task.reminder;
              alarm.action = "DISPLAY";
              item.addAlarm(alarm);
            }
          }
          const saved = old ? await calendar.modifyItem(item, old) : await calendar.addItem(item);
          return { calendarId: calendar.id, id: saved.id };
        },

        async deleteTask(calendarId, id) {
          const calendar = calendarById(calendarId);
          const item = await calendar.getItem(id);
          if (item) await calendar.deleteItem(item);
          return true;
        },

        // ---- free/busy: the Scheduling Assistant -------------------------------------

        // each attendee's busy times in a range: one's own calendars; the
        // calendars of theirs this person has opened (shared calendars); the
        // attendee's calendar server where it offers free/busy (CalDAV
        // scheduling). Nothing known: "no information".
        async freeBusy(emails, startMs, endMs) {
          const start = lazy.cal.dtz.jsDateToDateTime(new Date(startMs), lazy.cal.dtz.defaultTimezone);
          const end = lazy.cal.dtz.jsDateToDateTime(new Date(endMs), lazy.cal.dtz.defaultTimezone);
          const mine = myIdentityEmails();
          const filter = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
          const calendars = lazy.cal.manager.getCalendars().filter(c => !c.getProperty("disabled"));
          const out = [];
          for (const raw of emails) {
            const email = String(raw || "").toLowerCase();
            if (!email) continue;
            let intervals = [], sources = [];
            const own = mine.has(email) ? calendars.filter(c => !c.getProperty("sgmail.shared")) :
              calendars.filter(c => (c.getProperty("sgmail.shared") || "").toLowerCase() === email);
            for (const c of own) {
              try {
                intervals.push(...busyFromEvents(await itemsOf(c, filter, start, end)));
                if (!sources.includes("calendar")) sources.push("calendar");
              } catch (e) {
                console.error("sg-mail: free/busy of", c.name, e);
              }
            }
            if (!mine.has(email)) {
              const server = await serverFreeBusy(email, start, end);
              if (server.length) {
                intervals.push(...server);
                sources.push("server");
              }
            }
            intervals = intervals.filter(iv => iv.end > startMs && iv.start < endMs).sort((a, b) => a.start - b.start);
            out.push({ email, known: sources.length > 0, sources, intervals });
          }
          return out;
        },

        // ---- shared and delegated calendars --------------------------------------------

        // another person's calendars on the CalDAV server one's own calendar
        // is on, that this person may read: their calendar home found the way
        // servers lay them out (one's own user in the path, theirs instead)
        async findSharedCalendars(email) {
          try {
            return await sg._findSharedCalendars(email);
          } catch (e) {
            if (e instanceof ExtensionError) throw e;
            console.error("sg-mail: shared calendars", e);
            throw new ExtensionError(String(e && e.message || e));
          }
        },

        async _findSharedCalendars(email) {
          email = String(email || "").trim();
          if (!email) throw new ExtensionError("Type a name or an address");
          const local = email.split("@")[0];
          const mineCals = lazy.cal.manager.getCalendars().filter(c => c.type === "caldav" && !c.getProperty("sgmail.shared"));
          if (!mineCals.length) throw new ExtensionError("Shared calendars are opened from your calendar's server (CalDAV); you have no calendar there");
          const tried = new Set();
          const found = [];
          let lastError = "";
          for (const c of mineCals) {
            const uri = new URL(c.uri.spec);
            const user = c.getProperty("username") || "";
            const auth = await davPassword(uri.origin, user);
            if (!auth) {
              lastError = `SG Mail does not know the password for ${uri.host}`;
              continue;
            }
            const segs = uri.pathname.split("/");
            const candidates = [];
            const names = [user, user.split("@")[0]].filter(Boolean);
            for (let i = 0; i < segs.length; i++) {
              const seg = decodeURIComponent(segs[i]);
              if (!names.includes(seg)) continue;
              const theirs = seg.includes("@") ? email : local;
              const head = segs.slice(0, i).join("/") + "/" + encodeURIComponent(theirs).replace(/%40/g, "@") + "/";
              candidates.push(head);
              // DavMail and others: the person's calendar folder under their home
              if (segs[i + 1]) candidates.push(head + segs[i + 1] + "/");
            }
            candidates.push(`/users/${email}/calendar/`, `/${email}/`, `/${local}/`);
            for (const path of candidates) {
              const url = uri.origin + path;
              if (tried.has(url)) continue;
              tried.add(url);
              try {
                const r = await davRequest(url, "PROPFIND", PROPFIND_CALENDARS, auth, "1");
                if (r.status === 207) {
                  for (const cal of davCalendars(r.text, url)) {
                    if (cal.readable && !found.some(f => f.url === cal.url)) found.push(Object.assign(cal, { username: auth.username }));
                  }
                } else if (r.status === 403) {
                  lastError = `${email} has not shared a calendar with you`;
                }
              } catch (e) {
                lastError = String(e.message || e);
              }
              if (found.length) break;
            }
            if (found.length) break;
          }
          return { calendars: found, error: found.length ? "" : (lastError || `No calendar of ${email} was found that you may open`) };
        },

        async openSharedCalendar(info) {
          const existing = lazy.cal.manager.getCalendars().find(c => c.uri && c.uri.spec === info.url);
          if (existing) return existing.id;
          const c = lazy.cal.manager.createCalendar("caldav", Services.io.newURI(info.url));
          c.name = info.name;
          c.setProperty("color", info.color || "#8764b8");
          c.setProperty("username", info.username || "");
          c.setProperty("sgmail.shared", String(info.owner || "").toLowerCase());
          c.setProperty("cache.enabled", true);
          if (!info.writable) c.readOnly = true;
          // no invitations sent or answered from another person's calendar
          c.setProperty("imip.identity.disabled", true);
          lazy.cal.manager.registerCalendar(c);
          return c.id;
        },

        async removeCalendar(calendarId) {
          const c = calendarById(calendarId);
          lazy.cal.manager.unregisterCalendar(c);
          return true;
        },

        // ---- automatic replies on the server (ManageSieve) -----------------------------

        // whether the account's server keeps automatic replies (ManageSieve
        // with vacation), and the ones SG Mail set there
        async sieveStatus(accountId, where) {
          let s;
          try {
            s = await sieveFor(accountId, where);
          } catch (e) {
            return { available: false, error: e.message };
          }
          const client = new SieveClient(s.host, s.port);
          try {
            await client.connect(s.username, s.password);
            if (client.noVacation) return { available: false, error: "The server's rules cannot send automatic replies (no Sieve vacation)" };
            const scripts = await client.scripts();
            const active = scripts.find(x => x.active);
            let settings = null;
            if (active) settings = sieveSplit(await client.get(active.name)).settings;
            return { available: true, server: `${s.host}:${s.port}`, secure: !!client.secure, script: active ? active.name : "", on: !!settings, settings };
          } catch (e) {
            return { available: false, error: e.message };
          } finally {
            client.close();
          }
        },

        // set (or take away) SG Mail's automatic reply in the account's
        // active Sieve script, leaving the person's own rules as they are
        async sieveSetVacation(accountId, where, settings) {
          const s = await sieveFor(accountId, where);
          const client = new SieveClient(s.host, s.port);
          try {
            await client.connect(s.username, s.password);
            if (client.noVacation) throw new ExtensionError("The server's rules cannot send automatic replies (no Sieve vacation)");
            const scripts = await client.scripts();
            const active = scripts.find(x => x.active);
            const name = active ? active.name : "sg-mail";
            const { rest } = sieveSplit(active ? await client.get(active.name) : "");
            const script = settings && settings.on ? sieveMerge(rest, sieveBlock(settings, s.addresses)) : rest;
            await client.command(`CHECKSCRIPT ${SieveClient.literal(script)}`);
            await client.command(`PUTSCRIPT ${sieveQuote(name)} ${SieveClient.literal(script)}`);
            if (!active) await client.command(`SETACTIVE ${sieveQuote(name)}`);
            return { ok: true, script: name };
          } finally {
            client.close();
          }
        },

        onCalendarChanged: new ExtensionCommon.EventManager({
          context,
          name: "sgmail.onCalendarChanged",
          register: fire => {
            let pending = null;
            const changed = () => {
              // a calendar loading adds its items one by one: one event for them
              if (pending) return;
              pending = setTimeout(() => {
                pending = null;
                fire.async();
              }, 300);
            };
            const observer = {
              QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
              onStartBatch() {},
              onEndBatch: changed,
              onLoad: changed,
              onAddItem: changed,
              onModifyItem: changed,
              onDeleteItem: changed,
              onError() {},
              onPropertyChanged: changed,
              onPropertyDeleting() {},
            };
            const managerObserver = {
              QueryInterface: ChromeUtils.generateQI(["calICalendarManagerObserver"]),
              onCalendarRegistered: changed,
              onCalendarUnregistering: changed,
              onCalendarDeleting() {},
            };
            lazy.cal.manager.addCalendarObserver(observer);
            lazy.cal.manager.addObserver(managerObserver);
            return () => {
              lazy.cal.manager.removeCalendarObserver(observer);
              lazy.cal.manager.removeObserver(managerObserver);
            };
          },
        }).api(),

        onAlarm: new ExtensionCommon.EventManager({
          context,
          name: "sgmail.onAlarm",
          register: fire => {
            const service = Cc["@mozilla.org/calendar/alarm-service;1"].getService(Ci.calIAlarmService);
            const observer = {
              QueryInterface: ChromeUtils.generateQI(["calIAlarmServiceObserver"]),
              onAlarm(item) {
                try {
                  fire.async(eventObject(item, item.calendar));
                } catch (e) {
                  console.error(e);
                }
              },
              onNotification() {},
              onRemoveAlarmsByItem() {},
              onRemoveAlarmsByCalendar() {},
              onAlarmsLoaded() {},
            };
            service.addObserver(observer);
            return () => service.removeObserver(observer);
          },
        }).api(),

        // the gates' channel (only when Thunderbird runs under one: SG_MAIL_TEST_OUT)
        onTestRun: new ExtensionCommon.EventManager({
          context,
          name: "sgmail.onTestRun",
          register: fire => {
            if (!Services.env.get("SG_MAIL_TEST_OUT")) return () => {};
            const observer = (subject, topic, data) => fire.async(JSON.parse(data));
            Services.obs.addObserver(observer, "sgmail-test-run");
            return () => Services.obs.removeObserver(observer, "sgmail-test-run");
          },
        }).api(),

        async testReply(id, reply) {
          if (!Services.env.get("SG_MAIL_TEST_OUT")) return false;
          Services.obs.notifyObservers(null, "sgmail-test-reply", JSON.stringify(Object.assign({ id }, reply)));
          return true;
        },

        async itipRespond(messageId, action, sendReply = true, calendarId = null) {
          const state = itipStates.get(messageId);
          if (!state) throw new ExtensionError("The invitation is not loaded");
          const partstats = { accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED", add: "", update: "", delete: "", reconfirm: "" };
          if (!(action in partstats)) throw new ExtensionError(`No action ${action}`);
          const win = mainWindow();
          let label = "";
          // the calendar the reading pane chose, instead of Thunderbird's dialog
          const itip = lazy.cal.itip;
          const prompt = itip.promptCalendar;
          const chosen = calendarId ? lazy.cal.manager.getCalendarById(calendarId) : null;
          if (chosen) {
            itip.promptCalendar = (method, item) => {
              item.targetCalendar = chosen;
              return true;
            };
          }
          const ok = await new Promise(resolve => {
            const done = lazy.cal.itip.executeAction(win, partstats[action], sendReply ? "AUTO" : "NONE", state.actionFunc,
              state.itipItem, state.foundItems, (r) => {
                if (r && r.label !== undefined) {
                  label = r.label;
                  resolve(true);
                }
              });
            if (!done) resolve(false);
            setTimeout(() => resolve(done), 15000);
          }).finally(() => {
            itip.promptCalendar = prompt;
          });
          return { ok, label };
        },
    };
    return { sgmail: sg };
  }
};
