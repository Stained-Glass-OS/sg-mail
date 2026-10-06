/*
 * SG Mail -- People: the address books' contacts and contact groups in SG
 * Mail's own window, as Outlook's People: the address books and their groups
 * on the side, the contacts (searchable, by name) beside the contact card,
 * new and edited contacts and groups. Everything is Thunderbird's address
 * books (messenger.addressBooks: contacts as vCards, mailing lists as
 * groups), so its own address book shows the same.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, esc, avatar, formatAddress, showMenu, toast, dialog, confirmBox, debounce, testDump, validEmail } from "./util.js";
import { parseVCard, toVCard } from "./vcard.js";

export class PeopleModule {
  constructor(app) {
    this.app = app;
    this.side = $("#side-people");
    this.main = $("#module-people");
    this.books = [];
    this.contacts = [];          // {id, bookId, readOnly, card, vCard}
    this.groups = [];            // {id, bookId, name, description, members: [contact id]}
    this.scope = "all";          // "all", "book:ID" or "group:ID"
    this.selected = null;        // "contact:ID" or "group:ID"
    this.query = "";
    this.loadSoon = debounce(() => this.load(), 250);
  }

  async start() {
    const api = messenger.addressBooks;
    for (const ns of [api, api.contacts, api.mailingLists]) {
      for (const ev of ["onCreated", "onUpdated", "onDeleted", "onMemberAdded", "onMemberRemoved"]) ns?.[ev]?.addListener(() => {
        if (!this.main.hidden) this.loadSoon();
        else this.stale = true;
      });
    }
  }

  show() {
    this.renderFrame();
    this.load();
  }

  // ---- the ribbon ------------------------------------------------------------------------------

  ribbon() {
    return {
      tabs: [
        { id: "home", label: "Home", groups: [
          { label: "New", items: [
            { id: "new-contact", icon: "person-add", label: "New Contact", large: true, shortcut: "Ctrl+N", action: () => this.editContact(null) },
            { id: "new-group", icon: "group-add", label: "New Contact Group", large: true, action: () => this.editGroup(null) },
          ] },
          { label: "Actions", items: [
            { id: "edit-contact", icon: "edit", label: "Edit", large: true, action: () => this.editSelected() },
            { id: "delete-contact", icon: "delete", label: "Delete", large: true, shortcut: "Delete", action: () => this.deleteSelected() },
          ] },
          { label: "Communicate", items: [
            { id: "email-contact", icon: "mail-new", label: "Email", large: true, action: () => this.emailSelected() },
            { id: "meeting-contact", icon: "meeting-new", label: "Meeting", large: true, action: () => this.meetingSelected() },
          ] },
          { label: "Find", items: [
            { col: [
              { id: "search-people", icon: "search", label: "Search People", shortcut: "Ctrl+E", action: () => $("#pp-search")?.focus() },
              { id: "tb-address-book", icon: "address-book", label: "Thunderbird's Address Book", action: () => messenger.sgmail.openTool("addressBook") },
            ] },
          ] },
        ] },
      ],
    };
  }

  updateRibbon() {
    const r = this.app.ribbon;
    if (!r) return;
    const item = this.selectedItem();
    const writable = item && !item.readOnly;
    r.enable("edit-contact", writable);
    r.enable("delete-contact", writable);
    r.enable("email-contact", !!item && this.addressesOf(item).length > 0);
    r.enable("meeting-contact", !!item && this.addressesOf(item).length > 0);
  }

  // ---- the address books -------------------------------------------------------------------------

  async load() {
    this.stale = false;
    let books = [];
    try {
      books = await messenger.addressBooks.list(true);
    } catch (e) {
      console.error("sg-mail: address books", e);
    }
    this.books = books.filter(b => b.type === "addressBook" || !b.type);
    this.contacts = [];
    this.groups = [];
    for (const b of this.books) {
      for (const c of b.contacts || []) {
        this.contacts.push({ id: c.id, bookId: b.id, readOnly: !!(c.readOnly || b.readOnly), vCard: c.vCard || "", card: parseVCard(c.vCard || "") });
      }
      for (const l of b.mailingLists || []) {
        this.groups.push({ id: l.id, bookId: b.id, readOnly: !!(l.readOnly || b.readOnly), name: l.name, description: l.description || "",
          members: (l.contacts || []).map(c => c.id) });
      }
    }
    const byName = (a, b) => this.sortName(a).localeCompare(this.sortName(b), undefined, { sensitivity: "base" });
    this.contacts.sort(byName);
    this.groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    if (this.selected && !this.selectedItem()) this.selected = null;
    this.renderSide();
    this.renderList();
    this.renderCard();
    this.dump();
  }

  sortName(c) {
    return (c.card ? (c.card.display || c.card.emails[0] || "") : c.name || "").toLowerCase();
  }

  book(id) {
    return this.books.find(b => b.id === id);
  }

  writableBooks() {
    return this.books.filter(b => !b.readOnly && !b.remote);
  }

  selectedItem() {
    if (!this.selected) return null;
    const [kind, id] = this.selected.split(/:(.*)/s);
    return kind === "contact" ? this.contacts.find(c => c.id === id) : this.groups.find(g => g.id === id);
  }

  addressesOf(item) {
    if (item.card) return item.card.emails[0] ? [formatAddress({ name: item.card.display, email: item.card.emails[0] })] : [];
    return item.members.map(id => this.contacts.find(c => c.id === id)).filter(c => c && c.card.emails[0])
      .map(c => formatAddress({ name: c.card.display, email: c.card.emails[0] }));
  }

  // ---- drawing ---------------------------------------------------------------------------------------

  renderFrame() {
    if (this.main.querySelector(".pp")) return;
    const search = h("input", { id: "pp-search", type: "search", placeholder: "Search People", "aria-label": "Search People", autocomplete: "off" });
    search.addEventListener("input", debounce(() => {
      this.query = search.value.trim().toLowerCase();
      this.renderList();
      this.dump();
    }, 200));
    search.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        search.value = "";
        this.query = "";
        this.renderList();
      }
    });
    this.listEl = h("div", { id: "pp-list", class: "pp-list", role: "listbox", tabindex: "0", "aria-label": "Contacts" });
    this.listEl.addEventListener("keydown", e => this.onListKey(e));
    this.cardEl = h("section", { id: "pp-card", class: "pp-card", "aria-label": "Contact card" });
    this.main.replaceChildren(h("div", { class: "pp" },
      h("section", { class: "pp-list-pane" }, h("div", { class: "list-search" }, h("div", { class: "search-box" }, search)),
        h("div", { class: "pp-list-head", id: "pp-list-head" }), this.listEl),
      this.cardEl));
  }

  renderSide() {
    const side = h("div", { class: "pp-side" });
    const row = (scope, ic, label, count, depth = 0) => {
      const el = h("div", { class: "fp-row pp-scope" + (this.scope === scope ? " selected" : ""), "data-scope": scope, style: `padding-left:${6 + depth * 16}px`,
        html: `<span class="fp-icon">${icon(ic, 16)}</span><span class="fp-name">${esc(label)}</span><span class="fp-count drafts">${count}</span>` });
      el.addEventListener("click", () => {
        this.scope = scope;
        this.renderSide();
        this.renderList();
        this.dump();
      });
      return el;
    };
    side.append(h("div", { class: "fp-section", html: `<span class="twisty">${icon("chevron-down", 12)}</span><span>My Contacts</span>` }));
    side.append(row("all", "people", "All Contacts", this.contacts.length));
    for (const b of this.books) {
      side.append(row("book:" + b.id, "address-book", b.name, this.contacts.filter(c => c.bookId === b.id).length));
      for (const g of this.groups.filter(x => x.bookId === b.id)) side.append(row("group:" + g.id, "group", g.name, g.members.length, 1));
    }
    this.side.replaceChildren(side);
  }

  visible() {
    let list = [];
    const [kind, id] = this.scope.split(/:(.*)/s);
    if (kind === "group") {
      const g = this.groups.find(x => x.id === id);
      list = g ? g.members.map(m => this.contacts.find(c => c.id === m)).filter(Boolean) : [];
    } else {
      list = kind === "book" ? this.contacts.filter(c => c.bookId === id) : [...this.contacts];
      // a book's groups listed with its people, as Outlook's contact list
      const groups = kind === "book" ? this.groups.filter(g => g.bookId === id) : this.groups;
      list = [...groups, ...list];
    }
    if (this.query) {
      list = list.filter(x => {
        const c = x.card;
        const text = c ? [c.display, c.first, c.last, c.company, c.title, ...c.emails, ...Object.values(c.phones)].join(" ") : x.name;
        return text.toLowerCase().includes(this.query);
      });
    }
    return list;
  }

  renderList() {
    if (!this.listEl) return;
    const list = this.visible();
    this.order = list.map(x => (x.card ? "contact:" : "group:") + x.id);
    const head = $("#pp-list-head");
    if (head) head.textContent = `${list.length} ${list.length === 1 ? "item" : "items"}`;
    if (!this.main.hidden) this.app.setStatus(`Items: ${list.length}`);
    const frag = document.createDocumentFragment();
    let letter = null;
    for (const x of list) {
      const key = (x.card ? "contact:" : "group:") + x.id;
      const name = x.card ? x.card.display || x.card.emails[0] || "(no name)" : x.name;
      if (x.card) {
        const l = (name[0] || "#").toUpperCase();
        if (l !== letter) {
          letter = l;
          frag.append(h("div", { class: "pp-letter", text: /\p{L}/u.test(l) ? l : "#" }));
        }
      }
      const av = avatar(name);
      const sub = x.card ? (x.card.company && x.card.emails[0] ? `${x.card.emails[0]} · ${x.card.company}` : x.card.emails[0] || x.card.company || "")
        : `Contact group · ${x.members.length} ${x.members.length === 1 ? "member" : "members"}`;
      const el = h("div", { class: "pp-row" + (this.selected === key ? " selected" : ""), role: "option", "data-key": key, title: name,
        "aria-selected": this.selected === key ? "true" : "false",
        html: (x.card ? `<span class="avatar small" style="background:${av.color}">${esc(av.initials)}</span>`
          : `<span class="avatar small group">${icon("group", 18)}</span>`) +
          `<span class="pp-who"><span class="pp-name">${esc(name)}</span><span class="pp-sub">${esc(sub)}</span></span>` });
      el.addEventListener("mousedown", () => this.select(key));
      el.addEventListener("dblclick", () => this.editSelected());
      el.addEventListener("contextmenu", e => {
        e.preventDefault();
        this.select(key);
        const item = this.selectedItem();
        showMenu([
          { label: "Email", icon: "mail-new", disabled: !this.addressesOf(item).length, action: () => this.emailSelected() },
          { label: "Meeting", icon: "meeting-new", disabled: !this.addressesOf(item).length, action: () => this.meetingSelected() },
          { separator: true },
          { label: "Edit", icon: "edit", disabled: item.readOnly, action: () => this.editSelected() },
          { label: "Delete", icon: "delete", disabled: item.readOnly, action: () => this.deleteSelected() },
        ], { x: e.clientX, y: e.clientY });
      });
      frag.append(el);
    }
    if (!list.length) {
      frag.append(h("div", { class: "ml-empty", text: this.query ? "We didn't find anyone." : "No contacts here yet." }));
    }
    this.listEl.replaceChildren(frag);
  }

  select(key) {
    this.selected = key;
    for (const el of this.listEl.querySelectorAll(".pp-row")) {
      el.classList.toggle("selected", el.dataset.key === key);
      el.setAttribute("aria-selected", el.dataset.key === key ? "true" : "false");
    }
    this.listEl.focus({ preventScroll: true });
    this.renderCard();
    this.dump();
  }

  onListKey(e) {
    if (!this.order || !this.order.length) return;
    const i = this.order.indexOf(this.selected);
    let n = null;
    if (e.key === "ArrowDown") n = Math.min(this.order.length - 1, i + 1);
    else if (e.key === "ArrowUp") n = Math.max(0, i - 1);
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = this.order.length - 1;
    else if (e.key === "Enter") {
      e.preventDefault();
      return this.editSelected();
    }
    if (n === null) return;
    e.preventDefault();
    this.select(this.order[n]);
    this.listEl.querySelector(`.pp-row[data-key="${CSS.escape(this.order[n])}"]`)?.scrollIntoView({ block: "nearest" });
  }

  renderCard() {
    if (!this.cardEl) return;
    this.updateRibbon();
    const item = this.selectedItem();
    if (!item) {
      this.cardEl.replaceChildren(h("div", { class: "rp-empty", html: `${icon("people", 64)}<p>Select a contact to see the details</p>` }));
      return;
    }
    const btn = (ic, label, fn, disabled) => h("button", { class: "rb", disabled, html: `${icon(ic, 16)}<span class="rb-label">${esc(label)}</span>`, onclick: fn });
    const actions = h("div", { class: "pp-actions" },
      btn("mail-new", "Email", () => this.emailSelected(), !this.addressesOf(item).length),
      btn("meeting-new", "Meeting", () => this.meetingSelected(), !this.addressesOf(item).length),
      btn("edit", "Edit", () => this.editSelected(), item.readOnly),
      btn("delete", "Delete", () => this.deleteSelected(), item.readOnly));
    const section = (title, rows) => {
      rows = rows.filter(r => r && r[1]);
      if (!rows.length) return null;
      return h("div", { class: "pp-section" }, h("h3", { text: title }),
        ...rows.map(([label, value, ic]) => h("div", { class: "pp-field" },
          h("span", { class: "pp-label", html: `${ic ? icon(ic, 14) : ""}${esc(label)}` }), h("span", { class: "pp-value", text: value }))));
    };
    if (item.card) {
      const c = item.card;
      const av = avatar(c.display || c.emails[0]);
      const a = c.address;
      const addr = [a.street, [a.code, a.city].filter(Boolean).join(" "), a.region, a.country].filter(Boolean).join("\n");
      const groups = this.groups.filter(g => g.members.includes(item.id)).map(g => g.name).join(", ");
      const book = this.book(item.bookId);
      this.cardEl.replaceChildren(h("div", { class: "pp-card-in" },
        h("div", { class: "pp-head" },
          h("span", { class: "avatar big", style: `background:${av.color}`, text: av.initials }),
          h("div", { class: "pp-headtext" },
            h("div", { class: "pp-bigname", id: "pp-card-name", text: c.display || c.emails[0] || "(no name)" }),
            h("div", { class: "pp-role", text: [c.title, c.company].filter(Boolean).join(" · ") }),
            actions)),
        section("Contact", [
          ...c.emails.map((e, i) => [i ? "Email " + (i + 1) : "Email", e, "mail"]),
          ["Mobile", c.phones.cell, "phone"], ["Work", c.phones.work, "phone"], ["Home", c.phones.home, "phone"]]),
        section("Work", [["Company", c.company], ["Job title", c.title], ["Address", addr, "location"]]),
        section("Personal", [["Birthday", c.birthday]]),
        section("Notes", [["", c.notes]]),
        section("Member of", [["Groups", groups, "group"]]),
        h("div", { class: "pp-foot", text: book ? `In ${book.name}` + (item.readOnly ? " (read-only)" : "") : "" })));
    } else {
      const members = item.members.map(id => this.contacts.find(c => c.id === id)).filter(Boolean);
      const list = h("div", { class: "pp-members", id: "pp-members" });
      for (const m of members) {
        const av = avatar(m.card.display || m.card.emails[0]);
        const row = h("div", { class: "pp-member", "data-id": m.id,
          html: `<span class="avatar small" style="background:${av.color}">${esc(av.initials)}</span><span class="pp-who"><span class="pp-name">${esc(m.card.display)}</span><span class="pp-sub">${esc(m.card.emails[0] || "")}</span></span>` });
        if (!item.readOnly) {
          const x = h("button", { class: "pp-remove", title: `Remove ${m.card.display} from the group`, html: icon("close", 12) });
          x.addEventListener("click", () => this.removeMember(item, m));
          row.append(x);
        }
        list.append(row);
      }
      if (!members.length) list.append(h("p", { class: "pp-sub", text: "No members yet." }));
      const add = h("button", { class: "btn small", id: "pp-add-members", disabled: item.readOnly, html: `${icon("person-add", 14)} Add Members…` });
      add.addEventListener("click", () => this.editGroup(item));
      this.cardEl.replaceChildren(h("div", { class: "pp-card-in" },
        h("div", { class: "pp-head" },
          h("span", { class: "avatar big group", html: icon("group", 40) }),
          h("div", { class: "pp-headtext" },
            h("div", { class: "pp-bigname", id: "pp-card-name", text: item.name }),
            h("div", { class: "pp-role", text: `Contact group · ${members.length} ${members.length === 1 ? "member" : "members"}` }),
            actions)),
        item.description ? section("Notes", [["", item.description]]) : null,
        h("div", { class: "pp-section" }, h("h3", {}, "Members ", add), list)));
    }
  }

  // ---- actions -----------------------------------------------------------------------------------------

  emailSelected() {
    const item = this.selectedItem();
    if (!item) return;
    const to = this.addressesOf(item);
    if (to.length) this.app.compose({ mode: "new", mailto: "mailto:" + encodeURIComponent(to.join(", ")) });
  }

  meetingSelected() {
    const item = this.selectedItem();
    if (!item) return;
    const to = this.addressesOf(item);
    if (to.length) this.app.calendar.newEvent({ meeting: true, attendees: to.join("; ") });
  }

  editSelected() {
    const item = this.selectedItem();
    if (!item || item.readOnly) return;
    if (item.card) this.editContact(item);
    else this.editGroup(item);
  }

  async deleteSelected() {
    const item = this.selectedItem();
    if (!item || item.readOnly) return;
    const name = item.card ? item.card.display || item.card.emails[0] : item.name;
    if (!(await confirmBox("Delete", `Delete ${item.card ? "the contact" : "the contact group"} "${name}"?`, "Delete", "Cancel"))) return;
    try {
      if (item.card) await messenger.addressBooks.contacts.delete(item.id);
      else await messenger.addressBooks.mailingLists.delete(item.id);
      this.selected = null;
      this.app.setStatus(`"${name}" deleted`);
    } catch (e) {
      toast("Could not delete: " + e.message);
    }
    await this.load();
  }

  // the contact's window, as a dialog in the page: name, e-mail, phones,
  // work, address, notes
  async editContact(item) {
    const books = this.writableBooks();
    if (!item && !books.length) return toast("There is no address book to add contacts to.");
    const c = item ? JSON.parse(JSON.stringify(item.card)) : parseVCard("");
    const f = (id, label, value, attrs = {}) => h("label", { class: "pp-f" }, h("span", { text: label }),
      h(attrs.tag || "input", Object.assign({ id: "ce-" + id, type: attrs.tag ? undefined : "text", value: attrs.tag ? undefined : value || "", autocomplete: "off" }, attrs.extra || {}),
        attrs.tag ? value || "" : null));
    const scopeBook = this.scope.startsWith("book:") ? this.scope.slice(5) : this.scope.startsWith("group:") ? (this.groups.find(g => "group:" + g.id === this.scope) || {}).bookId : null;
    const bookSel = h("select", { id: "ce-book", disabled: !!item },
      (item ? [this.book(item.bookId)].filter(Boolean) : books).map(b => h("option", { value: b.id, text: b.name, selected: b.id === (item ? item.bookId : scopeBook) })));
    const body = h("div", { class: "pp-form" },
      h("div", { class: "pp-grid" },
        f("first", "First name", c.first), f("last", "Last name", c.last),
        h("label", { class: "pp-f wide" }, h("span", { text: "Display as" }), h("input", { id: "ce-display", type: "text", value: item ? c.display : "", placeholder: "First Last", autocomplete: "off" })),
        f("email", "Email", c.emails[0], { extra: { type: "email" } }), f("email2", "Email 2", c.emails[1], { extra: { type: "email" } }),
        f("cell", "Mobile phone", c.phones.cell), f("work", "Work phone", c.phones.work),
        f("home", "Home phone", c.phones.home), f("birthday", "Birthday", c.birthday, { extra: { type: "date" } }),
        f("company", "Company", c.company), f("title", "Job title", c.title),
        h("label", { class: "pp-f wide" }, h("span", { text: "Street" }), h("input", { id: "ce-street", type: "text", value: c.address.street, autocomplete: "off" })),
        f("city", "City", c.address.city), f("region", "State / Province", c.address.region),
        f("code", "ZIP / Postal code", c.address.code), f("country", "Country / Region", c.address.country),
        h("label", { class: "pp-f wide" }, h("span", { text: "Notes" }), h("textarea", { id: "ce-notes", rows: "3" }, c.notes || "")),
        h("label", { class: "pp-f wide" }, h("span", { text: "Address book" }), bookSel)));
    // "Display as" follows the name until it is typed in itself
    let displayTouched = !!item && c.display !== [c.first, c.last].filter(Boolean).join(" ");
    const val = (box, id) => box.querySelector("#ce-" + id).value.trim();
    const v = await dialog({
      title: item ? `${c.display || "Contact"} - Contact` : "New Contact",
      width: 640,
      body,
      init: box => {
        const disp = box.querySelector("#ce-display");
        disp.addEventListener("input", () => {
          displayTouched = true;
        });
        for (const id of ["first", "last"]) box.querySelector("#ce-" + id).addEventListener("input", () => {
          if (!displayTouched) disp.value = [val(box, "first"), val(box, "last")].filter(Boolean).join(" ");
        });
        box.querySelector("#ce-first").focus();
      },
      buttons: [{ label: "Save & Close", primary: true, value: box => box }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    const card = {
      first: val(v, "first"), last: val(v, "last"), display: val(v, "display"),
      emails: [val(v, "email"), val(v, "email2")].filter(Boolean),
      phones: { work: val(v, "work"), cell: val(v, "cell"), home: val(v, "home") },
      company: val(v, "company"), title: val(v, "title"),
      address: { street: val(v, "street"), city: val(v, "city"), region: val(v, "region"), code: val(v, "code"), country: val(v, "country") },
      notes: v.querySelector("#ce-notes").value.trim(), birthday: val(v, "birthday"),
    };
    // more addresses than the two fields show: kept
    if (item) card.emails.push(...item.card.emails.slice(2));
    if (!card.display) card.display = [card.first, card.last].filter(Boolean).join(" ") || card.company || card.emails[0] || "";
    if (!card.display) return toast("A contact needs a name or an e-mail address.");
    const bad = card.emails.find(e => !validEmail(e));
    if (bad) toast(`"${bad}" does not look like an e-mail address; saved as typed.`);
    try {
      if (item) {
        await messenger.addressBooks.contacts.update(item.id, toVCard(card, item.vCard));
        this.selected = "contact:" + item.id;
      } else {
        const id = await messenger.addressBooks.contacts.create(v.querySelector("#ce-book").value, toVCard(card));
        this.selected = "contact:" + id;
      }
      this.app.setStatus(`"${card.display}" saved`);
    } catch (e) {
      toast("Could not save the contact: " + e.message);
    }
    await this.load();
    this.listEl.querySelector(`.pp-row[data-key="${CSS.escape(this.selected || "")}"]`)?.scrollIntoView({ block: "nearest" });
  }

  // a contact group: its name and its members (people of the same address book)
  async editGroup(group) {
    const books = this.writableBooks();
    if (!group && !books.length) return toast("There is no address book to add a group to.");
    const scopeBook = this.scope.startsWith("book:") ? this.scope.slice(5) : null;
    let bookId = group ? group.bookId : (scopeBook && books.some(b => b.id === scopeBook) ? scopeBook : books[0].id);
    const chosen = new Set(group ? group.members : []);
    const name = h("input", { id: "ge-name", type: "text", value: group ? group.name : "", autocomplete: "off", style: "flex:1" });
    const filter = h("input", { id: "ge-filter", type: "search", placeholder: "Search People", autocomplete: "off", style: "flex:1" });
    const bookSel = h("select", { id: "ge-book", disabled: !!group },
      (group ? [this.book(group.bookId)].filter(Boolean) : books).map(b => h("option", { value: b.id, text: b.name, selected: b.id === bookId })));
    const pick = h("div", { class: "pp-pick", id: "ge-pick" });
    const count = h("span", { class: "pp-sub", id: "ge-count" });
    const draw = () => {
      const q = filter.value.trim().toLowerCase();
      pick.replaceChildren(...this.contacts.filter(c => c.bookId === bookId && c.card.emails[0])
        .filter(c => !q || [c.card.display, ...c.card.emails].join(" ").toLowerCase().includes(q))
        .map(c => {
          const box = h("input", { type: "checkbox", checked: chosen.has(c.id), "data-id": c.id });
          box.addEventListener("change", () => {
            if (box.checked) chosen.add(c.id);
            else chosen.delete(c.id);
            count.textContent = `${chosen.size} selected`;
          });
          return h("label", { class: "pp-pick-row" }, box, h("span", { class: "pp-name", text: c.card.display }), h("span", { class: "pp-sub", text: c.card.emails[0] }));
        }));
      if (!pick.children.length) pick.append(h("p", { class: "pp-sub", text: "No contacts with an e-mail address here." }));
      count.textContent = `${chosen.size} selected`;
    };
    filter.addEventListener("input", draw);
    bookSel.addEventListener("change", () => {
      bookId = bookSel.value;
      chosen.clear();
      draw();
    });
    draw();
    const v = await dialog({
      title: group ? `${group.name} - Contact Group` : "New Contact Group",
      width: 520,
      body: h("div", {},
        h("div", { class: "form-row" }, h("label", { text: "Name" }), name),
        h("div", { class: "form-row" }, h("label", { text: "Address book" }), bookSel),
        h("div", { class: "form-row" }, h("label", { text: "Members" }), filter),
        pick, count),
      buttons: [{ label: "Save & Close", primary: true, value: () => name.value.trim() || null }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    // Thunderbird's lists take no <>;,"
    const clean = v.replace(/[<>;,"]/g, " ").replace(/\s+/g, " ").trim();
    try {
      let id = group && group.id;
      if (group) {
        if (clean !== group.name) await messenger.addressBooks.mailingLists.update(id, { name: clean });
        for (const m of group.members) if (!chosen.has(m)) await messenger.addressBooks.mailingLists.removeMember(id, m);
        for (const m of chosen) if (!group.members.includes(m)) await messenger.addressBooks.mailingLists.addMember(id, m);
      } else {
        id = await messenger.addressBooks.mailingLists.create(bookId, { name: clean });
        for (const m of chosen) await messenger.addressBooks.mailingLists.addMember(id, m);
      }
      this.selected = "group:" + id;
      this.app.setStatus(`"${clean}" saved`);
    } catch (e) {
      toast("Could not save the group: " + e.message);
    }
    await this.load();
  }

  async removeMember(group, contact) {
    try {
      await messenger.addressBooks.mailingLists.removeMember(group.id, contact.id);
    } catch (e) {
      toast("Could not remove: " + e.message);
    }
    await this.load();
  }

  // ---- the gates ---------------------------------------------------------------------------------------

  dump() {
    const item = this.selectedItem();
    const data = {
      scope: this.scope,
      books: this.books.map(b => b.name),
      groups: this.groups.map(g => ({ name: g.name, members: g.members.map(id => (this.contacts.find(c => c.id === id) || { card: {} }).card.display) })),
      list: [...(this.listEl ? this.listEl.querySelectorAll(".pp-row") : [])].map(el => el.querySelector(".pp-name").textContent),
      contacts: this.contacts.map(c => Object.assign({ id: c.id }, c.card)),
      card: item ? { name: $("#pp-card-name")?.textContent || "", text: this.cardEl.innerText } : null,
      title: document.title,
    };
    testDump("people.json", data);
    return data;
  }
}
