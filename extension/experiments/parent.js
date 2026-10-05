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
  CalAttendee: "resource:///modules/CalAttendee.sys.mjs",
  CalAlarm: "resource:///modules/CalAlarm.sys.mjs",
  CalRecurrenceInfo: "resource:///modules/CalRecurrenceInfo.sys.mjs",
});
var { ExtensionError } = ExtensionUtils;

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
          win.MsgGetMessagesForAllServers(null);
          if (folderId) {
            try {
              folderOf(folderId).updateFolder(win.msgWindow);
            } catch (e) {
              console.error(e);
            }
          }
          win.SendUnsentMessages();
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
          const original = details.originalMessageId ? msgHdr(details.originalMessageId) : null;
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
          }));
        },

        // Outlook always has a Calendar: a local one when there is none to write in
        async ensureCalendar() {
          const writable = lazy.cal.manager.getCalendars().filter(c => !c.readOnly && !c.getProperty("disabled"));
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
