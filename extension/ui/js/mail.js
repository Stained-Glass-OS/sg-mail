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
import { h, $, esc, showMenu, toast, debounce, displayName, parseAddress, confirmBox, dialog, testDump } from "./util.js";
import { FolderPane, roleOf, folderLabel } from "./folders.js";
import { MessageList, baseSubject } from "./msglist.js";
import { ReadingPane } from "./reader.js";
import { groupConversations, conversationIds, redundantMessages, messageText } from "./conversations.js";

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
      onFlag: m => this.flag(Array.isArray(m) ? m : [m]),
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
    this.folders.onRefreshed = () => this.syncSentForFocus();
    // the Focused Inbox: on as Outlook's; "Move to Focused/Other" for one
    // message (by its Message-ID) or always for its sender
    this.focus = { on: true, rules: {}, msgs: {}, info: new Map() };
    this.list.focusFilter = null;
    this.list.focusTab = "focused";
    // conversations: what each listed message names (Message-IDs), and the
    // conversations ignored (their Message-IDs: new ones go to Deleted Items)
    this.convInfo = new Map();
    this.ignored = new Set();
    this.wire();
  }

  async start() {
    await this.loadTags();
    try {
      const st = await messenger.storage.local.get(["focusedInbox", "focusRules", "focusMsgs", "conversations", "ignoredConvs"]);
      this.focus.on = st.focusedInbox !== false;
      this.focus.rules = st.focusRules || {};
      this.focus.msgs = st.focusMsgs || {};
      this.list.conversations = !!st.conversations;
      this.ignored = new Set(st.ignoredConvs || []);
    } catch (e) {
      // first start
    }
    await this.folders.load();
    const inbox = this.folders.firstInbox();
    if (inbox) this.folders.select(inbox.id);
    else this.list.setMessages([]);
    this.syncSentForFocus();
    // the first account added while SG Mail runs: its Inbox, once its server
    // has listed it
    messenger.accounts.onCreated.addListener(async () => {
      for (let i = 0; i < 40 && !this.folder; i++) {
        await new Promise(r => setTimeout(r, 500));
        await this.folders.refresh();
        const first = this.folders.firstInbox();
        if (first && !this.folder) this.folders.select(first.id);
      }
    });
  }

  // the people written to are in the Sent folders: their news first (an
  // IMAP account's Sent is not looked at otherwise), then decide again
  async syncSentForFocus() {
    if (!this.focus.on) return;
    // (a new account's folders get their roles once its server has listed them)
    this.focus.sentSynced = this.focus.sentSynced || new Set();
    const sent = this.folders.accounts.map(a => this.folders.folderByRole(a.id, "sent")).filter(f => f && !this.focus.sentSynced.has(f.id));
    if (!sent.length) return;
    for (const f of sent) this.focus.sentSynced.add(f.id);
    await Promise.all(sent.map(f => messenger.sgmail.updateFolder(f.id).catch(() => {})));
    this.focus.info.clear();
    this.focus.fresh = true;
    if (this.focusShown()) this.reload(true);
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
    $(".list-filters").addEventListener("click", e => {
      const b = e.target.closest(".list-filter");
      if (!b) return;
      if (b.dataset.focus) this.setFocusTab(b.dataset.focus);
      else this.setFilter(b.dataset.filter);
    });
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
      if (changed && "read" in changed) this.paintFocusTabs();
      if (this.reader.message && this.reader.message.id === message.id) {
        Object.assign(this.reader.message, message);
        if (changed && "tags" in changed) this.reader.paintCategories();
      }
      this.app.updateRibbon();
    });
    messenger.messages.onDeleted.addListener(list => {
      this.list.remove(list.messages.map(m => m.id));
    });
    messenger.messages.onMoved.addListener((original, moved) => {
      this.list.remove(original.messages.map(m => m.id));
      if (this.folder && !this.search.text) {
        const here = moved.messages.filter(m => m.folder && m.folder.id === this.folder.id);
        if (here.length) this.addToList(here);
      }
    });
    messenger.messages.onCopied?.addListener((original, copied) => {
      if (this.folder && !this.search.text) {
        const here = copied.messages.filter(m => m.folder && m.folder.id === this.folder.id);
        if (here.length) this.addToList(here);
      }
    });
    messenger.messages.onNewMailReceived.addListener((folder, list) => this.onNewMail(folder, list));
    // a new contact is someone known: the Focused Inbox decides again
    const contactsChanged = debounce(() => {
      this.focus.info.clear();
      if (this.focusShown()) this.reload(true);
    }, 500);
    for (const ev of ["onCreated", "onUpdated", "onDeleted"]) messenger.addressBooks.contacts?.[ev]?.addListener(contactsChanged);
    messenger.notifications.onClicked.addListener(id => this.onNotificationClicked(id));
  }

  // ---- folders and lists --------------------------------------------------------------

  async openFolder(f) {
    this.folder = f;
    this.focus.info.clear();
    this.clearSearch(false);
    this.list.focusTab = "focused";
    this.list.folderRole = roleOf(f);
    $("#search").placeholder = this.search.scope === "folder" ? `Search ${folderLabel(f)}` : this.search.scope === "all" ? "Search All Mailboxes" : "Search Current Mailbox";
    this.title = `${folderLabel(f)} - ${this.accountLabel(f)}`;
    this.app.setTitle(this.title);
    this.reader.showEmpty();
    await this.reload(false);
    if (f.virtual) return;
    // the server's news for this folder, then the list again
    messenger.sgmail.updateFolder(f.id).then(() => {
      (this.synced = this.synced || new Set()).add(f.id);
      if (this.folder && this.folder.id === f.id && !this.search.text) this.reload(true);
    }, () => {});
  }

  accountLabel(f) {
    if (f.virtual) return "Search Folders";
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
      msgs = f.virtual ? await this.searchFolder(f.virtual) : await this.listFolder(f.id);
    } catch (e) {
      console.error("sg-mail: list", e);
    }
    if (this.folder !== f || this.search.text) return;
    if (this.focusShown()) await this.classify(msgs);
    if (this.list.conversations || this.ignored.size) await this.loadConversations(msgs, msgs);
    if (this.folder !== f || this.search.text) return;
    // messages of ignored conversations that came while SG Mail was closed
    if (this.ignored.size) msgs = await this.dropIgnored(msgs);
    this.applyFocus();
    this.list.setLoading(false);
    this.list.emptyText = this.list.filter === "unread" ? "No unread items." : "We didn't find anything to show here.";
    this.list.setMessages(msgs, { keepSelection });
    this.paintFocusTabs();
    this.updateStatus();
    this.dumpSoon();
  }

  // the server's news for folders this session has not looked at yet,
  // three at a time (Thunderbird searches what it has)
  async syncFolders(list) {
    this.synced = this.synced || new Set();
    const queue = list.filter(f => !this.synced.has(f.id));
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
  }

  // a Search Folder's messages: unread (or flagged) anywhere but Deleted
  // Items and Junk Email (and, for Unread Mail, Sent, Drafts and Outbox)
  async searchFolder(kind) {
    const skip = kind === "unread" ? ["trash", "junk", "sent", "drafts", "outbox", "templates"] : ["trash", "junk"];
    await this.syncFolders([...this.folders.folders.values()].filter(f => !skip.includes(roleOf(f))));
    const out = [];
    let page = await messenger.messages.query(kind === "unread" ? { read: false, messagesPerPage: 500 } : { flagged: true, messagesPerPage: 500 });
    out.push(...page.messages);
    while (page.id && out.length < 5000) {
      page = await messenger.messages.continueList(page.id);
      out.push(...page.messages);
    }
    return out.filter(m => {
      const f = m.folder && this.folders.folders.get(m.folder.id);
      return !f || !skip.includes(roleOf(f));
    });
  }

  relayout() {
    this.list.layout();
    this.list.draw(true);
    $("#list-sort").innerHTML = `By ${{ date: "Date", from: "From", subject: "Subject", size: "Size" }[this.list.sort.by]} <span class="sort-dir">${this.list.sort.desc ? "&#8595;" : "&#8593;"}</span>`;
  }

  setFilter(filter) {
    this.list.filter = filter;
    this.renderListTabs();
    this.updateStatus();
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
      await this.syncFolders(scope);
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
    this.applyFocus();
    if (this.list.conversations) await this.loadConversations(out, out);
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

  // ---- conversations ------------------------------------------------------------------------

  // what puts the listed messages in conversations (asked once a message)
  async loadConversations(msgs, universe = null) {
    const want = msgs.filter(m => !this.convInfo.has(m.id)).map(m => m.id);
    for (let i = 0; i < want.length; i += 500) {
      try {
        for (const x of await messenger.sgmail.conversationInfo(want.slice(i, i + 500))) this.convInfo.set(x.id, x);
      } catch (e) {
        console.error("sg-mail: conversations", e);
        break;
      }
    }
    this.groupList(universe || this.list.messages);
  }

  groupList(msgs) {
    const info = msgs.map(m => this.convInfo.get(m.id)).filter(Boolean);
    this.list.convOf = groupConversations(info);
  }

  // View > Show as Conversations: on or off for every folder, remembered
  async setConversations(on) {
    this.list.conversations = !!on;
    messenger.storage.local.set({ conversations: !!on }).catch(() => {});
    if (on) await this.loadConversations(this.list.messages);
    this.list.selected.clear();
    this.relayout();
    this.onSelection([]);
    this.app.updateRibbon();
    this.app.setStatus(on ? "Showing messages as conversations" : "Showing messages one by one");
  }

  // the messages of a conversation wherever they are in the account (one's
  // own replies in Sent Items), newest first
  async conversationItems(msgs) {
    const info = msgs.map(m => this.convInfo.get(m.id)).filter(Boolean);
    const folderId = (msgs[0].folder && msgs[0].folder.id) || (this.folder && !this.folder.virtual && this.folder.id);
    let found = [];
    if (folderId && info.length) {
      try {
        found = await messenger.sgmail.conversationMessages(folderId, conversationIds(info));
      } catch (e) {
        console.error("sg-mail: conversation", e);
      }
    }
    const items = new Map(msgs.map(m => [m.id, { msg: m, here: true, folderName: "", role: "" }]));
    for (const x of found) {
      if (items.has(x.id)) continue;
      try {
        const m = await messenger.messages.get(x.id);
        const f = m.folder && this.folders.folders.get(m.folder.id);
        items.set(x.id, { msg: m, here: false, folderName: f ? folderLabel(f) : x.folderName, role: f ? roleOf(f) : x.sent ? "sent" : "" });
      } catch (e) {
        // gone meanwhile
      }
    }
    return [...items.values()].sort((a, b) => b.msg.date - a.msg.date);
  }

  // the reading pane shows the conversation (a lone message as itself
  // when nothing else of its conversation is anywhere)
  async showConversation(msgs, single = false) {
    const token = (this.convToken = Symbol("conv"));
    if (single) await this.loadConversations(msgs);
    const items = await this.conversationItems(msgs);
    if (this.convToken !== token) return;
    if (items.length <= 1) return this.reader.show(msgs[0]);
    this.reader.showConversation(items, { subject: baseSubject(items[items.length - 1].msg.subject) });
    this.dumpSoon();
  }

  // the conversations of messages (all of each, in this list)
  conversationsOf(msgs) {
    const keys = new Set(msgs.map(m => this.list.convOf.get(m.id)).filter(Boolean));
    return this.list.messages.filter(m => keys.has(this.list.convOf.get(m.id)));
  }

  // Clean Up: messages whose whole text a later reply quotes go to Deleted
  // Items -- of the selected conversation, or of the whole folder
  async cleanUp(scope) {
    if (!this.folder || this.folder.virtual) return;
    if (roleOf(this.folder) === "trash") return toast("Clean Up does not work in Deleted Items.");
    let msgs = this.list.messages;
    await this.loadConversations(msgs);
    if (scope === "conversation") {
      const sel = this.selection();
      if (!sel.length) return;
      msgs = this.conversationsOf(sel);
    } else if (scope === "folder" && !(await confirmBox("Clean Up Folder", "Redundant messages in this folder will be moved to the Deleted Items folder.", "Clean Up Folder", "Cancel"))) return;
    this.app.setStatus("Cleaning up…");
    const groups = new Map();
    for (const m of msgs) {
      const k = this.list.convOf.get(m.id);
      if (!k) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const redundant = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const items = [];
      for (const m of [...list].sort((a, b) => a.date - b.date)) items.push({ msg: m, info: this.convInfo.get(m.id), text: await messageText(m.id) });
      redundant.push(...redundantMessages(items));
    }
    if (!redundant.length) {
      this.app.setStatus("No messages were cleaned up.");
      return dialog({ title: "Clean Up", body: "<p>No messages were cleaned up.</p>" });
    }
    this.list.remove(redundant.map(m => m.id));
    try {
      await messenger.messages.delete(redundant.map(m => m.id), {});
    } catch (e) {
      toast("Could not clean up: " + e.message);
      return this.reload(true);
    }
    this.app.setStatus(`Clean Up moved ${redundant.length} message${redundant.length > 1 ? "s" : ""} to Deleted Items`);
  }

  isIgnored(id) {
    const x = this.convInfo.get(id);
    return !!x && (this.ignored.has(x.msgid) || (x.refs || []).some(r => this.ignored.has(r)));
  }

  // Ignore Conversation: its messages, and the ones that come in it, go to
  // Deleted Items. In Deleted Items: Stop Ignoring (back to the Inbox).
  async ignoreConversation(sel) {
    if (!sel.length || !this.folder) return;
    await this.loadConversations(sel);
    if (roleOf(this.folder) === "trash" && sel.some(m => this.isIgnored(m.id))) return this.stopIgnoring(sel);
    const ok = await dialog({
      title: "Ignore Conversation",
      body: "<p>The selected conversation and all future messages will be moved to the Deleted Items folder.</p>",
      buttons: [{ label: "Ignore Conversation", value: true, primary: true }, { label: "Cancel", value: false, cancel: true }],
    });
    if (!ok) return;
    const here = this.conversationsOf(sel);
    const items = await this.conversationItems(here);
    const info = [...here.map(m => this.convInfo.get(m.id)).filter(Boolean)];
    for (const id of conversationIds(info)) this.ignored.add(id);
    await this.saveIgnored();
    // (one's own replies stay in Sent Items)
    const ids = items.filter(it => it.role !== "sent").map(it => it.msg.id);
    this.list.remove(ids);
    try {
      await messenger.messages.delete(ids, {});
    } catch (e) {
      toast("Could not move it: " + e.message);
    }
    this.app.setStatus(`Conversation ignored: ${ids.length} message${ids.length === 1 ? "" : "s"} moved to Deleted Items`);
  }

  async stopIgnoring(sel) {
    const msgs = this.conversationsOf(sel);
    const info = msgs.map(m => this.convInfo.get(m.id)).filter(Boolean);
    for (const id of conversationIds(info)) this.ignored.delete(id);
    await this.saveIgnored();
    const inbox = this.folders.inbox(this.folder.accountId);
    if (inbox) await this.moveTo(msgs, inbox.id);
    this.app.setStatus("The conversation is no longer ignored");
  }

  async saveIgnored() {
    // the last few thousand Message-IDs
    const list = [...this.ignored].slice(-5000);
    this.ignored = new Set(list);
    await messenger.storage.local.set({ ignoredConvs: list }).catch(() => {});
  }

  // messages of ignored conversations: to Deleted Items (their Message-IDs
  // remembered too: replies to them are the conversation)
  async dropIgnored(msgs) {
    const f = msgs[0] && msgs[0].folder && this.folders.folders.get(msgs[0].folder.id);
    if (!msgs.length || (f && ["trash", "sent", "drafts", "outbox"].includes(roleOf(f)))) return msgs;
    const drop = msgs.filter(m => this.isIgnored(m.id));
    if (!drop.length) return msgs;
    for (const m of drop) {
      const x = this.convInfo.get(m.id);
      if (x && x.msgid) this.ignored.add(x.msgid);
    }
    await this.saveIgnored();
    try {
      await messenger.messages.delete(drop.map(m => m.id), {});
      this.app.setStatus(`${drop.length} message${drop.length === 1 ? "" : "s"} of an ignored conversation moved to Deleted Items`);
    } catch (e) {
      console.error("sg-mail: ignore", e);
      return msgs;
    }
    const gone = new Set(drop.map(m => m.id));
    return msgs.filter(m => !gone.has(m.id));
  }

  // ---- the Focused Inbox -------------------------------------------------------------------

  focusShown() {
    return this.focus.on && !!this.folder && roleOf(this.folder) === "inbox" && !this.search.text;
  }

  // what the decision is made by, for the messages not asked about yet
  async classify(msgs) {
    const want = msgs.filter(m => !this.focus.info.has(m.id)).map(m => m.id);
    for (let i = 0; i < want.length; i += 500) {
      try {
        for (const x of await messenger.sgmail.focusInfo(want.slice(i, i + 500), !!this.focus.fresh)) this.focus.info.set(x.id, x);
        this.focus.fresh = false;
      } catch (e) {
        console.error("sg-mail: focused", e);
        break;
      }
    }
  }

  // Focused or Other: the person's own choice for this message, then for
  // its sender; then people they know are Focused, bulk mail Other, and
  // the rest Focused
  focusOf(m) {
    const mine = m.headerMessageId && this.focus.msgs[m.headerMessageId];
    if (mine) return mine;
    const x = this.focus.info.get(m.id) || {};
    const email = x.email || parseAddress(m.author).email.toLowerCase();
    if (this.focus.rules[email]) return this.focus.rules[email];
    if (x.known) return "focused";
    if (x.bulk) return "other";
    return "focused";
  }

  applyFocus() {
    this.list.focusFilter = this.focusShown() ? (m => this.focusOf(m) === this.list.focusTab) : null;
    this.renderListTabs();
  }

  renderListTabs() {
    const box = $(".list-filters");
    const want = this.focusShown() ? "focus" : "filters";
    if (box.dataset.kind !== want) {
      box.dataset.kind = want;
      box.replaceChildren(...(want === "focus"
        ? [h("button", { class: "list-filter", "data-focus": "focused", role: "tab", text: "Focused" }),
          h("button", { class: "list-filter", "data-focus": "other", role: "tab", html: `Other<span class="lf-count"></span>` })]
        : [h("button", { class: "list-filter", "data-filter": "all", role: "tab", text: "All" }),
          h("button", { class: "list-filter", "data-filter": "unread", role: "tab", text: "Unread" })]));
    }
    for (const b of box.querySelectorAll(".list-filter")) {
      const on = want === "focus" ? b.dataset.focus === this.list.focusTab : b.dataset.filter === (this.list.filter === "flagged" ? "all" : this.list.filter);
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    this.paintFocusTabs();
  }

  // the unread messages waiting in the tab not shown, as Outlook's hint
  paintFocusTabs() {
    if (!this.focusShown()) return;
    const other = this.list.focusTab === "focused" ? "other" : "focused";
    const n = this.list.messages.filter(m => !m.read && this.focusOf(m) === other).length;
    for (const b of document.querySelectorAll(".list-filter[data-focus]")) {
      let c = b.querySelector(".lf-count");
      if (!c) b.append(c = h("span", { class: "lf-count" }));
      c.textContent = b.dataset.focus === other && n ? String(n) : "";
    }
  }

  setFocusTab(tab) {
    this.list.focusTab = tab;
    this.renderListTabs();
    this.list.selected.clear();
    this.relayout();
    this.onSelection([]);
    this.dumpSoon();
  }

  async setFocusedInbox(on) {
    this.focus.on = on;
    messenger.storage.local.set({ focusedInbox: on }).catch(() => {});
    if (on && this.folder) await this.classify(this.list.messages);
    this.list.focusTab = "focused";
    this.applyFocus();
    this.relayout();
    this.app.updateRibbon();
    this.dumpSoon();
  }

  // Move to Focused / Other; always: every message from its sender, now and later
  async moveFocus(msgs, target, always = false) {
    if (!msgs.length) return;
    if (always) {
      for (const m of msgs) {
        const x = this.focus.info.get(m.id) || {};
        const email = x.email || parseAddress(m.author).email.toLowerCase();
        if (email) this.focus.rules[email] = target;
        // the sender's rule decides from now on
        if (m.headerMessageId) delete this.focus.msgs[m.headerMessageId];
      }
      await messenger.storage.local.set({ focusRules: this.focus.rules, focusMsgs: this.focus.msgs }).catch(() => {});
    } else {
      for (const m of msgs) if (m.headerMessageId) this.focus.msgs[m.headerMessageId] = target;
      // kept for the last few thousand
      const keys = Object.keys(this.focus.msgs);
      for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete this.focus.msgs[k];
      await messenger.storage.local.set({ focusMsgs: this.focus.msgs }).catch(() => {});
    }
    this.list.selected.clear();
    this.relayout();
    this.onSelection([]);
    this.paintFocusTabs();
    const label = target === "other" ? "Other" : "Focused";
    this.app.setStatus(always ? `Messages from ${displayName(msgs[0].author)} will always go to ${label}` : `Moved to ${label}`);
    this.dumpSoon();
  }

  async addToList(msgs) {
    if (this.focusShown()) await this.classify(msgs);
    if (this.list.conversations || this.ignored.size) {
      await this.loadConversations(msgs, [...this.list.messages, ...msgs]);
      if (this.ignored.size) msgs = await this.dropIgnored(msgs);
    }
    this.list.add(msgs);
    this.paintFocusTabs();
  }

  updateStatus() {
    if (!this.folder || this.search.text || this.app.module !== "mail") return;
    const info = this.folders.info.get(this.folder.id) || {};
    const n = this.list.messages.length || info.total || 0;
    this.app.setStatus((this.list.filter !== "all" ? "Filter applied    " : "") + `Items: ${n}` + (info.unread ? `    Unread: ${info.unread}` : ""));
  }

  // ---- selection and reading ------------------------------------------------------------

  selection() {
    return this.list.selection();
  }

  onSelection(sel) {
    this.app.updateRibbon();
    const conv = this.list.selectedConversation();
    if (conv) this.showConversation(this.list.convs.get(conv) || sel);
    else if (sel.length === 1 && this.list.conversations && !this.list.conversationOf(sel[0].id)) this.showConversation([sel[0]], true);
    else if (sel.length === 1) this.reader.show(sel[0]);
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

  // read or unread: the list at once, the server in one go
  async markRead(msgs, read) {
    const change = msgs.filter(m => m.read !== read);
    if (!change.length) return;
    for (const m of change) {
      m.read = read;
      this.list.update(m);
    }
    this.paintFocusTabs();
    try {
      await messenger.sgmail.markMessages(change.map(m => m.id), { read });
    } catch (e) {
      console.error(e);
      toast("Could not mark them: " + e.message);
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
    const change = msgs.filter(m => !!m.flagged !== on);
    for (const m of change) {
      m.flagged = on;
      this.list.update(m);
    }
    try {
      await messenger.sgmail.markMessages(change.map(m => m.id), { flagged: on });
    } catch (e) {
      toast("Could not flag them: " + e.message);
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

  // ---- categories (Thunderbird's tags) ------------------------------------------------------

  async loadTags() {
    try {
      this.tags = await (messenger.messages.tags ? messenger.messages.tags.list() : messenger.messages.listTags());
    } catch (e) {
      this.tags = [];
    }
    const colors = new Map(this.tags.map(t => [t.key, t.color]));
    this.list.tagColor = key => colors.get(key) || null;
    this.reader.tagsOf = keys => (keys || []).map(k => this.tags.find(t => t.key === k)).filter(Boolean);
  }

  categorizeMenu() {
    const sel = this.selection();
    const items = (this.tags || []).map(t => ({
      label: t.tag, swatch: t.color, checked: sel.length > 0 && sel.every(m => (m.tags || []).includes(t.key)),
      action: () => this.categorize(sel, t.key),
    }));
    items.push({ separator: true }, { label: "Clear All Categories", action: () => this.categorize(sel, null) });
    return items;
  }

  // a category on (or off, when every selected message has it); null: none
  async categorize(msgs, key) {
    if (!msgs.length) return;
    const on = key && !msgs.every(m => (m.tags || []).includes(key));
    for (const m of msgs) {
      let tags = (m.tags || []).filter(k => k !== key);
      if (key === null) tags = [];
      else if (on) tags.push(key);
      m.tags = tags;
      this.list.update(m);
      try {
        await messenger.messages.update(m.id, { tags });
      } catch (e) {
        toast("Could not categorize: " + e.message);
      }
    }
    if (this.reader.message && msgs.some(m => m.id === this.reader.message.id)) this.reader.paintCategories?.();
  }

  // ---- rules ----------------------------------------------------------------------------------

  rulesMenu() {
    const sel = this.selection();
    const who = sel.length === 1 ? displayName(sel[0].author) : "";
    return [
      { label: who ? `Always Move Messages From: ${who}` : "Always Move Messages From…", icon: "move", disabled: sel.length !== 1, action: () => this.alwaysMoveFrom(sel[0]) },
      { separator: true },
      { label: "Manage Rules & Alerts…", icon: "rules", action: () => messenger.sgmail.openTool("filters") },
    ];
  }

  // a rule (a Thunderbird filter on the account): this sender's messages to
  // a folder, the ones here now and the ones that come
  async alwaysMoveFrom(m) {
    if (!m || !m.folder) return;
    const email = parseAddress(m.author).email.toLowerCase();
    const f = this.folders.folders.get(m.folder.id) || m.folder;
    const target = await this.folders.pickFolder(`Always move messages from ${displayName(m.author)}`, f.accountId);
    if (!target) return;
    const inbox = this.folders.inbox(f.accountId) || f;
    try {
      await messenger.sgmail.createMoveRule(inbox.id, email, target);
    } catch (e) {
      return toast("The rule could not be made: " + e.message);
    }
    const now = this.list.messages.filter(x => parseAddress(x.author).email.toLowerCase() === email && (!x.folder || x.folder.id !== target));
    if (now.length) await this.moveTo(now, target);
    this.app.setStatus(`Rule made: messages from ${email} go to ${folderLabel(this.folders.folders.get(target) || { name: "the folder", specialUse: [] })}`);
  }

  // Respond > Meeting: a meeting with the message's sender and the others
  // it went to, its subject the meeting's
  replyWithMeeting(m) {
    if (!m) return;
    const mine = new Set(this.folders.accounts.flatMap(a => a.identities.map(i => (i.email || "").toLowerCase())));
    const seen = new Set();
    const people = [m.author, ...(m.recipients || []), ...(m.ccList || [])].filter(a => {
      const e = parseAddress(a).email.toLowerCase();
      if (!e || mine.has(e) || seen.has(e)) return false;
      seen.add(e);
      return true;
    });
    return this.app.calendar.newEvent({ meeting: true, attendees: people.join("; "), title: baseSubject(m.subject) });
  }

  // Ignore (or, in Deleted Items for an ignored one, Stop Ignoring)
  ignoreItem(sel) {
    const stop = this.folder && roleOf(this.folder) === "trash" && sel.some(m => this.isIgnored(m.id));
    return { label: stop ? "Stop Ignoring Conversation" : "Ignore Conversation", icon: "ignore", action: () => this.ignoreConversation(sel) };
  }

  cleanUpMenu() {
    return [
      { label: "Clean Up Conversation", icon: "clean-up", disabled: !this.selection().length, action: () => this.cleanUp("conversation") },
      { label: "Clean Up Folder", icon: "clean-up", action: () => this.cleanUp("folder") },
    ];
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
      { label: "Mark as Read", icon: "mail-read", shortcut: "Ctrl+Q", disabled: !unread, action: () => this.markRead(sel, true) },
      { label: "Mark as Unread", icon: "mail-unread", shortcut: "Ctrl+U", disabled: sel.every(m => !m.read), action: () => this.markRead(sel, false) },
      { label: sel.every(m => m.flagged) ? "Clear Flag" : "Flag", icon: "flag", shortcut: "Insert", action: () => this.flag(sel) },
      { separator: true },
      ...(this.focusShown() ? (() => {
        const to = this.list.focusTab === "focused" ? "other" : "focused", name = to === "other" ? "Other" : "Focused";
        return [{ label: `Move to ${name}`, icon: "focused", action: () => this.moveFocus(sel, to) },
          { label: `Always Move to ${name}`, action: () => this.moveFocus(sel, to, true) }, { separator: true }];
      })() : []),
      { label: "Move", icon: "move", submenu: this.moveMenu() },
      { label: "Quick Steps", icon: "quick-step", submenu: this.app.quickSteps.menu() },
      { label: "Categorize", icon: "category", submenu: this.categorizeMenu() },
      { label: "Rules", icon: "rules", submenu: this.rulesMenu() },
      { label: "Junk", icon: "junk", submenu: [
        { label: "Block Sender / Junk", action: () => this.junkSelected(true) },
        { label: "Not Junk", action: () => this.junkSelected(false) },
      ] },
      { separator: true },
      this.ignoreItem(sel),
      { label: "Clean Up Conversation", icon: "clean-up", action: () => this.cleanUp("conversation") },
      { label: "Archive", icon: "archive", shortcut: "Backspace", action: () => this.archiveSelected() },
      { label: "Delete", icon: "delete", shortcut: "Delete", action: () => this.deleteSelected() },
    ], at);
  }

  // ---- new mail ---------------------------------------------------------------------------

  async onNewMail(folder, list) {
    if (this.ignored.size && !(folder.specialUse || []).some(r => ["trash", "sent", "drafts"].includes(r))) {
      await this.loadConversations(list.messages);
      const kept = await this.dropIgnored(list.messages);
      if (kept.length !== list.messages.length) list = Object.assign({}, list, { messages: kept });
    }
    this.app.autoReplies?.onNewMail(folder, list.messages);
    if (this.folder && folder.id === this.folder.id && !this.search.text) await this.addToList(list.messages);
    if (this.folder && this.folder.virtual && !this.search.text) this.reloadSoon();
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
      focused: this.focusShown() ? { tab: this.list.focusTab, tabs: [...document.querySelectorAll(".list-filter")].map(b => b.textContent.trim()),
        of: Object.fromEntries(this.list.messages.map(m => [m.subject, this.focusOf(m)])) } : null,
      readingPane: this.app.readingPane,
      conversations: this.list.conversations,
      reader: this.reader.dump(),
      notifications: this.app.notifications,
      title: document.title,
      status: $("#status-left").textContent,
    };
    testDump("mail.json", data);
    return data;
  }
}
