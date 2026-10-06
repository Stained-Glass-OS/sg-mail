/*
 * SG Mail -- the folder pane: Favorites, then each account with its folders
 * (Inbox, Drafts, Sent Items, Deleted Items, Archive, Junk Email, Outbox,
 * and the account's own), unread counts in the accent colour.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, esc, showMenu, dialog, confirmBox, toast, debounce } from "./util.js";

// Outlook's names and order for the folders that have a role
const ROLES = {
  inbox: { name: "Inbox", icon: "inbox", order: 0 },
  drafts: { name: "Drafts", icon: "drafts", order: 1 },
  sent: { name: "Sent Items", icon: "sent", order: 2 },
  trash: { name: "Deleted Items", icon: "delete", order: 3 },
  archives: { name: "Archive", icon: "archive", order: 4 },
  junk: { name: "Junk Email", icon: "junk", order: 5 },
  outbox: { name: "Outbox", icon: "outbox", order: 6 },
  templates: { name: "Templates", icon: "templates", order: 7 },
};

export function roleOf(folder) {
  for (const r of folder.specialUse || []) if (ROLES[r]) return r;
  return "";
}

export function folderLabel(folder) {
  const r = roleOf(folder);
  return r ? ROLES[r].name : folder.name;
}

export function folderIcon(folder) {
  const r = roleOf(folder);
  return r ? ROLES[r].icon : "folder";
}

function sortFolders(list) {
  return [...list].sort((a, b) => {
    const ra = roleOf(a), rb = roleOf(b);
    const oa = ra ? ROLES[ra].order : 100, ob = rb ? ROLES[rb].order : 100;
    return oa - ob || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

export class FolderPane {
  constructor(el, { onSelect, onDropMessages }) {
    this.el = el;
    this.onSelect = onSelect;
    this.onDropMessages = onDropMessages;
    this.accounts = [];
    this.folders = new Map();       // id -> folder
    this.info = new Map();          // id -> {unread, total}
    this.collapsed = new Set();
    this.selectedId = null;
    // Outlook's Search Folders: messages found across the mailboxes
    this.virtuals = new Map([
      ["search:unread", { id: "search:unread", name: "Unread Mail", virtual: "unread", specialUse: [], icon: "search-folder" }],
      ["search:flagged", { id: "search:flagged", name: "For Follow Up", virtual: "flagged", specialUse: [], icon: "flag" }],
    ]);
    this.refreshSoon = debounce(() => this.refresh(), 250);
    el.addEventListener("keydown", e => this.onKey(e));
    messenger.folders.onFolderInfoChanged.addListener((folder, info) => {
      const cur = this.info.get(folder.id) || {};
      if ("unreadMessageCount" in info) cur.unread = info.unreadMessageCount;
      if ("totalMessageCount" in info) cur.total = info.totalMessageCount;
      this.info.set(folder.id, cur);
      this.paintCounts(folder.id);
      this.onCounts && this.onCounts(folder.id, cur);
    });
    for (const ev of ["onCreated", "onDeleted", "onRenamed", "onMoved", "onUpdated"]) {
      messenger.folders[ev].addListener(() => this.refreshSoon());
    }
    for (const ev of ["onCreated", "onDeleted", "onUpdated"]) {
      messenger.accounts[ev].addListener(() => this.refreshSoon());
    }
  }

  async load() {
    try {
      const st = await messenger.storage.local.get("collapsedFolders");
      this.collapsed = new Set(st.collapsedFolders || []);
    } catch (e) {
      // first start
    }
    await this.refresh();
    // as Outlook: each account's Inbox among the Favorites, once
    try {
      const st = await messenger.storage.local.get("favoritesSeeded");
      const seeded = new Set(st.favoritesSeeded || []);
      let changed = false;
      for (const a of this.accounts) {
        if (seeded.has(a.id)) continue;
        const inbox = this.inbox(a.id);
        if (!inbox) continue;
        seeded.add(a.id);
        if (!inbox.isFavorite) {
          await messenger.folders.update(inbox.id, { isFavorite: true });
          changed = true;
        }
      }
      await messenger.storage.local.set({ favoritesSeeded: [...seeded] });
      if (changed) await this.refresh();
    } catch (e) {
      console.error("sg-mail: favorites", e);
    }
  }

  async refresh() {
    const accounts = await messenger.accounts.list(true);
    // mail accounts first, in Thunderbird's order; its "Local Folders" last,
    // shown only when something is kept there
    this.accounts = accounts.filter(a => a.type !== "none" && a.type !== "local");
    const local = accounts.find(a => a.type === "local" || a.type === "none");
    this.local = local;
    this.folders.clear();
    const walk = (f, account) => {
      this.folders.set(f.id, Object.assign(f, { account }));
      for (const s of f.subFolders || []) walk(s, account);
    };
    for (const a of accounts) for (const f of a.rootFolder.subFolders || []) walk(f, a);
    await Promise.all([...this.folders.keys()].map(async id => {
      try {
        const info = await messenger.folders.getFolderInfo(id);
        this.info.set(id, { unread: info.unreadMessageCount, total: info.totalMessageCount, favorite: info.favorite });
      } catch (e) {
        // a folder that went away meanwhile
      }
    }));
    this.render();
    this.onRefreshed && this.onRefreshed();
  }

  inbox(accountId) {
    for (const f of this.folders.values()) if (f.accountId === accountId && roleOf(f) === "inbox") return f;
    return null;
  }

  firstInbox() {
    for (const a of this.accounts) {
      const i = this.inbox(a.id);
      if (i) return i;
    }
    return null;
  }

  folderByRole(accountId, role) {
    for (const f of this.folders.values()) if (f.accountId === accountId && roleOf(f) === role) return f;
    return null;
  }

  render() {
    const frag = document.createDocumentFragment();
    // Favorites
    const favs = [...this.folders.values()].filter(f => f.isFavorite);
    const favKey = "section:favorites";
    frag.append(this.section(favKey, "Favorites"));
    if (!this.collapsed.has(favKey)) {
      if (!favs.length) frag.append(h("div", { class: "fp-row", style: "color:var(--faint);padding-left:28px", text: "Drag folders here" }));
      for (const f of sortFolders(favs)) frag.append(this.row(f, 0, true));
    }
    for (const a of this.accounts) {
      const key = "account:" + a.id;
      const ident = a.identities && a.identities[0];
      frag.append(this.section(key, (ident && ident.email) || a.name, a));
      if (this.collapsed.has(key)) continue;
      this.addFolders(frag, sortFolders(a.rootFolder.subFolders || []), 0);
      // the shared Outbox, while something waits to be sent
      if (a === this.accounts[0] && this.local) {
        const outbox = [...this.folders.values()].find(f => f.accountId === this.local.id && roleOf(f) === "outbox");
        if (outbox && (this.info.get(outbox.id)?.total || 0) > 0) frag.append(this.row(outbox, 0));
      }
    }
    if (this.accounts.length) {
      const key = "section:search";
      frag.append(this.section(key, "Search Folders"));
      if (!this.collapsed.has(key)) for (const v of this.virtuals.values()) frag.append(this.virtualRow(v));
    }
    if (this.local) {
      const own = (this.local.rootFolder.subFolders || []).filter(f => !["outbox"].includes(roleOf(f)));
      const used = own.some(f => !roleOf(f) || (this.info.get(f.id)?.total || 0) > 0);
      if (used || !this.accounts.length) {
        const key = "account:" + this.local.id;
        frag.append(this.section(key, "On This Computer", this.local));
        if (!this.collapsed.has(key)) this.addFolders(frag, sortFolders(own), 0);
      }
    }
    if (!this.accounts.length) {
      frag.append(h("div", { style: "padding:16px 12px;color:var(--muted)" },
        h("p", { text: "No email account is set up yet." }),
        h("button", { class: "btn primary", text: "Add Account…", onclick: () => messenger.sgmail.openTool("accountSetup") })));
    }
    this.el.replaceChildren(frag);
    this.markSelected();
  }

  addFolders(frag, list, depth) {
    for (const f of list) {
      frag.append(this.row(f, depth));
      if (f.subFolders && f.subFolders.length && !this.collapsed.has("folder:" + f.id)) {
        this.addFolders(frag, sortFolders(f.subFolders), depth + 1);
      }
    }
  }

  section(key, label, account) {
    const collapsed = this.collapsed.has(key);
    const el = h("div", {
      class: "fp-section",
      "data-key": key,
      title: label,
      html: `<span class="twisty">${icon(collapsed ? "chevron-right" : "chevron-down", 12)}</span><span class="acct-mail">${esc(label)}</span>`,
    });
    el.addEventListener("click", () => this.toggle(key));
    if (account) {
      el.addEventListener("contextmenu", e => {
        e.preventDefault();
        showMenu([
          { label: "New Folder…", icon: "folder", action: () => this.newFolder(account.rootFolder) },
          { separator: true },
          { label: "Account Settings…", icon: "settings", action: () => messenger.sgmail.openTool("accountSettings") },
        ], { x: e.clientX, y: e.clientY });
      });
    }
    return el;
  }

  row(f, depth, inFavorites = false) {
    const hasSub = !inFavorites && f.subFolders && f.subFolders.length;
    const collapsed = this.collapsed.has("folder:" + f.id);
    const info = this.info.get(f.id) || {};
    const role = roleOf(f);
    const el = h("div", {
      class: "fp-row",
      role: "treeitem",
      "data-id": f.id,
      "data-fav": inFavorites ? "1" : "",
      style: `padding-left:${12 + depth * 16}px`,
      title: inFavorites ? `${folderLabel(f)} - ${(f.account.identities[0] || {}).email || f.account.name}` : folderLabel(f),
      draggable: "true",
    });
    el.innerHTML = `<span class="twisty">${hasSub ? icon(collapsed ? "chevron-right" : "chevron-down", 12) : ""}</span>` +
      `<span class="fp-icon">${icon(folderIcon(f), 16)}</span><span class="fp-name">${esc(folderLabel(f))}</span><span class="fp-count"></span>`;
    el.addEventListener("click", e => {
      if (e.target.closest(".twisty") && hasSub) this.toggle("folder:" + f.id);
      else this.select(f.id);
    });
    el.addEventListener("contextmenu", e => {
      e.preventDefault();
      this.select(f.id);
      this.folderMenu(f, { x: e.clientX, y: e.clientY });
    });
    // messages dropped here move here; a folder dropped on Favorites becomes one
    el.addEventListener("dragover", e => {
      if (e.dataTransfer.types.includes("application/x-sgmail-messages")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = e.ctrlKey ? "copy" : "move";
        el.classList.add("drop-target");
      }
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", e => {
      el.classList.remove("drop-target");
      const data = e.dataTransfer.getData("application/x-sgmail-messages");
      if (data) {
        e.preventDefault();
        this.onDropMessages(JSON.parse(data), f.id, e.ctrlKey);
      }
    });
    el.addEventListener("dragstart", e => {
      e.dataTransfer.setData("application/x-sgmail-folder", f.id);
    });
    this.paintCountsOf(el, f, info, role);
    return el;
  }

  virtualRow(v) {
    const el = h("div", { class: "fp-row", role: "treeitem", "data-id": v.id, style: "padding-left:12px", title: v.name,
      html: `<span class="twisty"></span><span class="fp-icon">${icon(v.icon, 16)}</span><span class="fp-name">${esc(v.name)}</span><span class="fp-count"></span>` });
    el.addEventListener("click", () => this.select(v.id));
    this.paintVirtual(el, v);
    return el;
  }

  // Unread Mail counts the unread messages of the mail folders (not
  // Deleted Items, Junk, Sent, Drafts or Outbox)
  paintVirtual(el, v) {
    if (v.virtual !== "unread") return;
    let n = 0;
    for (const [id, info] of this.info) {
      const f = this.folders.get(id);
      if (f && !["trash", "junk", "sent", "drafts", "outbox", "templates"].includes(roleOf(f))) n += info.unread || 0;
    }
    const c = el.querySelector(".fp-count");
    c.textContent = n ? String(n) : "";
    el.classList.toggle("has-unread", n > 0);
  }

  paintCountsOf(el, f, info, role) {
    const c = el.querySelector(".fp-count");
    const unread = info.unread || 0;
    // Drafts and Outbox count what they hold, the others what is unread
    if (role === "drafts" || role === "outbox") {
      const n = info.total || 0;
      c.textContent = n ? `[${n}]` : "";
      c.className = "fp-count drafts";
      el.classList.toggle("has-unread", role === "outbox" && n > 0);
    } else {
      c.textContent = unread ? String(unread) : "";
      c.className = "fp-count";
      el.classList.toggle("has-unread", unread > 0);
    }
  }

  paintCounts(id) {
    const f = this.folders.get(id);
    if (!f) return;
    const unread = this.el.querySelector('.fp-row[data-id="search:unread"]');
    if (unread) this.paintVirtual(unread, this.virtuals.get("search:unread"));
    for (const el of this.el.querySelectorAll(`.fp-row[data-id="${CSS.escape(id)}"]`)) this.paintCountsOf(el, f, this.info.get(id) || {}, roleOf(f));
    if (roleOf(f) === "outbox") this.refreshSoon();
  }

  async toggle(key) {
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    try {
      await messenger.storage.local.set({ collapsedFolders: [...this.collapsed] });
    } catch (e) {
      // not kept
    }
    this.render();
  }

  select(id, { silent = false } = {}) {
    if (!this.folders.has(id) && !this.virtuals.has(id)) return;
    this.selectedId = id;
    this.markSelected();
    if (!silent) this.onSelect(this.folders.get(id) || this.virtuals.get(id));
  }

  markSelected() {
    for (const el of this.el.querySelectorAll(".fp-row")) el.classList.toggle("selected", !!this.selectedId && el.dataset.id === this.selectedId);
  }

  onKey(e) {
    const rows = [...this.el.querySelectorAll(".fp-row[data-id]")];
    const i = rows.findIndex(r => r.classList.contains("selected"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (n) {
        this.select(n.dataset.id);
        n.scrollIntoView({ block: "nearest" });
      }
      e.preventDefault();
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && i >= 0) {
      const key = "folder:" + rows[i].dataset.id;
      if ((e.key === "ArrowLeft") !== this.collapsed.has(key)) this.toggle(key);
      e.preventDefault();
    }
  }

  folderMenu(f, at) {
    const role = roleOf(f);
    const info = this.info.get(f.id) || {};
    const items = [
      { label: "New Folder…", icon: "folder", action: () => this.newFolder(f) },
      { label: "Rename Folder…", disabled: !!role, action: () => this.renameFolder(f) },
      { label: "Delete Folder", icon: "delete", disabled: !!role, action: () => this.deleteFolder(f) },
      { separator: true },
      { label: "Mark All as Read", icon: "mail-read", disabled: !info.unread, action: () => messenger.folders.markAsRead(f.id) },
    ];
    if (role === "trash" || role === "junk") {
      items.push({ label: role === "trash" ? "Empty Folder" : "Empty Junk Email", icon: "delete", action: () => this.emptyFolder(f) });
    }
    items.push({ separator: true });
    items.push(f.isFavorite
      ? { label: "Remove from Favorites", icon: "star", action: () => this.setFavorite(f, false) }
      : { label: "Show in Favorites", icon: "star-filled", action: () => this.setFavorite(f, true) });
    items.push({ separator: true }, { label: "Account Settings…", icon: "settings", action: () => messenger.sgmail.openTool("accountSettings") });
    showMenu(items, at);
  }

  async setFavorite(f, on) {
    await messenger.folders.update(f.id, { isFavorite: on });
    await this.refresh();
  }

  async newFolder(parent) {
    const v = await dialog({
      title: "Create New Folder",
      body: `<div class="form-row"><label>Name:</label><input id="nf-name" type="text" style="flex:1"></div><div class="form-row"><label>In:</label><span>${esc(parent.isRoot ? "(top level)" : folderLabel(parent))}</span></div>`,
      buttons: [{ label: "OK", primary: true, value: box => box.querySelector("#nf-name").value.trim() }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    try {
      await messenger.folders.create(parent.id, v);
      toast(`Folder "${v}" created`);
    } catch (e) {
      toast("The folder could not be created: " + e.message);
    }
  }

  async renameFolder(f) {
    const v = await dialog({
      title: "Rename Folder",
      body: `<div class="form-row"><label>New name:</label><input id="rf-name" type="text" style="flex:1" value="${esc(f.name)}"></div>`,
      buttons: [{ label: "OK", primary: true, value: box => box.querySelector("#rf-name").value.trim() }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v || v === f.name) return;
    try {
      await messenger.folders.rename(f.id, v);
    } catch (e) {
      toast("The folder could not be renamed: " + e.message);
    }
  }

  async deleteFolder(f) {
    if (!(await confirmBox("Delete Folder", `Are you sure you want to delete the folder "${f.name}" and move all of its contents into Deleted Items?`))) return;
    try {
      await messenger.folders.delete(f.id);
    } catch (e) {
      toast("The folder could not be deleted: " + e.message);
    }
  }

  async emptyFolder(f) {
    if (!(await confirmBox("Empty Folder", `Everything in "${folderLabel(f)}" will be permanently deleted. Continue?`))) return;
    let page = await messenger.messages.list(f.id);
    const ids = page.messages.map(m => m.id);
    while (page.id) {
      page = await messenger.messages.continueList(page.id);
      ids.push(...page.messages.map(m => m.id));
    }
    if (ids.length) await messenger.messages.delete(ids, { deletePermanently: true });
  }

  // a dialog with the folder tree, for Move to Folder (Ctrl+Shift+V)
  async pickFolder(title, accountHint) {
    const list = h("div", { class: "folder-pane", style: "max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:3px" });
    let chosen = null;
    const add = (folders, depth, account) => {
      for (const f of sortFolders(folders)) {
        if (roleOf(f) === "outbox") continue;
        const r = h("div", { class: "fp-row", "data-id": f.id, style: `padding-left:${8 + depth * 16}px`,
          html: `<span class="fp-icon">${icon(folderIcon(f), 16)}</span><span class="fp-name">${esc(folderLabel(f))}</span>` });
        r.addEventListener("click", () => {
          chosen = f.id;
          for (const x of list.querySelectorAll(".fp-row")) x.classList.toggle("selected", x === r);
        });
        r.addEventListener("dblclick", () => list.closest(".modal").querySelector(".btn.primary").click());
        list.append(r);
        add(f.subFolders || [], depth + 1, account);
      }
    };
    const accounts = [...this.accounts, ...(this.local ? [this.local] : [])];
    for (const a of accounts) {
      list.append(h("div", { class: "fp-section", text: a === this.local ? "On This Computer" : ((a.identities[0] || {}).email || a.name) }));
      add(a.rootFolder.subFolders || [], 0, a);
    }
    return dialog({
      title,
      body: list,
      width: 380,
      buttons: [{ label: "OK", primary: true, value: () => chosen }, { label: "Cancel", value: null, cancel: true }],
      init: () => {
        const first = accountHint && list.querySelector(`.fp-row[data-id^="${CSS.escape(accountHint)}:"]`);
        if (first) first.scrollIntoView({ block: "nearest" });
      },
    });
  }
}
