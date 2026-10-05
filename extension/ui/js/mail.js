/*
 * SG Mail -- Mail: the folder pane, the message list and the reading pane
 * together, and what the ribbon's Home tab, the keys and the menus do with
 * them. Everything is Thunderbird's: its accounts, folders and messages
 * (messenger.* APIs); sending goes through the sgmail experiment.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, esc, showMenu, toast, debounce, displayName, confirmBox, dialog, testDump } from "./util.js";
import { FolderPane, roleOf, folderLabel } from "./folders.js";
import { MessageList } from "./msglist.js";
import { ReadingPane } from "./reader.js";

export class MailModule {
  constructor(app) {
    this.app = app;
    this.folder = null;
    this.search = { text: "", scope: "mailbox" };
    this.folders = new FolderPane($("#folder-pane"), {
      onSelect: f => this.openFolder(f),
      onDropMessages: (ids, folderId, copy) => this.moveTo(ids.map(id => ({ id })), folderId, copy),
    });
    this.folders.onCounts = (id, info) => {
      if (!this.folder || this.folder.id !== id) return;
      this.updateStatus();
      // the folder holds more (or fewer) than the list shows: list it again
      if (!this.search.text && info.total !== undefined && info.total !== this.list.messages.length) this.reloadSoon();
    };
    this.list = new MessageList($("#message-list"), {
      onSelect: sel => this.onSelection(sel),
      onOpen: m => this.openMessage(m),
      onContext: (sel, at) => this.contextMenu(sel, at),
      onFlag: m => this.flag([m]),
    });
    this.reader = new ReadingPane($("#reading-pane"), {
      reply: m => this.compose({ mode: "reply", id: m.id }),
      replyAll: m => this.compose({ mode: "replyAll", id: m.id }),
      forward: m => this.compose({ mode: "forward", id: m.id }),
      compose: args => this.compose(args),
      markRead: (msgs, read) => this.markRead(msgs, read),
      viewSource: m => this.viewSource(m),
      openFolderOf: m => this.showInFolder(m),
    });
    this.reloadSoon = debounce(() => this.reload(true), 300);
    this.wire();
  }

  async start() {
    await this.folders.load();
    const inbox = this.folders.firstInbox();
    if (inbox) this.folders.select(inbox.id);
    else this.list.setMessages([]);
  }

  wire() {
    $("#search").addEventListener("input", debounce(() => this.runSearch(), 450));
    $("#search").addEventListener("keydown", e => {
      if (e.key === "Enter") this.runSearch();
      if (e.key === "Escape") this.clearSearch();
    });
    $("#search-scope").addEventListener("click", e => showMenu([
      { label: "Current Folder", checked: this.search.scope === "folder", action: () => this.setScope("folder") },
      { label: "Current Mailbox", checked: this.search.scope === "mailbox", action: () => this.setScope("mailbox") },
      { label: "All Mailboxes", checked: this.search.scope === "all", action: () => this.setScope("all") },
    ], e.currentTarget));
    for (const b of document.querySelectorAll(".list-filter")) {
      b.addEventListener("click", () => this.setFilter(b.dataset.filter));
    }
    $("#list-sort").addEventListener("click", e => {
      const s = this.list.sort;
      const pick = by => () => {
        this.list.sort = { by, desc: by === s.by ? s.desc : by === "date" || by === "size" };
        this.relayout();
      };
      showMenu([
        { header: "Arrange by" },
        { label: "Date", checked: s.by === "date", action: pick("date") },
        { label: "From", checked: s.by === "from", action: pick("from") },
        { label: "Subject", checked: s.by === "subject", action: pick("subject") },
        { label: "Size", checked: s.by === "size", action: pick("size") },
        { separator: true },
        { label: s.desc ? "Oldest on Top" : "Newest on Top", action: () => {
          this.list.sort = { by: s.by, desc: !s.desc };
          this.relayout();
        } },
      ], e.currentTarget);
    });

    messenger.messages.onUpdated.addListener((message, changed) => {
      this.list.update(message);
      if (this.reader.message && this.reader.message.id === message.id) Object.assign(this.reader.message, message);
      this.app.updateRibbon();
    });
    messenger.messages.onDeleted.addListener(list => {
      this.list.remove(list.messages.map(m => m.id));
    });
    messenger.messages.onMoved.addListener((original, moved) => {
      this.list.remove(original.messages.map(m => m.id));
      if (this.folder && !this.search.text) {
        const here = moved.messages.filter(m => m.folder && m.folder.id === this.folder.id);
        if (here.length) this.list.add(here);
      }
    });
    messenger.messages.onCopied?.addListener((original, copied) => {
      if (this.folder && !this.search.text) {
        const here = copied.messages.filter(m => m.folder && m.folder.id === this.folder.id);
        if (here.length) this.list.add(here);
      }
    });
    messenger.messages.onNewMailReceived.addListener((folder, list) => this.onNewMail(folder, list));
    messenger.notifications.onClicked.addListener(id => this.onNotificationClicked(id));
  }

  // ---- folders and lists --------------------------------------------------------------

  async openFolder(f) {
    this.folder = f;
    this.clearSearch(false);
    this.list.folderRole = roleOf(f);
    $("#search").placeholder = this.search.scope === "folder" ? `Search ${folderLabel(f)}` : this.search.scope === "all" ? "Search All Mailboxes" : "Search Current Mailbox";
    this.title = `${folderLabel(f)} - ${this.accountLabel(f)}`;
    this.app.setTitle(this.title);
    this.reader.showEmpty();
    await this.reload(false);
    // the server's news for this folder, then the list again
    messenger.sgmail.updateFolder(f.id).then(() => {
      (this.synced = this.synced || new Set()).add(f.id);
      if (this.folder && this.folder.id === f.id && !this.search.text) this.reload(true);
    }, () => {});
  }

  accountLabel(f) {
    const a = this.folders.accounts.find(x => x.id === f.accountId);
    if (!a) return "On This Computer";
    return (a.identities[0] || {}).email || a.name;
  }

  async listFolder(folderId) {
    const out = [];
    let page = await messenger.messages.list(folderId);
    out.push(...page.messages);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      out.push(...page.messages);
    }
    return out;
  }

  async reload(keepSelection) {
    if (!this.folder) return;
    const f = this.folder;
    if (!keepSelection) {
      this.list.setLoading(true);
      this.list.setMessages([]);
    }
    let msgs = [];
    try {
      msgs = await this.listFolder(f.id);
    } catch (e) {
      console.error("sg-mail: list", e);
    }
    if (this.folder !== f || this.search.text) return;
    this.list.setLoading(false);
    this.list.emptyText = this.list.filter === "unread" ? "No unread items." : "We didn't find anything to show here.";
    this.list.setMessages(msgs, { keepSelection });
    this.updateStatus();
    this.dumpSoon();
  }

  relayout() {
    this.list.layout();
    this.list.draw(true);
    $("#list-sort").innerHTML = `By ${{ date: "Date", from: "From", subject: "Subject", size: "Size" }[this.list.sort.by]} <span class="sort-dir">${this.list.sort.desc ? "&#8595;" : "&#8593;"}</span>`;
  }

  setFilter(filter) {
    this.list.filter = filter;
    for (const b of document.querySelectorAll(".list-filter")) b.classList.toggle("active", b.dataset.filter === filter);
    this.list.emptyText = filter === "unread" ? "No unread items." : filter === "flagged" ? "No flagged items." : "We didn't find anything to show here.";
    this.relayout();
    this.app.ribbon.toggle("filter-unread", filter === "unread");
  }

  setScope(scope) {
    this.search.scope = scope;
    $("#search-scope").textContent = { folder: "Current Folder", mailbox: "Current Mailbox", all: "All Mailboxes" }[scope];
    $("#search").placeholder = scope === "folder" && this.folder ? `Search ${folderLabel(this.folder)}` : scope === "all" ? "Search All Mailboxes" : "Search Current Mailbox";
    if (this.search.text) this.runSearch();
  }

  async runSearch() {
    const text = $("#search").value.trim();
    if (!text) return this.clearSearch();
    this.search.text = text;
    const token = (this.searchToken = Symbol("search"));
    this.list.setLoading(true);
    this.list.setMessages([]);
    // folders this session has not looked at yet: their headers first, so
    // the search sees them (Thunderbird searches what it has)
    this.synced = this.synced || new Set();
    const scope = [...this.folders.folders.values()].filter(f => !this.synced.has(f.id) && roleOf(f) !== "outbox" &&
      (this.search.scope === "all" || (this.search.scope === "mailbox" && this.folder && f.accountId === this.folder.accountId) ||
       (this.search.scope === "folder" && this.folder && f.id === this.folder.id)));
    if (scope.length) {
      this.app.setStatus("Searching…");
      const queue = [...scope];
      await Promise.all([0, 1, 2].map(async () => {
        while (queue.length) {
          const f = queue.shift();
          try {
            await messenger.sgmail.updateFolder(f.id);
            this.synced.add(f.id);
          } catch (e) {
            // offline: what is kept
          }
        }
      }));
      if (this.searchToken !== token) return;
    }
    const q = { fullText: text, messagesPerPage: 200 };
    if (this.search.scope === "folder" && this.folder) q.folderId = this.folder.id;
    else if (this.search.scope === "mailbox" && this.folder) {
      if (this.folder.accountId) q.accountId = this.folder.accountId;
    }
    const out = [];
    try {
      let page = await messenger.messages.query(q);
      out.push(...page.messages);
      while (page.id && out.length < 2000) {
        page = await messenger.messages.continueList(page.id);
        out.push(...page.messages);
      }
    } catch (e) {
      console.error("sg-mail: search", e);
    }
    if (this.searchToken !== token) return;
    this.list.setLoading(false);
    this.list.emptyText = "We didn't find anything to show here.";
    this.list.folderRole = "";
    this.list.setMessages(out);
    this.app.setStatus(`${out.length} result${out.length === 1 ? "" : "s"} for "${text}"`);
    this.dumpSoon();
  }

  clearSearch(reload = true) {
    if (!this.search.text && $("#search").value === "") return;
    $("#search").value = "";
    this.search.text = "";
    this.searchToken = null;
    if (this.folder) this.list.folderRole = roleOf(this.folder);
    if (reload) this.reload(false);
  }

  updateStatus() {
    if (!this.folder || this.search.text) return;
    const info = this.folders.info.get(this.folder.id) || {};
    const n = this.list.messages.length || info.total || 0;
    this.app.setStatus(`Items: ${n}` + (info.unread ? `    Unread: ${info.unread}` : ""));
  }

  // ---- selection and reading ------------------------------------------------------------

  selection() {
    return this.list.selection();
  }

  onSelection(sel) {
    this.app.updateRibbon();
    if (sel.length === 1) this.reader.show(sel[0]);
    else if (sel.length > 1) this.reader.showMany(sel.length);
    else this.reader.showEmpty();
    this.dumpSoon();
  }

  openMessage(m) {
    // drafts open to be written on; other messages in their own window
    if (roleOf(this.folder || {}) === "drafts") return this.compose({ mode: "draft", id: m.id });
    messenger.messageDisplay.open({ messageId: m.id, location: "window" }).catch(() => {});
  }

  async showInFolder(m) {
    if (!m.folder) return;
    this.folders.select(m.folder.id);
    setTimeout(() => this.list.select(m.id), 600);
  }

  async viewSource(m) {
    try {
      const raw = await messenger.messages.getRaw(m.id, { data_format: "File" });
      const text = await raw.text();
      const pre = h("pre", { style: "white-space:pre-wrap;font:12px monospace;max-height:70vh;overflow:auto;user-select:text;-moz-user-select:text", text });
      await dialog({ title: "Message Source", body: pre, width: 820 });
    } catch (e) {
      toast("The source could not be shown: " + e.message);
    }
  }

  // ---- actions --------------------------------------------------------------------------

  compose(args) {
    return this.app.compose(Object.assign({ identity: this.currentIdentity() }, args));
  }

  currentIdentity() {
    const f = this.folder;
    const a = f && this.folders.accounts.find(x => x.id === f.accountId);
    return a && a.identities[0] ? a.identities[0].id : "";
  }

  async markRead(msgs, read) {
    for (const m of msgs) {
      if (m.read === read) continue;
      m.read = read;
      this.list.update(m);
      try {
        await messenger.messages.update(m.id, { read });
      } catch (e) {
        console.error(e);
      }
    }
    this.app.updateRibbon();
  }

  toggleRead() {
    const sel = this.selection();
    if (!sel.length) return;
    this.markRead(sel, !sel.every(m => m.read));
  }

  async flag(msgs) {
    if (!msgs.length) return;
    const on = !msgs.every(m => m.flagged);
    for (const m of msgs) {
      m.flagged = on;
      this.list.update(m);
      await messenger.messages.update(m.id, { flagged: on });
    }
    this.app.updateRibbon();
  }

  async deleteSelected(permanent = false) {
    const sel = this.selection();
    if (!sel.length) return;
    const ids = sel.map(m => m.id);
    const inTrash = this.folder && roleOf(this.folder) === "trash";
    if ((permanent || inTrash) && !(await confirmBox("SG Mail", `The selected ${ids.length > 1 ? ids.length + " items" : "item"} will be permanently deleted.`, "OK", "Cancel"))) return;
    this.list.remove(ids);
    try {
      await messenger.messages.delete(ids, permanent || inTrash ? { deletePermanently: true } : {});
    } catch (e) {
      toast("Could not delete: " + e.message);
      this.reload(true);
    }
  }

  async archiveSelected() {
    const sel = this.selection();
    if (!sel.length) return;
    this.list.remove(sel.map(m => m.id));
    try {
      await messenger.messages.archive(sel.map(m => m.id));
    } catch (e) {
      toast("Could not archive: " + e.message);
      this.reload(true);
    }
  }

  async junkSelected(junk = true) {
    const sel = this.selection();
    if (!sel.length || !this.folder) return;
    for (const m of sel) await messenger.messages.update(m.id, { junk });
    const target = this.folders.folderByRole(this.folder.accountId, junk ? "junk" : "inbox");
    if (target && target.id !== this.folder.id) await this.moveTo(sel, target.id);
  }

  async moveTo(msgs, folderId, copy = false) {
    const ids = msgs.map(m => m.id);
    if (!ids.length) return;
    try {
      if (copy) await messenger.messages.copy(ids, folderId);
      else {
        this.list.remove(ids);
        await messenger.messages.move(ids, folderId);
      }
    } catch (e) {
      toast("Could not move: " + e.message);
      this.reload(true);
    }
  }

  async moveDialog(copy = false) {
    const sel = this.selection();
    if (!sel.length) return;
    const target = await this.folders.pickFolder(copy ? "Copy Items" : "Move Items", this.folder && this.folder.accountId);
    if (target) await this.moveTo(sel, target, copy);
  }

  moveMenu() {
    const sel = this.selection();
    const items = [];
    if (this.folder) {
      for (const role of ["inbox", "archives", "junk", "trash"]) {
        const f = this.folders.folderByRole(this.folder.accountId, role);
        if (f && f.id !== this.folder.id) items.push({ label: folderLabel(f), icon: "folder", action: () => this.moveTo(sel, f.id) });
      }
    }
    items.push({ separator: true }, { label: "Other Folder…", shortcut: "Ctrl+Shift+V", action: () => this.moveDialog() },
      { label: "Copy to Folder…", action: () => this.moveDialog(true) });
    return items;
  }

  contextMenu(sel, at) {
    if (!sel.length) return;
    const one = sel.length === 1;
    const unread = sel.some(m => !m.read);
    showMenu([
      { label: "Reply", icon: "reply", shortcut: "Ctrl+R", disabled: !one, action: () => this.compose({ mode: "reply", id: sel[0].id }) },
      { label: "Reply All", icon: "reply-all", shortcut: "Ctrl+Shift+R", disabled: !one, action: () => this.compose({ mode: "replyAll", id: sel[0].id }) },
      { label: "Forward", icon: "forward", shortcut: "Ctrl+F", disabled: !one, action: () => this.compose({ mode: "forward", id: sel[0].id }) },
      { separator: true },
      unread ? { label: "Mark as Read", icon: "mail-read", shortcut: "Ctrl+Q", action: () => this.markRead(sel, true) }
        : { label: "Mark as Unread", icon: "mail-unread", shortcut: "Ctrl+U", action: () => this.markRead(sel, false) },
      { label: sel.every(m => m.flagged) ? "Clear Flag" : "Flag", icon: "flag", shortcut: "Insert", action: () => this.flag(sel) },
      { separator: true },
      { label: "Move", icon: "move", submenu: this.moveMenu() },
      { label: "Junk", icon: "junk", submenu: [
        { label: "Block Sender / Junk", action: () => this.junkSelected(true) },
        { label: "Not Junk", action: () => this.junkSelected(false) },
      ] },
      { label: "Archive", icon: "archive", shortcut: "Backspace", action: () => this.archiveSelected() },
      { label: "Delete", icon: "delete", shortcut: "Delete", action: () => this.deleteSelected() },
    ], at);
  }

  // ---- new mail ---------------------------------------------------------------------------

  async onNewMail(folder, list) {
    if (this.folder && folder.id === this.folder.id && !this.search.text) this.list.add(list.messages);
    if ((folder.specialUse || []).includes("junk")) return;
    const msgs = list.messages.filter(m => !m.read && !m.junk);
    if (!msgs.length) return;
    this.app.setStatus(`${msgs.length} new message${msgs.length > 1 ? "s" : ""}`);
    try {
      const m = msgs[msgs.length - 1];
      const id = "sgmail-new-" + m.id;
      this.notified = this.notified || new Map();
      this.notified.set(id, m);
      await messenger.notifications.create(id, {
        type: "basic",
        title: msgs.length > 1 ? `${msgs.length} new messages` : displayName(m.author),
        message: msgs.length > 1 ? `${displayName(m.author)}: ${m.subject || "(no subject)"}` : (m.subject || "(no subject)"),
        iconUrl: browser.runtime.getURL("icons/sg-mail.svg"),
      });
      this.app.notifications.push({ kind: "mail", title: displayName(m.author), message: m.subject, count: msgs.length });
      this.dumpSoon();
    } catch (e) {
      console.error("sg-mail: notification", e);
    }
  }

  async onNotificationClicked(id) {
    const m = this.notified && this.notified.get(id);
    if (!m) return;
    await this.app.focusWindow();
    this.app.showModule("mail");
    if (m.folder) {
      this.folders.select(m.folder.id);
      setTimeout(() => this.list.select(m.id), 800);
    }
  }

  // ---- the gates ---------------------------------------------------------------------------

  dumpSoon = debounce(() => this.dump(), 200);

  dump() {
    const counts = {};
    for (const [id, info] of this.folders.info) {
      const f = this.folders.folders.get(id);
      if (f) counts[`${this.accountLabel(f)}/${folderLabel(f)}`] = { unread: info.unread || 0, total: info.total || 0 };
    }
    const tree = [...document.querySelectorAll("#folder-pane .fp-section, #folder-pane .fp-row")].map(el =>
      el.classList.contains("fp-section") ? "# " + el.textContent.trim() : `${el.querySelector(".fp-name")?.textContent || ""} [${el.querySelector(".fp-count")?.textContent || ""}]${el.classList.contains("selected") ? " *" : ""}`);
    const data = {
      folder: this.folder ? { id: this.folder.id, name: folderLabel(this.folder) } : null,
      search: this.search.text,
      tree,
      counts,
      list: this.list.dump(),
      reader: this.reader.dump(),
      notifications: this.app.notifications,
      title: document.title,
      status: $("#status-left").textContent,
    };
    testDump("mail.json", data);
    return data;
  }
}
