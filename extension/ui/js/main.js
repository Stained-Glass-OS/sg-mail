/*
 * SG Mail -- the main window: the ribbon of the module shown (Mail or
 * Calendar), the navigation bar that switches them, Outlook's keys, the
 * status bar, and the window's title.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, $$, esc, showMenu, closeMenu, toast, dialog, applyLook, testDump } from "./util.js";
import { Ribbon, tellMeBox } from "./ribbon.js";
import { MailModule } from "./mail.js";
import { CalendarModule } from "./calendar.js";
import { PeopleModule } from "./people.js";
import { installTestHook } from "./testhook.js";

class App {
  constructor() {
    this.module = "mail";
    this.notifications = [];
    applyLook();
    this.mail = new MailModule(this);
    this.calendar = new CalendarModule(this);
    this.people = new PeopleModule(this);
    this.buildNav();
    this.buildRibbon();
    this.wireKeys();
    this.wireSplitters();
    this.wireStatus();
  }

  async start() {
    try {
      this.tab = await messenger.tabs.getCurrent();
    } catch (e) {
      // not in a tab
    }
    await this.mail.start();
    await this.calendar.start();
    await this.people.start();
    const st = await messenger.storage.local.get(["module", "readingPane"]).catch(() => ({}));
    this.setReadingPane(st.readingPane || "right", false);
    if (st.module === "calendar" || st.module === "people") this.showModule(st.module);
    this.updateRibbon();
    window.sgmailReady = true;
    testDump("ready.json", { ready: true });
  }

  // ---- modules and the navigation bar -----------------------------------------------------------

  buildNav() {
    const nav = $("#nav-bar");
    const btn = (id, ic, label, fn) => {
      const b = h("button", { class: "nav-btn", id: "nav-" + id, title: label, "aria-label": label, html: icon(ic, 22) });
      b.addEventListener("click", fn);
      nav.append(b);
      return b;
    };
    btn("mail", "mail", "Mail (Ctrl+1)", () => this.showModule("mail"));
    btn("calendar", "calendar", "Calendar (Ctrl+2)", () => this.showModule("calendar"));
    btn("people", "people", "People (Ctrl+3)", () => this.showModule("people"));
    const more = btn("more", "more", "More", () => showMenu([
      { label: "Thunderbird's Address Book", icon: "address-book", action: () => messenger.sgmail.openTool("addressBook") },
      { label: "Message Filters…", icon: "filter", action: () => messenger.sgmail.openTool("filters") },
      { label: "Activity", icon: "info", action: () => messenger.sgmail.openTool("activity") },
    ], { x: more.getBoundingClientRect().left, y: more.getBoundingClientRect().top - 110 }));
    more.classList.add("more");
    this.markNav();
  }

  markNav() {
    for (const b of $$(".nav-btn")) b.classList.toggle("active", b.id === "nav-" + this.module);
  }

  showModule(name) {
    if (this.module === name) return;
    this.module = name;
    for (const m of ["mail", "calendar", "people"]) {
      $("#module-" + m).hidden = name !== m;
      $("#side-" + m).hidden = name !== m;
    }
    this.markNav();
    this.buildRibbon();
    if (name === "calendar") this.calendar.show();
    if (name === "people") {
      this.setTitle("People");
      this.people.show();
    }
    if (name === "mail") {
      this.setTitle(this.mail.title || "Mail");
      this.mail.updateStatus();
    }
    messenger.storage.local.set({ module: name }).catch(() => {});
    this.updateRibbon();
  }

  setTitle(text) {
    document.title = `${text} - SG Mail`;
  }

  setStatus(text) {
    $("#status-left").textContent = text;
  }

  async focusWindow() {
    try {
      if (this.tab) {
        await messenger.windows.update(this.tab.windowId, { focused: true });
        await messenger.sgmail.showOwnTab(this.tab.windowId, this.tab.id);
      }
    } catch (e) {
      // the window went
    }
  }

  // ---- the ribbon ------------------------------------------------------------------------------------

  buildRibbon() {
    const def = this.module === "calendar" ? this.calendar.ribbon() : this.module === "people" ? this.people.ribbon() : this.mailRibbon();
    def.file = el => this.fileMenu(el);
    def.extra = tellMeBox((text, input) => this.tellMe(text, input));
    this.ribbon = new Ribbon($("#ribbon"), def);
    this.updateRibbon();
  }

  mailRibbon() {
    const m = this.mail;
    const sel = () => m.selection();
    const newItems = () => [
      { label: "E-mail Message", icon: "mail-new", shortcut: "Ctrl+Shift+M", action: () => m.compose({ mode: "new" }) },
      { label: "Appointment", icon: "appointment-new", shortcut: "Ctrl+Shift+A", action: () => this.calendar.newEvent({}) },
      { label: "Meeting", icon: "meeting-new", shortcut: "Ctrl+Shift+Q", action: () => this.calendar.newEvent({ meeting: true }) },
      { separator: true },
      { label: "Contact", icon: "person", action: () => this.newContact() },
      { label: "Contact Group", icon: "group", action: () => this.newContact(true) },
    ];
    return {
      tabs: [
        { id: "home", label: "Home", groups: [
          { label: "New", items: [
            { id: "new-email", icon: "mail-new", label: "New Email", large: true, shortcut: "Ctrl+N", action: () => m.compose({ mode: "new" }) },
            { id: "new-items", icon: "calendar", label: "New Items", large: true, menu: newItems },
          ] },
          { label: "Delete", items: [
            { id: "delete", icon: "delete", label: "Delete", large: true, shortcut: "Delete", action: () => m.deleteSelected() },
            { id: "archive", icon: "archive", label: "Archive", large: true, shortcut: "Backspace", action: () => m.archiveSelected() },
            { col: [
              { id: "junk", icon: "junk", label: "Junk", menu: () => [
                { label: "Block Sender / Junk", action: () => m.junkSelected(true) },
                { label: "Not Junk", action: () => m.junkSelected(false) },
              ] },
            ] },
          ] },
          { label: "Respond", items: [
            { id: "reply", icon: "reply", label: "Reply", large: true, shortcut: "Ctrl+R", action: () => sel()[0] && m.compose({ mode: "reply", id: sel()[0].id }) },
            { id: "reply-all", icon: "reply-all", label: "Reply All", large: true, shortcut: "Ctrl+Shift+R", action: () => sel()[0] && m.compose({ mode: "replyAll", id: sel()[0].id }) },
            { id: "forward", icon: "forward", label: "Forward", large: true, shortcut: "Ctrl+F", action: () => sel()[0] && m.compose({ mode: "forward", id: sel()[0].id }) },
          ] },
          { label: "Move", items: [
            { id: "move", icon: "move", label: "Move", large: true, menu: () => m.moveMenu() },
            { col: [
              { id: "rules", icon: "rules", label: "Rules", menu: () => m.rulesMenu() },
            ] },
          ] },
          { label: "Tags", items: [
            { col: [
              { id: "unread-read", icon: "mail-unread", label: "Unread/Read", shortcut: "Ctrl+Q / Ctrl+U", action: () => m.toggleRead() },
              { id: "categorize", icon: "category", label: "Categorize", menu: () => m.categorizeMenu() },
              { id: "follow-up", icon: "flag", label: "Follow Up", shortcut: "Insert", action: () => m.flag(sel()) },
            ] },
          ] },
          { label: "Find", items: [
            { col: [
              { id: "search-people", icon: "search", label: "Search", shortcut: "Ctrl+E", action: () => $("#search").focus() },
              { id: "address-book", icon: "address-book", label: "Address Book", action: () => this.showModule("people") },
              { id: "filter-email", icon: "filter", label: "Filter Email", menu: () => [
                { label: "Unread", checked: m.list.filter === "unread", action: () => m.setFilter("unread") },
                { label: "Flagged", checked: m.list.filter === "flagged", action: () => m.setFilter("flagged") },
                { separator: true },
                { label: "Clear Filter", action: () => m.setFilter("all") },
              ] },
            ] },
          ] },
          { label: "Send/Receive", items: [
            { id: "send-receive", icon: "sync", label: "Send/ Receive", title: "Send/Receive All Folders", large: true, shortcut: "F9", action: () => this.sendReceive() },
          ] },
        ] },
        { id: "sendreceive", label: "Send / Receive", groups: [
          { label: "Send & Receive", items: [
            { id: "send-receive", icon: "sync", label: "Send/ Receive", title: "Send/Receive All Folders", large: true, shortcut: "F9", action: () => this.sendReceive() },
            { col: [
              { id: "update-folder", icon: "folder", label: "Update Folder", shortcut: "Shift+F9", action: () => m.folder && !m.folder.virtual && messenger.sgmail.updateFolder(m.folder.id).then(() => m.reload(true)) },
              { id: "send-all", icon: "send", label: "Send All", action: () => this.sendReceive() },
            ] },
          ] },
          { label: "Preferences", items: [
            { id: "work-offline", icon: "offline", label: "Work Offline", large: true, action: () => this.toggleOffline() },
          ] },
        ] },
        { id: "folder", label: "Folder", groups: [
          { label: "New", items: [
            { id: "new-folder", icon: "folder", label: "New Folder", large: true, action: () => m.folder && !m.folder.virtual && m.folders.newFolder(m.folder) },
          ] },
          { label: "Actions", items: [
            { col: [
              { id: "rename-folder", icon: "drafts", label: "Rename Folder", action: () => m.folder && !m.folder.virtual && m.folders.renameFolder(m.folder) },
              { id: "delete-folder", icon: "delete", label: "Delete Folder", action: () => m.folder && !m.folder.virtual && m.folders.deleteFolder(m.folder) },
              { id: "mark-all-read", icon: "mail-read", label: "Mark All as Read", action: () => m.folder && !m.folder.virtual && messenger.folders.markAsRead(m.folder.id) },
            ] },
          ] },
          { label: "Favorites", items: [
            { id: "show-favorites", icon: "star", label: "Show in Favorites", large: true, action: () => m.folder && !m.folder.virtual && m.folders.setFavorite(m.folder, !m.folder.isFavorite) },
          ] },
          { label: "Properties", items: [
            { id: "account-settings", icon: "settings", label: "Account Settings", large: true, action: () => messenger.sgmail.openTool("accountSettings") },
          ] },
        ] },
        { id: "view", label: "View", groups: [
          { label: "Arrangement", items: [
            { col: [
              { id: "arrange-date", icon: "calendar", label: "Date", action: () => { m.list.sort = { by: "date", desc: true }; m.relayout(); } },
              { id: "arrange-from", icon: "person", label: "From", action: () => { m.list.sort = { by: "from", desc: false }; m.relayout(); } },
              { id: "arrange-subject", icon: "drafts", label: "Subject", action: () => { m.list.sort = { by: "subject", desc: false }; m.relayout(); } },
            ] },
            { id: "reverse-sort", icon: "repeat", label: "Reverse Sort", large: true, action: () => { m.list.sort.desc = !m.list.sort.desc; m.relayout(); } },
          ] },
          { label: "Layout", items: [
            { id: "reading-pane", icon: "reading-" + (this.readingPane || "right"), label: "Reading Pane", large: true, menu: () => [
              { label: "Right", icon: "reading-right", checked: this.readingPane === "right", action: () => this.setReadingPane("right") },
              { label: "Bottom", icon: "reading-bottom", checked: this.readingPane === "bottom", action: () => this.setReadingPane("bottom") },
              { label: "Off", icon: "reading-off", checked: this.readingPane === "off", action: () => this.setReadingPane("off") },
            ] },
            { id: "focused-inbox", icon: "focused", label: "Show Focused Inbox", large: true, title: "Show Focused Inbox: the Inbox in two tabs, Focused and Other",
              action: () => m.setFocusedInbox(!m.focus.on) },
            { id: "folder-pane-toggle", icon: "folder", label: "Folder Pane", large: true, menu: () => [
              { label: "Normal", checked: !$("#side").classList.contains("min"), action: () => this.setFolderPane(true) },
              { label: "Off", checked: $("#side").classList.contains("min"), action: () => this.setFolderPane(false) },
            ] },
          ] },
        ] },
      ],
    };
  }

  newContact(group = false) {
    this.showModule("people");
    if (group) this.people.editGroup(null);
    else this.people.editContact(null);
  }

  updateRibbon() {
    if (this.ribbon && this.module === "people") return this.people.updateRibbon();
    if (!this.ribbon || this.module !== "mail") return;
    const sel = this.mail.selection();
    const one = sel.length === 1;
    for (const id of ["delete", "archive", "junk", "move", "unread-read", "follow-up", "categorize"]) this.ribbon.enable(id, sel.length > 0);
    for (const id of ["reply", "reply-all", "forward"]) this.ribbon.enable(id, one);
    this.ribbon.toggle("work-offline", !!this.offline);
    this.ribbon.toggle("focused-inbox", !!this.mail.focus.on);
  }

  // View > Reading Pane: Right (the list beside it), Bottom (the list above
  // it, one line a message) or Off (the list alone); remembered
  setReadingPane(pos, remember = true) {
    if (!["right", "bottom", "off"].includes(pos)) pos = "right";
    this.readingPane = pos;
    const mod = $("#module-mail");
    mod.classList.toggle("rp-bottom", pos === "bottom");
    mod.classList.toggle("rp-off", pos === "off");
    $("#reading-pane").hidden = pos === "off";
    $("#reading-pane").previousElementSibling.hidden = pos === "off";
    const lp = $("#list-pane");
    lp.style.width = pos === "right" && this.widths && this.widths["list-pane"] > 100 ? this.widths["list-pane"] + "px" : "";
    lp.style.height = pos === "bottom" && this.heights && this.heights["list-pane"] > 80 ? this.heights["list-pane"] + "px" : "";
    this.mail.list.setCompact(pos !== "right");
    if (pos === "off") this.mail.reader.showEmpty();
    else if (this.mail.selection().length === 1) this.mail.reader.show(this.mail.selection()[0]);
    if (this.ribbon) this.ribbon.set("reading-pane", { icon: "reading-" + pos });
    if (remember) messenger.storage.local.set({ readingPane: pos }).catch(() => {});
  }

  setFolderPane(on) {
    $("#side").classList.toggle("min", !on);
    $("#side-mail").hidden = !on || this.module !== "mail";
  }

  fileMenu(el) {
    showMenu([
      { header: "Account Information" },
      { label: "Add Account…", icon: "account-add", action: () => messenger.sgmail.openTool("accountSetup") },
      { label: "Account Settings…", icon: "settings", action: () => messenger.sgmail.openTool("accountSettings") },
      { separator: true },
      { label: "Open & Export", icon: "import", submenu: [
        { label: "Open Calendar (.ics)…", action: () => this.calendar.importIcs() },
        { label: "Export Calendar (.ics)…", action: () => this.calendar.exportIcs() },
        { label: "Add Network Calendar…", action: () => messenger.sgmail.openTool("newCalendar") },
      ] },
      { label: "Print…", icon: "print", shortcut: "Ctrl+P", action: () => this.mail.reader.print() },
      { separator: true },
      { label: "Options", icon: "settings", action: () => messenger.sgmail.openTool("options") },
      { label: "Message Filters…", icon: "filter", action: () => messenger.sgmail.openTool("filters") },
      { label: "About SG Mail", icon: "info", action: () => this.about() },
      { separator: true },
      { label: "Exit", action: () => window.close() },
    ], el);
  }

  about() {
    dialog({
      title: "About SG Mail",
      width: 480,
      body: `<p><b>SG Mail</b>: Stained Glass OS's mail and calendar.</p>
        <p>SG Mail is built on <b>Mozilla Thunderbird</b>, which does the work underneath: the accounts and their sign-in,
        IMAP, POP and SMTP, the calendar, the address book and the messages kept on this computer. Thunderbird is free
        software by the Mozilla Foundation and its contributors under the Mozilla Public License 2.0; it is updated with
        the rest of the system. SG Mail's window is its own (AGPL-3.0-or-later) and Thunderbird remains Thunderbird.</p>
        <p style="color:var(--muted)">Thunderbird's own information: File &gt; Options &gt; About.</p>`,
      buttons: [
        { label: "About Thunderbird", value: "tb" },
        { label: "OK", value: true, primary: true },
      ],
    }).then(v => v === "tb" && messenger.sgmail.openTool("about"));
  }

  // "Tell me what you want to do": the ribbon's commands by name
  tellMe(text, input) {
    const words = text.toLowerCase();
    const commands = [
      ["new email message mail", () => this.mail.compose({ mode: "new" })],
      ["new appointment", () => this.calendar.newEvent({})],
      ["new meeting", () => this.calendar.newEvent({ meeting: true })],
      ["add account", () => messenger.sgmail.openTool("accountSetup")],
      ["account settings", () => messenger.sgmail.openTool("accountSettings")],
      ["options settings preferences", () => messenger.sgmail.openTool("options")],
      ["address book contacts people", () => this.showModule("people")],
      ["new contact", () => this.newContact()],
      ["new contact group", () => this.newContact(true)],
      ["send receive", () => this.sendReceive()],
      ["work offline", () => this.toggleOffline()],
      ["calendar", () => this.showModule("calendar")],
      ["mail inbox", () => this.showModule("mail")],
      ["filters rules", () => messenger.sgmail.openTool("filters")],
      ["import ics calendar", () => this.calendar.importIcs()],
    ];
    const hit = commands.find(([k]) => words.split(/\s+/).every(w => k.includes(w))) || commands.find(([k]) => words.split(/\s+/).some(w => k.includes(w)));
    if (hit) {
      input.value = "";
      hit[1]();
    } else toast(`No command for "${text}"`);
  }

  // ---- send / receive and offline --------------------------------------------------------------------

  async sendReceive() {
    this.setRightStatus("Send/Receive…");
    try {
      await messenger.sgmail.getNewMail(this.mail.folder ? this.mail.folder.id : null);
      if (this.mail.folder) await messenger.sgmail.updateFolder(this.mail.folder.id);
      await this.mail.reload(true);
      this.setRightStatus(this.offline ? "Working Offline" : "All folders are up to date.");
    } catch (e) {
      this.setRightStatus("Send/Receive error: " + e.message);
    }
    this.calendar.refresh();
  }

  async toggleOffline() {
    this.offline = await messenger.sgmail.setOffline(!this.offline);
    this.setRightStatus(this.offline ? "Working Offline" : "Connected");
    this.updateRibbon();
  }

  setRightStatus(text) {
    $("#status-right").textContent = text;
  }

  async wireStatus() {
    try {
      this.offline = await messenger.sgmail.isOffline();
    } catch (e) {
      this.offline = false;
    }
    this.setRightStatus(this.offline ? "Working Offline" : "Connected");
  }

  // ---- compose -------------------------------------------------------------------------------------------

  async compose(args) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args || {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    await messenger.windows.create({ type: "popup", url: messenger.runtime.getURL("ui/compose.html?" + q.toString()), width: 1000, height: 760, allowScriptsToClose: true });
  }

  // ---- keys ------------------------------------------------------------------------------------------------

  wireKeys() {
    document.addEventListener("keydown", e => this.onKey(e));
  }

  onKey(e) {
    if (document.querySelector(".modal-shade")) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t && t.isContentEditable);
    const ctrl = e.ctrlKey || e.metaKey, shift = e.shiftKey, alt = e.altKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const m = this.mail;
    const cal = this.calendar;
    const run = fn => {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      fn();
    };
    // anywhere
    if (ctrl && !shift && !alt && key === "1") return run(() => this.showModule("mail"));
    if (ctrl && !shift && !alt && key === "2") return run(() => this.showModule("calendar"));
    if (ctrl && !shift && !alt && key === "3") return run(() => this.showModule("people"));
    if (ctrl && shift && key === "m") return run(() => m.compose({ mode: "new" }));
    if (ctrl && shift && key === "a") return run(() => cal.newEvent({}));
    if (ctrl && shift && key === "q") return run(() => cal.newEvent({ meeting: true }));
    if (key === "F9" && !ctrl && !shift) return run(() => this.sendReceive());
    if (key === "F9" && shift) return run(() => m.folder && !m.folder.virtual && messenger.sgmail.updateFolder(m.folder.id).then(() => m.reload(true)));
    if (ctrl && !shift && key === "n") return run(() => this.module === "calendar" ? cal.newEvent({}) : this.module === "people" ? this.people.editContact(null) : m.compose({ mode: "new" }));
    if (ctrl && !shift && key === "e" || key === "F3") return run(() => this.module === "mail" ? $("#search").focus() : this.module === "people" ? $("#pp-search").focus() : null);
    if (ctrl && shift && key === "i") return run(() => {
      this.showModule("mail");
      const inbox = m.folder && m.folders.inbox(m.folder.accountId) || m.folders.firstInbox();
      inbox && m.folders.select(inbox.id);
    });
    if (this.module === "people") {
      if (!typing && key === "Delete") return run(() => this.people.deleteSelected());
      return;
    }
    if (this.module === "calendar") {
      if (ctrl && alt && key === "1") return run(() => cal.setView("day"));
      if (ctrl && alt && key === "2") return run(() => cal.setView("workweek"));
      if (ctrl && alt && key === "3") return run(() => cal.setView("week"));
      if (ctrl && alt && key === "4") return run(() => cal.setView("month"));
      if (!typing && key === "Delete") return run(() => cal.deleteSelected());
      if (!typing && alt && key === "ArrowLeft") return run(() => cal.step(-1));
      if (!typing && alt && key === "ArrowRight") return run(() => cal.step(1));
      if (!typing && ctrl && key === "t") return run(() => cal.today());
      // time picked in the grid (or days in the month): Enter opens a new
      // appointment for it, typing writes one in place
      if (!typing && key === "Enter" && cal.selection && !cal.selectedEvent) return run(() => cal.newEvent(Object.assign({}, cal.selection)));
      if (!typing && !ctrl && !alt && e.key.length === 1 && e.key !== " " && cal.selection && !cal.selectedEvent) return run(() => cal.quickCreate(e.key));
      return;
    }
    if (key === "Escape" && t === $("#search")) return run(() => m.clearSearch());
    if (typing) return;
    const sel = m.selection();
    if (ctrl && !shift && key === "r") return run(() => sel[0] && m.compose({ mode: "reply", id: sel[0].id }));
    if (ctrl && shift && key === "r") return run(() => sel[0] && m.compose({ mode: "replyAll", id: sel[0].id }));
    if (ctrl && !shift && key === "f") return run(() => sel[0] && m.compose({ mode: "forward", id: sel[0].id }));
    if (ctrl && !shift && key === "q") return run(() => m.markRead(sel, true));
    if (ctrl && !shift && key === "u") return run(() => m.markRead(sel, false));
    if (ctrl && shift && key === "v") return run(() => m.moveDialog());
    if (key === "Insert") return run(() => m.flag(sel));
    if (key === "Delete") return run(() => m.deleteSelected(shift));
    if (key === "Backspace" && !ctrl) return run(() => m.archiveSelected());
    if (ctrl && key === "p") return run(() => m.reader.print());
  }

  // ---- splitters ---------------------------------------------------------------------------------------------

  async wireSplitters() {
    const st = await messenger.storage.local.get(["widths", "heights"]).catch(() => ({}));
    const widths = this.widths = st.widths || {};
    const heights = this.heights = st.heights || {};
    for (const [id, w] of Object.entries(widths)) {
      const el = document.getElementById(id);
      if (el && w > 100 && !(id === "list-pane" && this.readingPane && this.readingPane !== "right")) el.style.width = w + "px";
    }
    if (this.readingPane === "bottom" && heights["list-pane"] > 80) $("#list-pane").style.height = heights["list-pane"] + "px";
    for (const sp of $$(".splitter")) {
      sp.addEventListener("mousedown", e => {
        const target = document.getElementById(sp.dataset.for);
        if (!target) return;
        // the reading pane at the bottom: the splitter between them is a row
        const vertical = target.id === "list-pane" && this.readingPane === "bottom";
        const startX = e.clientX, startY = e.clientY;
        const startW = target.getBoundingClientRect().width, startH = target.getBoundingClientRect().height;
        const move = ev => {
          if (vertical) target.style.height = Math.max(120, Math.min(window.innerHeight * 0.75, startH + ev.clientY - startY)) + "px";
          else target.style.width = Math.max(160, Math.min(window.innerWidth * 0.6, startW + ev.clientX - startX)) + "px";
        };
        const up = () => {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          if (vertical) {
            heights[target.id] = target.getBoundingClientRect().height;
            messenger.storage.local.set({ heights }).catch(() => {});
          } else {
            widths[target.id] = target.getBoundingClientRect().width;
            messenger.storage.local.set({ widths }).catch(() => {});
          }
          this.mail.list.draw();
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
        e.preventDefault();
      });
    }
  }
}

const app = new App();
window.sgmail = app;
installTestHook("main", {
  mail: () => app.mail.dump(),
  calendar: () => app.calendar.dump(),
  people: () => app.people.dump(),
  selectFolder: a => {
    const f = [...app.mail.folders.folders.values()].find(x => (a.account ? x.accountId === a.account || app.mail.accountLabel(x) === a.account : true)
      && (x.name === a.name || app.mail.folders.el.querySelector(`.fp-row[data-id="${CSS.escape(x.id)}"] .fp-name`)?.textContent === a.name));
    if (!f) throw new Error("no folder " + a.name);
    app.mail.folders.select(f.id);
    return f.id;
  },
  selectMessage: a => {
    const m = app.mail.list.messages.find(x => x.subject === a.subject);
    if (!m) throw new Error("no message " + a.subject);
    app.mail.list.select(m.id);
    return m.id;
  },
  showModule: a => app.showModule(a.name),
  sendReceive: () => app.sendReceive(),
  calendarDate: a => {
    app.calendar.date = new Date(a.y, a.m - 1, a.d);
    app.calendar.render();
    return app.calendar.refresh();
  },
  calendarView: a => app.calendar.setView(a.view),
  newEvent: a => app.calendar.newEvent(a),
  compose: a => app.compose(a),
  importIcs: async a => messenger.sgmail.calendarImport(app.calendar.calendars.find(c => c.name === a.calendar).id, a.ics),
  calendarSelect: a => {
    const ev = app.calendar.events.find(e => e.title === a.title);
    if (!ev) throw new Error("no event " + a.title);
    app.calendar.selectEvent(ev);
    return true;
  },
  openEvent: a => {
    const ev = app.calendar.events.find(e => e.title === a.title);
    if (!ev) throw new Error("no event " + a.title);
    return app.calendar.openEvent(ev).then(() => true);
  },
  extras: () => messenger.sgmail.messageExtras(app.mail.list.messages.map(m => m.id)),
});
app.start().catch(e => {
  console.error("sg-mail: start", e);
  testDump("ready.json", { ready: false, error: String(e), stack: e.stack });
});
