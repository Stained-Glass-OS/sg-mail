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
for (const name of ["fetch", "DOMParser", "TextDecoder", "btoa", "URL", "AbortController"]) {
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

// ---- Microsoft calendars and contacts: DavMail ----------------------------------------------
//
// No Thunderbird release reads or writes Microsoft 365 / Outlook.com /
// Exchange calendars and contacts yet. DavMail (package sg-davmail) does: a
// gateway on this computer that talks Microsoft Graph (or an Exchange
// server's EWS) and offers CalDAV and CardDAV on 127.0.0.1; Thunderbird's own
// CalDAV calendar and CardDAV address book use it. One gateway per account,
// a systemd user service (sg-mail-davmail@NAME), set up by our helper
// (/usr/lib/sg-mail/sg-mail-davmail). The sign-in to Microsoft is DavMail's:
// a short-lived sign-in gateway whose first request opens DavMail's own
// sign-in window; the token it gets is DavMail's, in DavMail's token file,
// encrypted with a password SG Mail makes up for the account and keeps in
// Thunderbird's password manager (the password Thunderbird gives the
// gateway). SG Mail never sees a Microsoft password or token.

const DAVMAIL_REALM = "DavMail Gateway";      // DavMail's Basic realm (Thunderbird looks logins up by it)
const DAVMAIL_PREF = "sgmail.davmail.";       // + account key: what we set up for it (JSON)
const signIns = new Map();                    // account key -> { proc, abort }

function davmailHelper() {
  return Services.env.get("SG_MAIL_DAVMAIL_HELPER") || "/usr/lib/sg-mail/sg-mail-davmail";
}

// "microsoft" (Microsoft 365, Outlook.com: Microsoft Graph), "exchange" (an
// Exchange server's EWS), or null
const MS_DOMAINS = /^(outlook|hotmail|live|msn|passport|windowslive)\.[a-z.]+$/i;
// (an incoming server's host is .hostName on 140, .hostname on 157)
const MS_HOSTS = /(^|\.)(outlook\.office365\.com|outlook\.office\.com|outlook\.com|office365\.com)$/i;
function microsoftKind(account) {
  const server = account.incomingServer;
  const email = account.defaultIdentity?.email || "";
  if (!server || !email) return null;
  // another mailbox opened through a gateway ("OWN/MAILBOX"): its owner's
  if ((server.username || "").includes("/")) return null;
  if (server.type === "graph") return { kind: "microsoft", url: "" };
  if (server.type === "ews") {
    const url = server.getStringValue("ews_url") || "";
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch (e) {
      // no URL: an Exchange account set up some other way
    }
    if (!host || MS_HOSTS.test(host)) return { kind: "microsoft", url: "" };
    return { kind: "exchange", url };
  }
  if (["imap", "pop3"].includes(server.type) && MS_HOSTS.test(server.hostname || server.hostName || "")) return { kind: "microsoft", url: "" };
  if (MS_DOMAINS.test(email.split("@")[1] || "")) return { kind: "microsoft", url: "" };
  return null;
}

// the gateway's name (a systemd instance name: letters, digits, . _ -)
function davmailName(email) {
  return email.toLowerCase().replace("@", "-at-").replace(/[^a-z0-9._-]/g, "_");
}

function davmailLink(key) {
  try {
    return JSON.parse(Services.prefs.getStringPref(DAVMAIL_PREF + key, ""));
  } catch (e) {
    return null;
  }
}

async function runHelper(args, { allowFail = false } = {}) {
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const proc = await Subprocess.call({ command: davmailHelper(), arguments: args, stderr: "stdout", environmentAppend: true });
  let out = "";
  let chunk;
  while ((chunk = await proc.stdout.readString())) out += chunk;
  const { exitCode } = await proc.wait();
  if (exitCode !== 0 && !allowFail) throw new ExtensionError((out.trim() || `sg-mail-davmail ${args[0]} failed`).slice(0, 400));
  return out;
}

function davmailOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

// A request to a gateway, as Thunderbird's CalDAV client makes them:
// { status, text } or { status: 0, text: why } when nothing answers
async function davmailRequest(port, email, password, { signal, path = "calendar/", user = email } = {}) {
  const url = `${davmailOrigin(port)}/users/${email}/${path}`;
  try {
    const r = await fetch(url, {
      method: "PROPFIND",
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8",
        Authorization: "Basic " + btoa(unescape(encodeURIComponent(user + ":" + password))) },
      body: '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:displayname/></D:prop></D:propfind>',
      credentials: "omit",
      cache: "no-store",
      signal,
    });
    return { status: r.status, text: (await r.text()).slice(0, 600) };
  } catch (e) {
    return { status: 0, text: String(e && e.message || e) };
  }
}

// Thunderbird 157 removes logins asynchronously only; 140 has both
function removeLogin(login) {
  return Services.logins.removeLoginAsync ? Services.logins.removeLoginAsync(login) : Services.logins.removeLogin(login);
}

async function davmailPassword(port, email) {
  const logins = await Services.logins.searchLoginsAsync({ origin: davmailOrigin(port), httpRealm: DAVMAIL_REALM });
  return logins.find(l => l.username === email)?.password || null;
}

// a login of Thunderbird's password manager, replacing one for the same
// origin, realm and user (a password kept from before would be the wrong one)
async function storeLogin(origin, realm, user, password) {
  for (const l of await Services.logins.searchLoginsAsync({ origin, httpRealm: realm })) {
    if (l.username === user) await removeLogin(l);
  }
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  login.init(origin, null, realm, user, password, "", "");
  await Services.logins.addLoginAsync(login);
}

function storeDavmailPassword(port, email, password) {
  return storeLogin(davmailOrigin(port), DAVMAIL_REALM, email, password);
}

function randomPassword() {
  const bytes = Cc["@mozilla.org/security/random-generator;1"].getService(Ci.nsIRandomGenerator).generateRandomBytes(24);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// What a gateway's answer means for the person
function davmailState(r) {
  if (r.status === 207 || r.status === 200) return { state: "ok", detail: "" };
  if (r.status === 0) return { state: "stopped", detail: r.text };
  if (r.status === 401) return { state: "password", detail: "" };
  if (/refresh token|authentication|sign.?in|AADSTS|invalid_grant|interaction_required|expired/i.test(r.text)) return { state: "signin", detail: r.text };
  if (/network interfaces down|host unreachable|UnknownHost|network down/i.test(r.text)) return { state: "offline", detail: r.text };
  return { state: "error", detail: `${r.status} ${r.text}`.trim() };
}

// DavMail's sign-in: a sign-in gateway of the helper's, and one request to
// it (Thunderbird's own password) that DavMail answers once its sign-in
// window is done. { ok, cancelled, error }
async function davmailSignIn(key, link, password) {
  if (signIns.has(key)) throw new ExtensionError("A sign-in for this account is already open");
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const abort = new AbortController();
  const proc = await Subprocess.call({ command: davmailHelper(), arguments: ["signin", link.name], stderr: "stdout", environmentAppend: true });
  const entry = { proc, abort, cancelled: false };
  signIns.set(key, entry);
  let out = "";
  let ended = false;
  // what it says (its port, then its log), read all along so it never
  // blocks on a full pipe
  (async () => {
    let c;
    try {
      while ((c = await proc.stdout.readString())) out = (out + c).slice(-8000);
    } catch (e) {
      // it ended
    }
    ended = true;
  })();
  try {
    let port = null;
    const deadline = Date.now() + 30000;
    while (!port && !ended && !entry.cancelled && Date.now() < deadline) {
      const m = /port=(\d+)/.exec(out);
      if (m) port = Number(m[1]);
      else await new Promise(res => setTimeout(res, 200));
    }
    if (entry.cancelled) return { ok: false, cancelled: true };
    if (!port) return { ok: false, error: (out.trim() || "DavMail's sign-in did not start").slice(0, 400) };
    // up when it listens (Java takes a moment); then the one request
    let r = { status: 0, text: "" };
    for (let i = 0; i < 120 && !entry.cancelled && !ended; i++) {
      r = await davmailRequest(port, link.email, password, { signal: abort.signal });
      if (r.status !== 0) break;
      await new Promise(res => setTimeout(res, 500));
    }
    if (entry.cancelled) return { ok: false, cancelled: true };
    if (r.status === 0) return { ok: false, error: (out.trim().split("\n").slice(-3).join("\n") || "DavMail's sign-in ended").slice(0, 400) };
    const st = davmailState(r);
    if (st.state === "ok") return { ok: true };
    return { ok: false, error: st.detail || `DavMail answered ${r.status}`, state: st.state };
  } finally {
    signIns.delete(key);
    try {
      await proc.kill(3000);
    } catch (e) {
      // gone already
    }
  }
}

// the gateway answering (any HTTP answer), once its service has started:
// DavMail takes a few seconds to listen
async function waitForGateway(port, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    try {
      // OPTIONS: answered without signing anyone in
      await fetch(`${davmailOrigin(port)}/`, { method: "OPTIONS", credentials: "omit", cache: "no-store" });
      return true;
    } catch (e) {
      // not listening yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// the address book's first sync, again a few times if the gateway is not
// up yet (it would otherwise wait for Thunderbird's next sync, 30 minutes)
async function firstContactsSync(fileName) {
  const { CardDAVDirectory } = ChromeUtils.importESModule("resource:///modules/CardDAVDirectory.sys.mjs");
  for (let i = 0; i < 6; i++) {
    try {
      await CardDAVDirectory.forFile(fileName).fetchAllFromServer();
      return;
    } catch (e) {
      console.error("sg-mail: contacts", e);
      await new Promise(r => setTimeout(r, 10000));
    }
  }
}

// Thunderbird's CalDAV calendar and CardDAV address book on the gateway
function createDavmailCollections(key, link, account) {
  const base = `${davmailOrigin(link.port)}/users/${link.email}`;
  const calendars = [];
  const known = lazy.cal.manager.getCalendars().find(c => c.getProperty("sgmail.davmail") === key);
  if (!known) {
    const c = lazy.cal.manager.createCalendar("caldav", Services.io.newURI(base + "/calendar/"));
    c.name = `Calendar (${link.email})`;
    c.setProperty("color", "#0078d4");
    c.setProperty("username", link.user || link.email);
    c.setProperty("cache.enabled", true);
    c.setProperty("calendar-main-in-composite", true);
    c.setProperty("sgmail.davmail", key);
    if (account.defaultIdentity) c.setProperty("imip.identity.key", account.defaultIdentity.key);
    lazy.cal.manager.registerCalendar(c);
    calendars.push(c.id);
  } else {
    calendars.push(known.id);
  }
  const books = [];
  const knownBook = MailServices.ab.directories.find(d => d.getStringValue("sgmail.davmail", "") === key);
  if (!knownBook) {
    const prefId = MailServices.ab.newAddressBook(`Contacts (${link.email})`, null, Ci.nsIAbManager.CARDDAV_DIRECTORY_TYPE, null);
    const book = MailServices.ab.getDirectoryFromId(prefId);
    book.setStringValue("carddav.url", base + "/contacts/");
    book.setStringValue("carddav.username", link.user || link.email);
    book.setStringValue("sgmail.davmail", key);
    firstContactsSync(book.fileName);
    books.push(book.UID);
  } else {
    books.push(knownBook.UID);
  }
  // the organisation's directory (DavMail's LDAP gateway: Microsoft's people
  // search), for finding colleagues by name: Open Shared Calendar, Team
  // groups, addresses typed in a message
  if (link.ldap && !MailServices.ab.directories.some(d => d.getStringValue("sgmail.davmail.ldap", "") === key)) {
    try {
      const url = davmailLdapUrl(link);
      const prefId = MailServices.ab.newAddressBook(`Directory (${link.email})`, url, Ci.nsIAbManager.LDAP_DIRECTORY_TYPE, null);
      const dir = MailServices.ab.getDirectoryFromId(prefId);
      dir.QueryInterface(Ci.nsIAbLDAPDirectory).authDn = link.user || link.email;
      dir.setStringValue("sgmail.davmail.ldap", key);
      books.push(dir.UID);
    } catch (e) {
      console.error("sg-mail: directory", e);
    }
  }
  return { calendars, books };
}

function davmailLdapUrl(link) {
  return `ldap://127.0.0.1:${link.ldap}/ou=people??sub?(objectclass=*)`;
}

// Thunderbird's LDAP book asks the password manager by the book's URL (the
// realm) and the server's origin; the gateway's password, as for CalDAV
async function storeLdapPassword(link, password) {
  await storeLogin(`ldap://127.0.0.1:${link.ldap}`, davmailLdapUrl(link), "", password);
}

function removeDavmailCollections(key, port) {
  // its own calendar, and colleagues' calendars opened through its gateway
  // (Open Shared Calendar: /users/THEIR-ADDRESS/calendar/ on the same port)
  const origin = port ? davmailOrigin(port) + "/" : null;
  for (const c of lazy.cal.manager.getCalendars()) {
    if (c.getProperty("sgmail.davmail") === key || (origin && c.uri?.spec.startsWith(origin))) lazy.cal.manager.removeCalendar(c);
  }
  for (const d of MailServices.ab.directories) {
    if (d.getStringValue("sgmail.davmail", "") === key || d.getStringValue("sgmail.davmail.ldap", "") === key) MailServices.ab.deleteAddressBook(d.URI);
  }
}

const SG_MUTANT_DAVMAIL_ITIP = false;
const SG_MUTANT_DAVMAIL_NO_PROBE = false;
const SG_MUTANT_DAVMAIL_ALERTS = false;
let prefetchPausedUntil = 0;
// An invitation answered on a Microsoft calendar (through DavMail): Exchange
// has put the meeting in the calendar itself already (tentative), under its
// own UID -- the meeting's global object ID, which carries the invitation's
// UID inside ("vCal-Uid" + its bytes in hex). Thunderbird's own answer
// would look for the invitation's UID, not find it, and put the meeting in
// a second time, which DavMail refuses ("meeting response, but event does
// not exist"). So: Exchange's copy, found (after a refresh of the calendar)
// and our attendee's answer set on it; DavMail sends Exchange the response.
// Returns the label, or null (not found: Thunderbird's own way then).
// Exchange's copy of an invitation's meeting in a Microsoft calendar, or
// null; refresh: look again at the server first (the copy arrives with the
// mail), else what Thunderbird has cached
async function davmailCopy(calendar, invite, refresh) {
  if (!invite || !invite.startDate) return null;
  const uid = invite.id || "";
  // its UTF-8 bytes in hex (no TextEncoder in this scope)
  const hex = Array.from(unescape(encodeURIComponent(uid)), c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
  const start = invite.startDate.clone(), end = (invite.endDate || invite.startDate).clone();
  start.day -= 1;
  end.day += 1;
  const filter = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT;
  const match = i => i.id === uid || (hex.length > 8 && (i.id || "").toUpperCase().includes(hex)) ||
    (i.title === invite.title && i.startDate && i.startDate.compare(invite.startDate) === 0);
  const tries = refresh ? 20 : 1;
  for (let n = 0; n < tries; n++) {
    if (refresh && n % 5 === 0) calendar.refresh();
    if (refresh) await new Promise(r => setTimeout(r, n ? 1500 : 500));
    const found = (await itemsOf(calendar, filter, start, end)).find(match);
    if (found) return found;
  }
  return null;
}

function myAttendee(item) {
  const mine = myIdentityEmails();
  return item.getAttendees().find(a => mine.has((a.id || "").replace(/^mailto:/i, "").toLowerCase())) || null;
}

const ANSWERED = { ACCEPTED: "You have accepted this invitation.", TENTATIVE: "You have accepted this invitation tentatively.",
  DECLINED: "You have declined this invitation." };

async function davmailRespond(calendar, itipItem, partstat) {
  const found = await davmailCopy(calendar, itipItem.getItemList()[0], true);
  if (!found) return null;
  const changed = found.clone();
  const att = myAttendee(changed);
  if (!att) return null;
  const updated = att.clone();
  updated.participationStatus = partstat;
  changed.removeAttendee(att);
  changed.addAttendee(updated);
  await calendar.modifyItem(changed, found);
  return ANSWERED[partstat] || "";
}

// An IMAP login on the gateway, tried once: "OK", or the server's "NO ..."
// text (DavMail: no access to that mailbox, or no mailbox at that address)
function imapLoginProbe(port, user, password) {
  return new Promise(resolve => {
    const sts = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService);
    const t = sts.createTransport([], "127.0.0.1", port, null, null);
    const out = t.openOutputStream(Ci.nsITransport.OPEN_BLOCKING, 0, 0);
    const raw = t.openInputStream(0, 0, 0);
    const inp = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
    inp.init(raw);
    let buf = "", sent = false, done = false;
    const q = s => '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';
    const finish = v => {
      if (done) return;
      done = true;
      try {
        const bye = "z LOGOUT\r\n";
        out.write(bye, bye.length);
      } catch (e) {
        // gone
      }
      t.close(0);
      resolve(v);
    };
    const pump = {
      QueryInterface: ChromeUtils.generateQI(["nsIInputStreamCallback"]),
      onInputStreamReady() {
        try {
          const n = inp.available();
          if (n) buf += inp.read(n);
        } catch (e) {
          return finish("the gateway closed the connection");
        }
        if (!sent && buf.includes("\r\n")) {
          sent = true;
          const cmd = `a LOGIN ${q(user)} ${q(password)}\r\n`;
          out.write(cmd, cmd.length);
        }
        const m = /^a (OK|NO|BAD)([^\r\n]*)/m.exec(buf);
        if (m) return finish(m[1] === "OK" ? "OK" : m[2].trim() || m[1]);
        raw.asyncWait(pump, 0, 0, Services.tm.mainThread);
      },
    };
    raw.asyncWait(pump, 0, 0, Services.tm.mainThread);
    setTimeout(() => finish("no answer from the gateway"), 60000);
  });
}

// A mail account through a DavMail gateway: every message not kept here
// is a round trip to Microsoft (Graph), so new mail is looked for often
// (IDLE, answered by DavMail every minute, and a check each minute), whole
// messages are fetched at once (no part-by-part fetching through the
// gateway), three connections are kept, not five (each one a DavMail
// session). What is kept on this computer ahead is SG Mail's newest-first
// prefetch (prefetchNewest: the newest 500 of the last 30 days, small
// batches that give way to the person's own clicks) -- not Thunderbird's
// autosync, which held the folder for minutes on a big mailbox (in no
// useful order) while a click on a message waited behind it.
function davmailMailPrefs(server) {
  server.setBoolValue("use_idle", true);
  server.setBoolValue("check_new_mail", true);
  server.setIntValue("check_time", 1);
  // (Thunderbird's "download new messages for offline use" fetched every
  // message of a first sync, oldest ones included: off; SG Mail's prefetch
  // keeps what is wanted)
  server.setBoolValue("offline_download", false);
  server.setIntValue("autosync_max_age_days", 30);
  server.setBoolValue("autosync_offline_stores", false);
  server.setBoolValue("mime_parts_on_demand", false);
  server.setIntValue("max_cached_connections", 3);
  server.setBoolValue("login_at_startup", true);
}

// ---- a DavMail gateway that stops answering: started again, quietly ----------------------
//
// Thunderbird's own alerts for a gateway ("connection refused", "timed
// out" at 127.0.0.1) are taken here instead: the gateway's user service is
// started again, the person sees "Reconnecting to Microsoft…", and only if
// that keeps failing (three times in two minutes) does Thunderbird's alert
// come through.
const gatewayListeners = new Set();
const gatewayTrouble = new Map();        // link name -> [times]

function gatewayOfUrl(url) {
  let host, port;
  try {
    host = url.host;
    port = url.port;
  } catch (e) {
    return null;
  }
  if (host !== "127.0.0.1" && host !== "localhost") return null;
  for (const pref of Services.prefs.getChildList(DAVMAIL_PREF)) {
    const link = davmailLink(pref.slice(DAVMAIL_PREF.length));
    if (link && !link.sharedOf && [link.imap, link.smtp, link.port, link.ldap].includes(port)) return link;
  }
  return null;
}

async function healGateway(link) {
  const now = Date.now();
  const times = (gatewayTrouble.get(link.name) || []).filter(t => now - t < 120000);
  times.push(now);
  gatewayTrouble.set(link.name, times);
  const tell = state => { for (const f of gatewayListeners) f({ email: link.email, state }); };
  tell("reconnecting");
  try {
    await runHelper(["start", link.name], { allowFail: true });
    const up = await waitForGateway(link.port, 30);
    tell(up ? "recovered" : "failed");
  } catch (e) {
    tell("failed");
  }
}

const gatewayAlerts = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgUserFeedbackListener"]),
  onAlert(message, url) {
    const link = url ? gatewayOfUrl(url) : null;
    if (!link || SG_MUTANT_DAVMAIL_ALERTS) return false;
    const recent = (gatewayTrouble.get(link.name) || []).filter(t => Date.now() - t < 120000);
    if (recent.length >= 3) return false;       // it keeps failing: say so
    console.warn("sg-mail: the Microsoft gateway did not answer, starting it again:", message);
    healGateway(link);
    return true;
  },
  onCertError() {},
};
let gatewayAlertsOn = false;

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
    if (gatewayAlertsOn) {
      MailServices.mailSession.removeUserFeedbackListener(gatewayAlerts);
      gatewayAlertsOn = false;
    }
  }

  getAPI(context) {
    const { extension } = context;
    if (!gatewayAlertsOn) {
      gatewayAlertsOn = true;
      MailServices.mailSession.addUserFeedbackListener(gatewayAlerts);
    }

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

        // read / unread or flagged / not for many messages at once: one
        // change a folder (an IMAP server gets one STORE for them all)
        async markMessages(ids, change) {
          const byFolder = new Map();
          for (const id of ids) {
            let hdr;
            try {
              hdr = msgHdr(id);
            } catch (e) {
              continue;
            }
            if (!byFolder.has(hdr.folder)) byFolder.set(hdr.folder, []);
            byFolder.get(hdr.folder).push(hdr);
          }
          let n = 0;
          for (const [folder, hdrs] of byFolder) {
            if ("read" in change) {
              const want = hdrs.filter(h => h.isRead !== !!change.read);
              if (want.length) folder.markMessagesRead(want, !!change.read);
              n += want.length;
            }
            if ("flagged" in change) {
              const want = hdrs.filter(h => h.isFlagged !== !!change.flagged);
              if (want.length) folder.markMessagesFlagged(want, !!change.flagged);
              n += want.length;
            }
          }
          return n;
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
            // kept on this computer (shown without asking the server)
            offline: !!(hdr.flags & Ci.nsMsgMessageFlags.Offline),
          };
        },

        // the mail accounts SG Mail runs through a DavMail gateway (their own
        // and shared mailboxes): kept here ahead, newest first
        async davmailMailAccounts() {
          const ids = Services.prefs.getChildList(DAVMAIL_PREF).map(p => p.slice(DAVMAIL_PREF.length))
            .filter(k => { const l = davmailLink(k); return l && (l.mail || l.sharedOf) && MailServices.accounts.getAccount(k); });
          // (accounts made by an older SG Mail get today's settings)
          for (const k of ids) {
            try {
              davmailMailPrefs(MailServices.accounts.getAccount(k).incomingServer);
            } catch (e) {
              console.error("sg-mail: DavMail account settings", e);
            }
          }
          return ids;
        },

        // Messages fetched to this computer ahead of their opening (the next
        // and previous ones when one is opened; the newest of a folder after
        // a sync), in the order given -- newest first. IMAP folders only;
        // those already kept here are left alone. Returns how many it asked for.
        async prefetchMessages(ids) {
          const byFolder = new Map();
          for (const id of ids || []) {
            let hdr;
            try {
              hdr = msgHdr(id);
            } catch (e) {
              continue;
            }
            if (!hdr || (hdr.flags & Ci.nsMsgMessageFlags.Offline) || hdr.folder.server.type !== "imap") continue;
            if (!byFolder.has(hdr.folder)) byFolder.set(hdr.folder, []);
            byFolder.get(hdr.folder).push(hdr);
          }
          let n = 0;
          for (const [folder, hdrs] of byFolder) {
            // (a folder busy with another fetch: left for later, quietly --
            // no window to tell: background work raises no dialogs)
            if (folder.locked) continue;
            try {
              folder.downloadMessagesForOffline(hdrs, null);
              n += hdrs.length;
            } catch (e) {
              console.error("sg-mail: prefetch", e);
            }
          }
          return n;
        },

        // A folder's newest messages fetched to this computer, newest first,
        // a batch at a time: up to LIMIT messages, none older than DAYS days
        // (Microsoft accounts through DavMail: every message shown is
        // otherwise a round trip to Microsoft). Returns what it queued.
        // the person is reading: background fetching waits (MS) -- one
        // folder connection, and a click must not queue behind a prefetch
        async pausePrefetch(ms) {
          prefetchPausedUntil = Math.max(prefetchPausedUntil, Date.now() + Math.min(ms || 0, 30000));
          return true;
        },

        async prefetchNewest(folderId, limit = 500, days = 30, batch = 25) {
          const folder = folderOf(folderId);
          if (folder.server.type !== "imap") return { queued: 0, order: [] };
          const since = Date.now() - days * 86400000;
          const hdrs = [];
          for (const h of folder.msgDatabase.enumerateMessages()) {
            if (h.flags & Ci.nsMsgMessageFlags.Offline) continue;
            if (h.date / 1000 < since) continue;
            hdrs.push(h);
          }
          hdrs.sort((a, b) => b.date - a.date);
          const chosen = hdrs.slice(0, limit);
          for (let i = 0; i < chosen.length; i += batch) {
            const part = chosen.slice(i, i + batch);
            await new Promise(resolve => {
              const listener = {
                QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
                OnStartRunningUrl() {},
                OnStopRunningUrl() {
                  resolve();
                },
              };
              const t0 = Date.now();
              const start = () => {
                // a folder busy with another fetch, or the person reading
                // (a click a moment ago): this batch waits its turn
                if ((folder.locked || Date.now() < prefetchPausedUntil) && Date.now() - t0 < 60000) return setTimeout(start, 300);
                try {
                  folder.downloadMessagesForOffline(part, null);
                } catch (e) {
                  console.error("sg-mail: prefetch", e);
                }
                poll();
              };
              // downloadMessagesForOffline has no listener: wait until the
              // batch is here (or a while), then the next
              const poll = () => {
                if (part.every(h => h.flags & Ci.nsMsgMessageFlags.Offline) || Date.now() - t0 > 60000) return listener.OnStopRunningUrl();
                setTimeout(poll, 300);
              };
              start();
            });
          }
          return { queued: chosen.length, order: chosen.slice(0, 10).map(h => h.date / 1000) };
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

        // ---- Microsoft calendars and contacts (DavMail) ------------------------------------

        // the accounts that can have them, and those that have
        async msAccounts() {
          const out = [];
          for (const account of MailServices.accounts.accounts) {
            const k = microsoftKind(account);
            const link = davmailLink(account.key);
            if ((!k && !link) || link?.sharedOf) continue;
            out.push({
              accountId: account.key,
              email: account.defaultIdentity?.email || link?.email || "",
              name: account.incomingServer?.prettyName || "",
              kind: link?.kind || k.kind,
              linked: !!link,
              port: link?.port || 0,
            });
          }
          return out;
        },

        // set up the account's gateway, sign in (DavMail's window), then its
        // calendar and address book in Thunderbird: { ok, cancelled, error }
        async msConnect(accountId) {
          const account = MailServices.accounts.getAccount(accountId);
          if (!account) throw new ExtensionError(`No account ${accountId}`);
          const k = microsoftKind(account);
          if (!k) throw new ExtensionError("Not a Microsoft 365, Outlook.com or Exchange account");
          const email = account.defaultIdentity.email.toLowerCase();
          const name = davmailName(email);
          const out = await runHelper(["setup", name, k.kind, email, ...(k.url ? [k.url] : [])]);
          const port = Number((/port=(\d+)/.exec(out) || [])[1]);
          if (!port) throw new ExtensionError("The gateway has no port: " + out.slice(0, 200));
          // an Exchange server signs in with its own user name and password
          // (Thunderbird asks for it once); Microsoft 365 with DavMail's window
          const user = k.kind === "exchange" ? (account.incomingServer.username || email) : email;
          const ldap = Number((/^ldap=(\d+)$/m.exec(out) || [])[1]) || 0;
          const link = { name, email, user, kind: k.kind, port, ldap };
          const undo = async () => {
            Services.prefs.clearUserPref(DAVMAIL_PREF + accountId);
            for (const l of await Services.logins.searchLoginsAsync({ origin: davmailOrigin(port), httpRealm: DAVMAIL_REALM })) {
              await removeLogin(l);
            }
            await runHelper(["remove", name], { allowFail: true });
          };
          Services.prefs.setStringPref(DAVMAIL_PREF + accountId, JSON.stringify(link));
          if (k.kind === "microsoft") {
            let password = await davmailPassword(port, email);
            if (!password) {
              password = randomPassword();
              await storeDavmailPassword(port, email, password);
            }
            let r;
            try {
              r = await davmailSignIn(accountId, link, password);
            } catch (e) {
              r = { ok: false, error: String(e.message || e) };
            }
            if (!r.ok) {
              await undo();
              return r;
            }
          }
          try {
            await runHelper(["start", name]);
          } catch (e) {
            await undo();
            return { ok: false, error: String(e.message || e) };
          }
          await waitForGateway(port);
          if (link.ldap) {
            const pw = await davmailPassword(port, email);
            if (pw) await storeLdapPassword(link, pw);
          }
          const made = createDavmailCollections(accountId, link, account);
          return { ok: true, calendars: made.calendars, books: made.books };
        },

        // Is this address a Microsoft account? Outlook.com's own domains, or a
        // domain whose mail Microsoft 365 receives (MX *.mail.protection.outlook.com)
        async msDetect(email) {
          const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
          if (!domain) return { microsoft: false, via: "" };
          if (MS_DOMAINS.test(domain)) return { microsoft: true, via: "domain" };
          try {
            const { DNS } = ChromeUtils.importESModule("resource:///modules/DNS.sys.mjs");
            const mx = await Promise.race([DNS.mx(domain), new Promise(r => setTimeout(() => r([]), 4000))]);
            if ((mx || []).some(r => /\.mail\.protection\.(outlook\.com|partner\.outlook\.cn)\.?$/i.test(r.host || r.data || "")))
              return { microsoft: true, via: "mx" };
          } catch (e) {
            // no answer: not known to be Microsoft's
          }
          return { microsoft: false, via: "" };
        },

        // Thunderbird's own account setup, with the address and name the
        // person already gave SG Mail (best effort: its fields, as they are
        // in 140's tab and 145+'s Account Hub)
        async openAccountSetup(email, fullName) {
          const win = mainWindow();
          if (!win) throw new ExtensionError("No main window");
          win.openAccountSetup();
          if (!email && !fullName) return true;
          const deep = (root, sel) => {
            const out = [];
            const walk = n => {
              out.push(...n.querySelectorAll(sel));
              for (const e of n.querySelectorAll("*")) if (e.shadowRoot) walk(e.shadowRoot);
            };
            if (root) walk(root);
            return out;
          };
          const fill = (doc, el, value) => {
            if (!el || !value || el.value) return false;
            el.focus();
            el.value = value;
            el.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true, composed: true }));
            return true;
          };
          for (let i = 0; i < 50; i++) {
            await new Promise(r => setTimeout(r, 200));
            const hub = win.document.querySelector("account-hub-container");
            if (hub?.modal?.open) {
              const e = deep(hub.shadowRoot, "#email")[0];
              if (!e) continue;
              fill(win.document, deep(hub.shadowRoot, "#realName")[0], fullName);
              fill(win.document, e, email);
              return true;
            }
            const tab = win.document.getElementById("tabmail").tabInfo.find(t => t.browser?.currentURI.spec == "about:accountsetup");
            const doc = tab?.browser?.contentDocument;
            if (doc?.getElementById("email")) {
              fill(doc, doc.getElementById("realname"), fullName);
              fill(doc, doc.getElementById("email"), email);
              return true;
            }
          }
          return false;
        },

        // A Microsoft account through DavMail entirely: its gateway with
        // IMAP, SMTP, CalDAV and CardDAV, one DavMail sign-in, then
        // Thunderbird's mail account on it, its calendar and its address
        // book. { ok, accountId, cancelled, error }
        async msAddAccount(email, fullName) {
          email = String(email || "").trim().toLowerCase();
          if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new ExtensionError("Not an e-mail address: " + email);
          if (MailServices.accounts.allIdentities.some(i => (i.email || "").toLowerCase() === email)) {
            return { ok: false, error: `${email} is already set up in SG Mail. Its calendar and contacts can be added from Calendar > Add calendar.` };
          }
          const pending = "new:" + email;
          const name = davmailName(email);
          const out = await runHelper(["setup", name, "microsoft", email, "--mail"]);
          const num = k => Number((new RegExp(`^${k}=(\\d+)$`, "m").exec(out) || [])[1]);
          const link = { name, email, user: email, kind: "microsoft", port: num("port"), imap: num("imap"), smtp: num("smtp"), ldap: num("ldap") || 0, mail: true };
          if (!link.port || !link.imap || !link.smtp) throw new ExtensionError("The gateway has no ports: " + out.slice(0, 200));
          const password = randomPassword();
          const undo = async () => {
            for (const l of await Services.logins.searchLoginsAsync({ origin: davmailOrigin(link.port), httpRealm: DAVMAIL_REALM })) {
              await removeLogin(l);
            }
            await runHelper(["remove", name], { allowFail: true });
          };
          await storeDavmailPassword(link.port, email, password);
          let r;
          try {
            r = await davmailSignIn(pending, link, password);
            if (r.ok) {
              await runHelper(["start", name]);
              await waitForGateway(link.port);
            }
          } catch (e) {
            r = { ok: false, error: String(e.message || e) };
          }
          if (!r.ok) {
            await undo();
            return r;
          }
          // Thunderbird's mail account on the gateway: IMAP and SMTP on
          // 127.0.0.1, the same password (DavMail's token opens with it)
          for (const scheme of ["imap", "smtp"]) await storeLogin(`${scheme}://127.0.0.1`, `${scheme}://127.0.0.1`, email, password);
          const server = MailServices.accounts.createIncomingServer(email, "127.0.0.1", "imap");
          server.port = link.imap;
          server.socketType = Ci.nsMsgSocketType.plain;
          server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
          server.prettyName = email;
          davmailMailPrefs(server);
          const outServer = MailServices.outgoingServer.createServer("smtp");
          const smtp = outServer.QueryInterface(Ci.nsISmtpServer);
          smtp.hostname = "127.0.0.1";
          smtp.port = link.smtp;
          outServer.username = email;
          outServer.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
          outServer.socketType = Ci.nsMsgSocketType.plain;
          try {
            outServer.description = `${email} (Microsoft, through DavMail)`;
          } catch (e) {
            // no description on this version
          }
          const identity = MailServices.accounts.createIdentity();
          identity.email = email;
          identity.fullName = String(fullName || "").trim();
          identity.smtpServerKey = outServer.key;
          // Exchange keeps the copy in Sent Items itself (davmail.smtpSaveInSent)
          identity.doFcc = false;
          const account = MailServices.accounts.createAccount();
          account.addIdentity(identity);
          account.incomingServer = server;
          link.smtpKey = outServer.key;
          Services.prefs.setStringPref(DAVMAIL_PREF + account.key, JSON.stringify(link));
          if (link.ldap) await storeLdapPassword(link, password);
          const made = createDavmailCollections(account.key, link, account);
          try {
            server.getNewMessages(server.rootFolder.getFolderWithFlags(Ci.nsMsgFolderFlags.Inbox) || server.rootFolder, null, null);
          } catch (e) {
            // the first check comes by itself
          }
          return { ok: true, accountId: account.key, calendars: made.calendars, books: made.books };
        },

        // DavMail's sign-in again (its token expired or was revoked)
        async msSignIn(accountId) {
          const link = davmailLink(accountId);
          if (!link) throw new ExtensionError(`No Microsoft calendar set up for ${accountId}`);
          if (link.kind !== "microsoft") return { ok: false, error: "This account signs in with its password" };
          let password = await davmailPassword(link.port, link.email);
          if (!password) {
            password = randomPassword();
            await storeDavmailPassword(link.port, link.email, password);
          }
          const r = await davmailSignIn(accountId, link, password);
          if (r.ok) {
            await runHelper(["start", link.name], { allowFail: true });
            await waitForGateway(link.port, 30);
            for (const c of lazy.cal.manager.getCalendars()) {
              if (c.getProperty("sgmail.davmail") === accountId) c.refresh();
            }
            for (const d of MailServices.ab.directories) {
              if (d.getStringValue("sgmail.davmail", "") === accountId) {
                const { CardDAVDirectory } = ChromeUtils.importESModule("resource:///modules/CardDAVDirectory.sys.mjs");
                CardDAVDirectory.forFile(d.fileName).syncWithServer().catch(e => console.error("sg-mail: contacts", e));
              }
            }
          }
          return r;
        },

        // the sign-in given up (the person's Cancel)
        async msCancel(accountId) {
          const e = signIns.get(accountId);
          if (!e) return false;
          e.cancelled = true;
          e.abort.abort();
          try {
            await e.proc.kill(3000);
          } catch (err) {
            // gone already
          }
          return true;
        },

        // each set-up account's gateway: ok, stopped (not running), signin
        // (DavMail has no valid sign-in), password (an Exchange server's,
        // not given yet), offline, error
        async msStatus() {
          const out = [];
          for (const pref of Services.prefs.getChildList(DAVMAIL_PREF)) {
            const accountId = pref.slice(DAVMAIL_PREF.length);
            const link = davmailLink(accountId);
            if (!link || link.sharedOf) continue;
            const entry = { accountId, email: link.email, kind: link.kind, port: link.port, signingIn: signIns.has(accountId) };
            const password = await davmailPassword(link.port, link.user || link.email);
            if (!password) {
              out.push(Object.assign(entry, link.kind === "microsoft" ? { state: "signin", detail: "no password kept" } : { state: "password", detail: "" }));
              continue;
            }
            const r = await davmailRequest(link.port, link.email, password, { user: link.user || link.email });
            out.push(Object.assign(entry, davmailState(r)));
          }
          return out;
        },

        async msStart(accountId) {
          const link = davmailLink(accountId);
          if (!link) throw new ExtensionError(`No Microsoft calendar set up for ${accountId}`);
          await runHelper(["start", link.name]);
          return true;
        },

        // its calendar and address book gone from Thunderbird, its gateway
        // (settings and DavMail's token) from this computer
        async msDisconnect(accountId) {
          const link = davmailLink(accountId);
          if (!link) return false;
          // a shared mailbox: its own IMAP password only (the gateway is its
          // owner account's)
          if (link.sharedOf) {
            for (const l of await Services.logins.searchLoginsAsync({ origin: "imap://127.0.0.1" })) {
              if (l.username === link.user) await removeLogin(l);
            }
            Services.prefs.clearUserPref(DAVMAIL_PREF + accountId);
            return true;
          }
          const e = signIns.get(accountId);
          if (e) {
            e.cancelled = true;
            e.abort.abort();
          }
          // each step on its own: one failing must not keep the rest
          const step = async (what, fn) => {
            try {
              await fn();
            } catch (err) {
              console.error(`sg-mail: removing the Microsoft calendar (${what})`, err);
            }
          };
          await step("calendar and address book", () => removeDavmailCollections(accountId, link.port));
          await step("password", async () => {
            for (const l of await Services.logins.searchLoginsAsync({ origin: davmailOrigin(link.port), httpRealm: DAVMAIL_REALM })) {
              await removeLogin(l);
            }
          });
          if (link.ldap) {
            await step("directory password", async () => {
              for (const l of await Services.logins.searchLoginsAsync({ origin: `ldap://127.0.0.1:${link.ldap}` })) await removeLogin(l);
            });
          }
          // the shared mailboxes opened through this account go with it
          await step("shared mailboxes", () => {
            for (const pref of Services.prefs.getChildList(DAVMAIL_PREF)) {
              const other = davmailLink(pref.slice(DAVMAIL_PREF.length));
              const acct = other && other.sharedOf === accountId ? MailServices.accounts.getAccount(pref.slice(DAVMAIL_PREF.length)) : null;
              if (acct) MailServices.accounts.removeAccount(acct, true);
            }
          });
          if (link.mail) {
            await step("mail passwords", async () => {
              for (const scheme of ["imap", "smtp"]) {
                for (const l of await Services.logins.searchLoginsAsync({ origin: `${scheme}://127.0.0.1` })) {
                  if (l.username === link.email) await removeLogin(l);
                }
              }
            });
            await step("outgoing server", () => {
              const out = MailServices.outgoingServer.servers.find(sv => sv.key === link.smtpKey);
              if (out) MailServices.outgoingServer.deleteServer(out);
            });
          }
          Services.prefs.clearUserPref(DAVMAIL_PREF + accountId);
          await step("gateway", () => runHelper(["remove", link.name], { allowFail: true }));
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
            davmail: c.getProperty("sgmail.davmail") || "",
            // a calendar group of the person's own (Outlook's "Team: ...", ...)
            group: c.getProperty("sgmail.group") || "",
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
          // a Microsoft calendar (DavMail): the answer is on Exchange's own
          // copy of the meeting, which Thunderbird does not know as this one
          let answered = "";
          if (state.itipItem.receivedMethod === "REQUEST" && ev) {
            for (const c of lazy.cal.manager.getCalendars().filter(x => x.getProperty("sgmail.davmail"))) {
              const copy = await davmailCopy(c, ev, false).catch(() => null);
              const ps = copy && myAttendee(copy)?.participationStatus;
              if (ps && ANSWERED[ps]) {
                answered = ANSWERED[ps];
                actions.length = 0;
                actions.push(...["accept", "tentative", "decline"].filter(a => ({ accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" })[a] !== ps));
              }
            }
          }
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
            label: answered || data.label || "",
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
                } else if (r.status === 403 || /ErrorItemNotFound|ErrorAccessDenied|ErrorFolderNotFound/.test(r.text || "")) {
                  // (Microsoft, through DavMail: a calendar one may not see
                  // is "not found")
                  // (what a group's address said first stays: it says more)
                  if (!/is a group or a list/.test(lastError)) lastError = `${email} has not shared a calendar with you`;
                } else if (/MailboxNotEnabledForRESTAPI/.test(r.text || "")) {
                  // a Microsoft 365 group or a distribution list: no mailbox
                  // of its own that DavMail can open
                  lastError = `${email} is a group or a list, whose calendar DavMail cannot open; open the members' calendars instead`;
                }
              } catch (e) {
                // a path the server does not serve at all: the reason found
                // on another one says more
                lastError = lastError || String(e.message || e);
              }
              if (found.length) break;
            }
            if (found.length) break;
          }
          return { calendars: found, error: found.length ? "" : (lastError || `No calendar of ${email} was found that you may open`) };
        },

        async openSharedCalendar(info) {
          // an address in the path as the server writes it in its answers
          // (DavMail: /users/name@domain/...; Thunderbird 140 had it as %40,
          // and then took none of the server's events for this calendar's)
          info.url = String(info.url || "").replace(/%40/gi, "@");
          const existing = lazy.cal.manager.getCalendars().find(c => c.uri && c.uri.spec === info.url);
          if (existing) return existing.id;
          const c = lazy.cal.manager.createCalendar("caldav", Services.io.newURI(info.url));
          c.name = info.name;
          c.setProperty("color", info.color || "#8764b8");
          c.setProperty("username", info.username || "");
          c.setProperty("sgmail.shared", String(info.owner || "").toLowerCase());
          if (info.group) c.setProperty("sgmail.group", String(info.group));
          c.setProperty("cache.enabled", true);
          if (!info.writable) c.readOnly = true;
          // no invitations sent or answered from another person's calendar
          c.setProperty("imip.identity.disabled", true);
          lazy.cal.manager.registerCalendar(c);
          return c.id;
        },

        // a calendar put in a calendar group of the person's own ("" takes
        // it out: My Calendars, or Shared Calendars)
        async setCalendarGroup(calendarId, group) {
          const c = calendarById(calendarId);
          if (group) c.setProperty("sgmail.group", String(group).slice(0, 80));
          else c.deleteProperty("sgmail.group");
          return true;
        },

        // A shared (or delegated) mailbox through a Microsoft account's
        // gateway: DavMail opens another mailbox for an IMAP login of
        // "OWN-ADDRESS/MAILBOX-ADDRESS" (its documented syntax) with the
        // account's own sign-in; Thunderbird gets it as one more account,
        // its folders a tree of their own. What Exchange allows (read, or
        // read and write) is what works.
        async msAddSharedMailbox(accountId, mailbox) {
          const link = davmailLink(accountId);
          if (!link || link.kind !== "microsoft" || link.sharedOf) throw new ExtensionError("Not a Microsoft account set up through DavMail");
          mailbox = String(mailbox || "").trim().toLowerCase();
          if (!/^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(mailbox)) throw new ExtensionError("Not an e-mail address: " + mailbox);
          if (mailbox === link.email) throw new ExtensionError("That is the account's own mailbox");
          const user = `${link.email}/${mailbox}`;
          if (MailServices.accounts.accounts.some(a => a.incomingServer?.username === user)) throw new ExtensionError(`${mailbox} is already open`);
          // the gateway's IMAP (an account set up for calendars only gets it now)
          if (!link.imap) {
            const out = await runHelper(["setup", link.name, link.kind, link.email, "--mail"]);
            link.imap = Number((/^imap=(\d+)$/m.exec(out) || [])[1]);
            link.smtp = Number((/^smtp=(\d+)$/m.exec(out) || [])[1]);
            Services.prefs.setStringPref(DAVMAIL_PREF + accountId, JSON.stringify(link));
            await runHelper(["stop", link.name], { allowFail: true });
            await runHelper(["start", link.name]);
            await waitForGateway(link.port);
          }
          const password = await davmailPassword(link.port, link.email);
          if (!password) throw new ExtensionError("Sign in to Microsoft again first");
          // may the account open it? (asked once: Thunderbird would ask for
          // a password over and over for a mailbox one cannot open)
          const probe = SG_MUTANT_DAVMAIL_NO_PROBE ? "OK" : await imapLoginProbe(link.imap, user, password);
          if (probe !== "OK") {
            return { ok: false, error: `${mailbox} could not be opened: you have no access to it, or it is not a mailbox (${probe})` };
          }
          await storeLogin("imap://127.0.0.1", "imap://127.0.0.1", user, password);
          const server = MailServices.accounts.createIncomingServer(user, "127.0.0.1", "imap");
          server.port = link.imap;
          server.socketType = Ci.nsMsgSocketType.plain;
          server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
          server.prettyName = mailbox;
          davmailMailPrefs(server);
          const identity = MailServices.accounts.createIdentity();
          identity.email = mailbox;
          identity.fullName = mailbox;
          const owner = MailServices.accounts.getAccount(accountId);
          const ownSmtp = owner?.defaultIdentity?.smtpServerKey || link.smtpKey;
          if (ownSmtp) identity.smtpServerKey = ownSmtp;
          // (Exchange keeps the shared mailbox's Sent copy)
          identity.doFcc = Boolean(false);
          const account = MailServices.accounts.createAccount();
          account.addIdentity(identity);
          account.incomingServer = server;
          Services.prefs.setStringPref(DAVMAIL_PREF + account.key, JSON.stringify({ sharedOf: accountId, email: mailbox, user, kind: "shared", port: link.port }));
          try {
            server.getNewMessages(server.rootFolder, null, null);
          } catch (e) {
            // the first check comes by itself
          }
          return { ok: true, accountId: account.key };
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

        // a Microsoft account's gateway being started again: reconnecting,
        // recovered, failed
        onGatewayTrouble: new ExtensionCommon.EventManager({
          context,
          name: "sgmail.onGatewayTrouble",
          register: fire => {
            const f = info => fire.async(info);
            gatewayListeners.add(f);
            return () => gatewayListeners.delete(f);
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
          // a Microsoft calendar (DavMail): Exchange's own copy answered
          if (chosen && chosen.getProperty("sgmail.davmail") && partstats[action]
              && state.itipItem.receivedMethod === "REQUEST" && SG_MUTANT_DAVMAIL_ITIP !== true) {
            try {
              const done = await davmailRespond(chosen, state.itipItem, partstats[action]);
              if (done !== null) return { ok: true, label: done };
            } catch (e) {
              console.error("sg-mail: answering on the Microsoft calendar", e);
            }
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
