/*
 * SG Mail -- Quick Steps: several things done to the selected messages with
 * one click (Home > Quick Steps, the message's menu, Ctrl+Shift+1..9), as
 * the classic desktop client has them: Move to a folder, To Manager, Team
 * Email, Done, Reply & Delete, and new ones made here. Each is a name and a
 * list of actions; a step that needs a folder or an address asks for it the
 * first time it is used. Kept in SG Mail's storage on this computer.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, dialog, toast } from "./util.js";
import { roleOf, folderLabel } from "./folders.js";

// what an action does, and what it needs
export const ACTIONS = {
  move: { label: "Move to folder", needs: "folder" },
  copy: { label: "Copy to folder", needs: "folder" },
  delete: { label: "Delete message" },
  archive: { label: "Archive" },
  markRead: { label: "Mark as read" },
  markUnread: { label: "Mark as unread" },
  flag: { label: "Flag message" },
  clearFlag: { label: "Mark complete (clear flag)" },
  categorize: { label: "Categorize message", needs: "category" },
  clearCategories: { label: "Clear categories" },
  reply: { label: "Reply" },
  replyAll: { label: "Reply All" },
  forward: { label: "Forward", needs: "to" },
  newMessage: { label: "New message", needs: "to" },
};

// the first Quick Steps, as the classic client offers them
export function defaultSteps() {
  return [
    { id: "move", name: "Move to: ?", icon: "move", actions: [{ type: "move", folder: "" }, { type: "markRead" }], firstUse: true, autoName: true },
    { id: "manager", name: "To Manager", icon: "forward", actions: [{ type: "forward", to: "" }], firstUse: true },
    { id: "team", name: "Team Email", icon: "mail-new", actions: [{ type: "newMessage", to: "" }], firstUse: true },
    { id: "done", name: "Done", icon: "flag-done", actions: [{ type: "clearFlag" }, { type: "markRead" }, { type: "move", folder: "" }], firstUse: true },
    { id: "replydelete", name: "Reply & Delete", icon: "reply", actions: [{ type: "reply" }, { type: "delete" }] },
  ];
}

// a step not ready yet: a folder or an address to give first
function incomplete(step) {
  return step.actions.some(a => (ACTIONS[a.type]?.needs === "folder" && !a.folder) || (ACTIONS[a.type]?.needs === "to" && !a.to) ||
    (ACTIONS[a.type]?.needs === "category" && !a.tag));
}

const COMPOSING = new Set(["reply", "replyAll", "forward", "newMessage"]);

export class QuickSteps {
  constructor(app) {
    this.app = app;
    this.steps = defaultSteps();
  }

  async load() {
    try {
      const st = await messenger.storage.local.get("quickSteps");
      if (Array.isArray(st.quickSteps)) this.steps = st.quickSteps;
    } catch (e) {
      // first start
    }
  }

  save() {
    return messenger.storage.local.set({ quickSteps: this.steps }).catch(() => {});
  }

  get mail() {
    return this.app.mail;
  }

  // the ribbon's gallery: the steps in columns of three, Create New, and
  // Manage Quick Steps under the arrow
  ribbonItems() {
    const btn = (s, i) => ({ id: "qs-" + s.id, icon: s.icon || "quick-step", label: s.name, title: this.tooltip(s, i), action: () => this.run(s) });
    const items = this.steps.slice(0, 8).map(btn);
    items.push({ id: "qs-create", icon: "quick-new", label: "Create New", action: () => this.edit(null) });
    const cols = [];
    for (let i = 0; i < items.length; i += 3) cols.push({ col: items.slice(i, i + 3) });
    cols.push({ col: [{ id: "qs-manage", icon: "settings", label: "", title: "Manage Quick Steps", menu: () => this.manageMenu() }] });
    return cols;
  }

  tooltip(s, i) {
    const what = s.actions.map(a => this.describe(a)).join(", ");
    const key = s.shortcut ? ` (Ctrl+Shift+${s.shortcut})` : "";
    return `${s.name}${key}: ${what}`;
  }

  describe(a) {
    const f = a.folder && this.mail.folders.folders.get(a.folder);
    if (a.type === "move" || a.type === "copy") return `${ACTIONS[a.type].label}${f ? ": " + folderLabel(f) : ""}`;
    if (a.type === "forward" || a.type === "newMessage") return `${ACTIONS[a.type].label}${a.to ? " to " + a.to : ""}`;
    if (a.type === "categorize") return `${ACTIONS.categorize.label}${a.tag ? ": " + this.tagName(a.tag) : ""}`;
    return ACTIONS[a.type]?.label || a.type;
  }

  tagName(key) {
    return ((this.mail.tags || []).find(t => t.key === key) || {}).tag || key;
  }

  menu() {
    return [
      ...this.steps.map((s, i) => ({ label: s.name, icon: s.icon || "quick-step", shortcut: s.shortcut ? `Ctrl+Shift+${s.shortcut}` : "", action: () => this.run(s) })),
      { separator: true },
      ...this.manageMenu(),
    ];
  }

  manageMenu() {
    return [
      { label: "New Quick Step…", icon: "quick-new", action: () => this.edit(null) },
      { label: "Manage Quick Steps…", icon: "settings", action: () => this.manage() },
    ];
  }

  byShortcut(n) {
    return this.steps.find(s => String(s.shortcut || "") === String(n));
  }

  // ---- running one ------------------------------------------------------------------------------

  async run(step) {
    if (incomplete(step)) {
      // first use: what it needs, then on
      const done = await this.edit(step, { firstUse: true });
      if (!done) return;
      step = this.steps.find(s => s.id === step.id) || done;
    }
    const sel = this.mail.selection();
    const needsMessages = step.actions.some(a => a.type !== "newMessage");
    if (needsMessages && !sel.length) return toast("Select a message first.");
    const m = this.mail;
    const one = sel[0];
    // what writes a message goes first, while the original is where it was
    for (const a of step.actions.filter(x => COMPOSING.has(x.type))) {
      if (a.type === "newMessage") {
        await this.compose({ mode: "new", to: a.to, subject: a.subject || "" });
        continue;
      }
      if (!one) continue;
      await this.compose({ mode: a.type, id: one.id, to: a.type === "forward" ? a.to : "" }, true);
    }
    let ids = sel.map(x => x.id);
    // what changes the messages, then where they go (a move last)
    const rest = step.actions.filter(x => !COMPOSING.has(x.type));
    const last = new Set(["move", "archive", "delete"]);
    for (const a of [...rest.filter(x => !last.has(x.type)), ...rest.filter(x => last.has(x.type))]) {
      try {
        switch (a.type) {
          case "markRead":
          case "markUnread":
            await m.markRead(sel, a.type === "markRead");
            break;
          case "flag":
          case "clearFlag":
            for (const x of sel) {
              x.flagged = a.type === "flag";
              m.list.update(x);
              await messenger.messages.update(x.id, { flagged: x.flagged });
            }
            break;
          case "categorize":
          case "clearCategories":
            for (const x of sel) {
              const tags = a.type === "clearCategories" ? [] : [...new Set([...(x.tags || []), a.tag])];
              x.tags = tags;
              m.list.update(x);
              await messenger.messages.update(x.id, { tags });
            }
            break;
          case "copy":
            await messenger.messages.copy(ids, a.folder);
            break;
          case "move":
            if (m.folder && a.folder === m.folder.id) break;
            m.list.remove(ids);
            await messenger.messages.move(ids, a.folder);
            ids = [];
            break;
          case "archive":
            m.list.remove(ids);
            await messenger.messages.archive(ids);
            ids = [];
            break;
          case "delete":
            m.list.remove(ids);
            await messenger.messages.delete(ids, {});
            ids = [];
            break;
        }
      } catch (e) {
        toast(`${step.name}: ${e.message}`);
        m.reload(true);
        return;
      }
      if (!ids.length) break;
    }
    this.app.setStatus(`Quick Step: ${step.name}`);
    m.dumpSoon();
  }

  // a message window for a step; for replies and forwards the original read
  // in it first (a later action may move or delete it)
  async compose(args, waitForOriginal = false) {
    const m = this.mail;
    const full = Object.assign({ identity: m.currentIdentity() }, args);
    if (!waitForOriginal) return m.app.compose(full);
    const ready = new Promise(resolve => {
      const on = msg => {
        if (msg && msg.type === "sgmail-compose-prefilled" && msg.originalId === args.id) {
          messenger.runtime.onMessage.removeListener(on);
          resolve(true);
        }
      };
      messenger.runtime.onMessage.addListener(on);
      setTimeout(() => {
        messenger.runtime.onMessage.removeListener(on);
        resolve(false);
      }, 15000);
    });
    await m.app.compose(full);
    await ready;
  }

  // ---- making and changing them -----------------------------------------------------------------

  // the step's editor: its name, its actions (each with what it needs), its
  // shortcut. Resolves with the step saved, or null.
  async edit(step, { firstUse = false } = {}) {
    const isNew = !step;
    const draft = JSON.parse(JSON.stringify(step || { id: "qs" + Date.now().toString(36), name: "", icon: "quick-step", actions: [{ type: "move", folder: "" }] }));
    const body = h("div", { class: "qs-edit" });
    const nameRow = h("div", { class: "form-row" }, h("label", { for: "qs-name", text: "Name:" }),
      h("input", { id: "qs-name", type: "text", value: draft.name, style: "flex:1" }));
    const list = h("div", { class: "qs-actions" });
    const folders = [...this.mail.folders.folders.values()].filter(f => !f.virtual && roleOf(f) !== "outbox");
    const renderActions = () => {
      list.replaceChildren(...draft.actions.map((a, i) => {
        const type = h("select", { class: "qs-type", "aria-label": "Action" },
          Object.entries(ACTIONS).map(([k, v]) => h("option", { value: k, text: v.label, selected: k === a.type })));
        type.addEventListener("change", () => {
          draft.actions[i] = { type: type.value };
          renderActions();
        });
        const need = ACTIONS[a.type]?.needs;
        let param = h("span", { class: "qs-param" });
        if (need === "folder") {
          param = h("select", { class: "qs-param qs-folder", "aria-label": "Folder" },
            h("option", { value: "", text: "Choose folder" }),
            folders.map(f => h("option", { value: f.id, text: `${folderLabel(f)} (${this.mail.accountLabel(f)})`, selected: f.id === a.folder })));
          param.addEventListener("change", () => {
            a.folder = param.value;
          });
        } else if (need === "to") {
          param = h("input", { class: "qs-param qs-to", type: "text", placeholder: "To…", value: a.to || "", "aria-label": "To" });
          param.addEventListener("input", () => {
            a.to = param.value.trim();
          });
        } else if (need === "category") {
          param = h("select", { class: "qs-param qs-tag", "aria-label": "Category" }, h("option", { value: "", text: "Choose category" }),
            (this.mail.tags || []).map(t => h("option", { value: t.key, text: t.tag, selected: t.key === a.tag })));
          param.addEventListener("change", () => {
            a.tag = param.value;
          });
        }
        const del = h("button", { class: "pp-remove", title: "Remove this action", html: icon("close", 14) });
        del.addEventListener("click", () => {
          draft.actions.splice(i, 1);
          renderActions();
        });
        return h("div", { class: "qs-action" }, type, param, del);
      }));
    };
    renderActions();
    const add = h("button", { class: "btn link", id: "qs-add", html: `${icon("quick-new", 14)} Add Action` });
    add.addEventListener("click", () => {
      draft.actions.push({ type: "markRead" });
      renderActions();
    });
    const used = new Set(this.steps.filter(s => s.id !== draft.id && s.shortcut).map(s => String(s.shortcut)));
    const key = h("select", { id: "qs-key", "aria-label": "Shortcut key" }, h("option", { value: "", text: "Choose a shortcut" }),
      [1, 2, 3, 4, 5, 6, 7, 8, 9].filter(n => !used.has(String(n)) || String(draft.shortcut) === String(n))
        .map(n => h("option", { value: String(n), text: `Ctrl+Shift+${n}`, selected: String(draft.shortcut) === String(n) })));
    body.append(
      firstUse ? h("p", { text: "First Time Setup: this Quick Step needs to know a few things before it runs." }) : "",
      nameRow, h("div", { class: "qs-head", text: "Actions" }), list, add,
      h("div", { class: "form-row" }, h("label", { text: "Shortcut key:" }), key));
    const result = await dialog({
      title: firstUse ? "First Time Setup" : isNew ? "Edit Quick Step" : `Edit Quick Step: ${step.name}`,
      body,
      width: 560,
      buttons: [{ label: firstUse ? "Save" : "Finish", primary: true, value: "ok" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (result !== "ok") return null;
    draft.name = body.querySelector("#qs-name").value.trim();
    draft.shortcut = key.value || "";
    // a step called after its folder, as the classic client renames "Move to: ?"
    const mv = draft.actions.find(a => a.type === "move" && a.folder);
    if (draft.autoName && mv && (/\?$/.test(draft.name) || !draft.name)) {
      const f = this.mail.folders.folders.get(mv.folder);
      if (f) draft.name = folderLabel(f);
    }
    if (!draft.name) draft.name = draft.actions.length ? this.describe(draft.actions[0]) : "Quick Step";
    draft.actions = draft.actions.filter(a => ACTIONS[a.type]);
    if (incomplete(draft)) {
      toast("Every action needs what it asks for (a folder, an address or a category).");
      return this.edit(draft, { firstUse });
    }
    delete draft.firstUse;
    delete draft.autoName;
    const i = this.steps.findIndex(s => s.id === draft.id);
    if (i >= 0) this.steps[i] = draft;
    else this.steps.push(draft);
    await this.save();
    this.app.buildRibbon();
    return draft;
  }

  // Manage Quick Steps: the list, each to edit, copy, delete, move up or
  // down; New; Reset to Defaults
  async manage() {
    const body = h("div", { class: "qs-manage" });
    const render = () => {
      body.replaceChildren(h("div", { class: "qs-list" }, this.steps.map((s, i) => {
        const row = h("div", { class: "qs-row", "data-id": s.id },
          h("span", { html: icon(s.icon || "quick-step", 16) }),
          h("span", { class: "qs-name", text: s.name }),
          h("span", { class: "qs-desc", text: s.actions.map(a => this.describe(a)).join(", ") }));
        const b = (label, ic, fn, dis = false) => {
          const x = h("button", { class: "pp-remove", title: label, "aria-label": label, html: icon(ic, 14), disabled: dis });
          x.addEventListener("click", async () => {
            await fn();
            render();
          });
          row.append(x);
        };
        b("Edit", "edit", () => this.edit(s));
        b("Duplicate", "quick-new", async () => {
          this.steps.splice(i + 1, 0, Object.assign(JSON.parse(JSON.stringify(s)), { id: "qs" + Date.now().toString(36), name: "Copy of " + s.name, shortcut: "" }));
          await this.save();
        });
        b("Move up", "chevron-up", async () => {
          [this.steps[i - 1], this.steps[i]] = [this.steps[i], this.steps[i - 1]];
          await this.save();
        }, i === 0);
        b("Move down", "chevron-down", async () => {
          [this.steps[i + 1], this.steps[i]] = [this.steps[i], this.steps[i + 1]];
          await this.save();
        }, i === this.steps.length - 1);
        b("Delete", "delete", async () => {
          this.steps.splice(i, 1);
          await this.save();
        });
        return row;
      })));
    };
    render();
    const v = await dialog({
      title: "Manage Quick Steps",
      body,
      width: 620,
      buttons: [{ label: "New", value: "new" }, { label: "Reset to Defaults", value: "reset" }, { label: "OK", value: true, primary: true }],
    });
    if (v === "new") await this.edit(null);
    else if (v === "reset") {
      this.steps = defaultSteps();
      await this.save();
    }
    this.app.buildRibbon();
  }

  // what the gates read
  dump() {
    return this.steps.map(s => ({ name: s.name, shortcut: s.shortcut || "", actions: s.actions.map(a => Object.assign({}, a)) }));
  }
}
