/*
 * SG Mail -- the reading pane: the message's subject, sender (with the
 * initials picture), recipients and date, Reply / Reply All / Forward, the
 * meeting request's Accept / Tentative / Decline, the attachments, and the
 * text, made safe (sanitize.js) and shown in a frame that runs no scripts;
 * pictures from the network only when the reader asks.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, esc, fmt, parseAddress, avatar, textToHtml, sizeText, showMenu, toast, blobToDataUrl } from "./util.js";
import { sanitize, frameDocument } from "./sanitize.js";

function walk(part, fn, parentType = "") {
  fn(part, parentType);
  for (const p of part.parts || []) walk(p, fn, (part.contentType || "").toLowerCase());
}

function header(part, name) {
  const v = part.headers && part.headers[name];
  return Array.isArray(v) ? v[0] : v || "";
}

// the text to show: the HTML version if there is one, else the plain text
export function bodyOf(full) {
  let html = null, plain = null, calendar = null;
  walk(full, (p) => {
    const type = (p.contentType || "").toLowerCase();
    const disp = header(p, "content-disposition").toLowerCase();
    const isAttachment = disp.startsWith("attachment") || (p.name && !type.startsWith("text/"));
    if (type === "text/calendar" && p.body && !calendar) calendar = { ics: p.body, method: (header(p, "content-type").match(/method=\"?([A-Za-z]+)/i) || [])[1] || "" };
    if (isAttachment) return;
    if (type === "text/html" && html === null && typeof p.body === "string") html = p.body;
    else if (type === "text/plain" && plain === null && typeof p.body === "string") plain = p.body;
  });
  return { html, plain, calendar };
}

export class ReadingPane {
  constructor(el, actions) {
    this.el = el;
    this.actions = actions;      // {reply, replyAll, forward, compose, openFolderOf}
    this.message = null;
    this.readTimer = null;
    this.state = {};
    this.showEmpty();
  }

  showEmpty(text = "Select an item to read") {
    this.cards = null;
    // a message still loading is not shown over this
    this.token = Symbol("empty");
    clearTimeout(this.readTimer);
    this.message = null;
    this.state = { empty: true };
    this.el.replaceChildren(h("div", { class: "rp-empty", html: `${icon("mail-read", 64)}<p>${esc(text)}</p>` }));
  }

  showMany(n) {
    this.showEmpty(`${n} items selected`);
    this.state.many = n;
  }

  async show(msg) {
    clearTimeout(this.readTimer);
    this.message = msg;
    const token = (this.token = Symbol("show"));
    this.shownAt = performance.now();
    // read as soon as it is chosen (Outlook's "when the selection changes"):
    // the flag here at once, the server's in the background
    if (!msg.read && !(this.actions.readDelay > 0)) this.actions.markRead([msg], true);
    // background fetching (previews, prefetch) gives way for a moment: the
    // folder has one connection, and this message is the one wanted now
    window.sgmailBusyUntil = performance.now() + 4000;
    messenger.sgmail.pausePrefetch?.(4000).catch(() => {});
    // the ones beside it fetched ahead (arrow keys through the list)
    this.actions.prefetchAround?.(msg);
    const steps = (this.lastSteps = {});
    const mark = k => (steps[k] = Math.round(performance.now() - this.shownAt));
    let full;
    try {
      full = await messenger.messages.getFull(msg.id);
      mark("full");
    } catch (e) {
      if (this.token !== token) return;
      this.el.replaceChildren(h("div", { class: "rp-empty", html: `<p>This message could not be opened.</p><p style="font-size:12px">${esc(e.message)}</p>` }));
      return;
    }
    if (this.token !== token) return;
    const body = bodyOf(full);
    const sender = parseAddress(msg.author);
    // the attachments listed alongside (not waited for: the text first)
    const listing = messenger.messages.listAttachments(msg.id).catch(() => []);
    let allowRemote = false;
    try {
      allowRemote = await messenger.sgmail.remoteContentAllowed(sender.email);
    } catch (e) {
      // no
    }
    // something else chosen meanwhile (another message, many of them)
    if (this.token !== token) return;
    // the text at once ...
    this.state = { id: msg.id, body, cid: new Map(), attachments: [], allowRemote, sender, full };
    this.render();
    mark("render");
    this.lastShowMs = performance.now() - this.shownAt;
    this.onShown?.(msg.id, this.lastShowMs);
    // ... then the pictures from inside the message (cid:), all at once, and
    // the attachments: drawn again when they are there
    const parts = [];
    walk(full, p => parts.push(p));
    const cid = new Map();
    await Promise.all(parts.map(async p => {
      const id = header(p, "content-id").replace(/^<|>$/g, "").toLowerCase();
      if (!id || !body.html || !body.html.toLowerCase().includes("cid:" + id)) return;
      try {
        const file = await messenger.messages.getAttachmentFile(msg.id, p.partName);
        cid.set(id, await blobToDataUrl(file));
      } catch (e) {
        // not there
      }
    }));
    const attachments = await listing;
    mark("complete");
    if (this.token !== token) return;
    const shownAttachments = attachments.filter(a => {
      const id = (a.contentId || "").replace(/^<|>$/g, "").toLowerCase();
      return !(id && cid.has(id)) && !/^text\/calendar/i.test(a.contentType || "");
    });
    if (cid.size || shownAttachments.length) {
      this.state = Object.assign({}, this.state, { cid, attachments: shownAttachments });
      this.render();
    }
    this.onComplete?.(msg.id);
    // (a delay set: read once shown for that long)
    if (!msg.read && this.actions.readDelay > 0) {
      this.readTimer = setTimeout(() => {
        if (this.message && this.message.id === msg.id) this.actions.markRead([msg], true);
      }, this.actions.readDelay ?? 1000);
    }
  }

  // a conversation: its messages newest first, each a card that opens to
  // its text (the newest and the unread ones open), wherever they are kept
  // (one's own replies in Sent Items); Reply / Reply All / Forward on each
  async showConversation(items, { subject } = {}) {
    clearTimeout(this.readTimer);
    const token = (this.token = Symbol("conversation"));
    this.message = items[0].msg;
    this.state = { conversation: true, items };
    const people = [];
    for (const it of items) {
      const n = parseAddress(it.msg.author);
      if (!people.includes(n.name || n.email)) people.push(n.name || n.email);
    }
    const head = h("div", { class: "rp-head cv-head" },
      h("h1", { class: "rp-subject", text: subject || items[0].msg.subject || "(no subject)" }),
      h("div", { class: "rp-to", text: `${items.length} messages · ${people.join(", ")}` }));
    const list = h("div", { class: "cv-list", id: "cv-list" });
    const open = new Set(items.filter((it, i) => i === 0 || !it.msg.read).map(it => it.msg.id));
    this.cards = [];
    for (const it of items) {
      const card = this.conversationCard(it, open.has(it.msg.id), token);
      this.cards.push(card);
      list.append(card.el);
    }
    this.el.replaceChildren(head, list);
    // the unread ones open are read at once (or after the delay set)
    const unread = items.filter(it => !it.msg.read && open.has(it.msg.id)).map(it => it.msg);
    if (unread.length && !(this.actions.readDelay > 0)) this.actions.markRead(unread, true);
    else if (unread.length) {
      this.readTimer = setTimeout(() => {
        if (this.token === token) this.actions.markRead(unread, true);
      }, this.actions.readDelay ?? 1000);
    }
  }

  conversationCard(it, expanded, token) {
    const msg = it.msg;
    const sender = parseAddress(msg.author);
    const av = avatar(sender.name || sender.email);
    const el = h("div", { class: "cv-item" + (msg.read ? "" : " unread"), "data-id": msg.id });
    const top = h("div", { class: "cv-top" },
      h("div", { class: "avatar small", style: `background:${av.color}`, text: av.initials }),
      h("div", { class: "cv-who" },
        h("div", { class: "cv-from", text: sender.name || sender.email }),
        h("div", { class: "cv-sub", text: it.folderName && !it.here ? `${it.folderName} · ${fmt.full(msg.date)}` : fmt.full(msg.date) })),
      h("div", { class: "cv-snippet" }));
    const acts = h("div", { class: "rp-actions" });
    for (const [id, ic, label, fn] of [["reply", "reply", "Reply", "reply"], ["replyall", "reply-all", "Reply All", "replyAll"], ["forward", "forward", "Forward", "forward"]]) {
      const b = h("button", { class: "rb", title: label, "data-act": id, html: `${icon(ic, 16)}<span>${esc(label)}</span>` });
      b.addEventListener("click", e => {
        e.stopPropagation();
        this.actions[fn](msg);
      });
      acts.append(b);
    }
    top.append(acts);
    const body = h("div", { class: "cv-body" });
    el.append(top, body);
    const card = { el, msg, it, expanded: false, text: "" };
    const setOpen = async on => {
      card.expanded = on;
      el.classList.toggle("open", on);
      if (on && !body.firstChild) await this.fillCard(card, body, token);
    };
    top.addEventListener("click", () => setOpen(!card.expanded));
    card.setOpen = setOpen;
    setOpen(expanded);
    // the first words while closed
    messenger.messages.listInlineTextParts(msg.id).then(async parts => {
      const plain = parts.find(p => p.contentType === "text/plain");
      let text = plain ? plain.content : "";
      if (!text) {
        const html = parts.find(p => p.contentType === "text/html");
        if (html) text = await messenger.messengerUtilities.convertToPlainText(html.content);
      }
      top.querySelector(".cv-snippet").textContent = text.replace(/^>.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 160);
    }).catch(() => {});
    return card;
  }

  async fillCard(card, body, token) {
    let full;
    try {
      full = await messenger.messages.getFull(card.msg.id);
    } catch (e) {
      body.textContent = "This message could not be opened.";
      return;
    }
    if (this.token !== token) return;
    const b = bodyOf(full);
    const plain = b.html === null;
    const clean = plain ? { html: textToHtml(b.plain || ""), head: "", remote: false } : sanitize(b.html, { cid: new Map(), allowRemote: false });
    const dark = document.documentElement.classList.contains("dark");
    const iframe = h("iframe", { class: "cv-frame", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", title: "Message", referrerpolicy: "no-referrer" });
    iframe.srcdoc = frameDocument(clean, { allowRemote: false, dark, plain });
    iframe.addEventListener("load", () => {
      this.wireFrame(iframe);
      try {
        card.text = iframe.contentDocument.body.innerText;
        iframe.style.height = Math.min(4000, iframe.contentDocument.documentElement.scrollHeight + 4) + "px";
      } catch (e) {
        // not loaded
      }
    });
    body.classList.toggle("plain", plain);
    body.replaceChildren(iframe);
  }

  render() {
    const msg = this.message;
    const st = this.state;
    const av = avatar(st.sender.name || st.sender.email);
    const head = h("div", { class: "rp-head" });
    const fullSubject = (this.state.full && this.state.full.headers && (this.state.full.headers.subject || [])[0]) || msg.subject;
    head.append(h("h1", { class: "rp-subject", text: fullSubject || "(no subject)" }));
    const who = h("div", { class: "rp-who" },
      h("div", { class: "rp-from", html: `${esc(st.sender.name || st.sender.email)}${st.sender.name ? ` <span class="addr">&lt;${esc(st.sender.email)}&gt;</span>` : ""}` }),
      h("div", { class: "rp-to", title: (msg.recipients || []).join("; "), text: "To: " + (msg.recipients || []).join("; ") }),
      (msg.ccList || []).length ? h("div", { class: "rp-to", text: "Cc: " + msg.ccList.join("; ") }) : null,
      h("div", { class: "rp-date", text: fmt.full(msg.date) }),
    );
    const acts = h("div", { class: "rp-actions" });
    const act = (id, ic, label, fn) => {
      const b = h("button", { class: "rb", id: "rp-" + id, title: label, html: `${icon(ic, 16)}<span>${esc(label)}</span>` });
      b.addEventListener("click", fn);
      acts.append(b);
    };
    act("reply", "reply", "Reply", () => this.actions.reply(msg));
    act("replyall", "reply-all", "Reply All", () => this.actions.replyAll(msg));
    act("forward", "forward", "Forward", () => this.actions.forward(msg));
    const more = h("button", { class: "rb", title: "More actions", html: icon("more", 16) });
    more.addEventListener("click", () => showMenu([
      { label: "View Source", action: () => this.actions.viewSource(msg) },
      { label: "Print…", icon: "print", action: () => this.print() },
      { label: "Show in Folder", icon: "folder", action: () => this.actions.openFolderOf(msg) },
    ], more));
    acts.append(more);
    head.append(h("div", { class: "rp-sender" }, h("div", { class: "avatar", style: `background:${av.color}`, text: av.initials }), who, acts));

    // the message's categories, as Outlook's coloured bar under the header
    head.append(h("div", { class: "rp-cats", id: "rp-cats" }));

    const bars = h("div", { class: "rp-bars" });
    if (st.remoteFound && !st.allowRemote) {
      const bar = h("div", { class: "infobar", id: "rp-remote-bar", html: `${icon("picture", 16)}<span style="flex:1">To help protect your privacy, SG Mail prevented automatic download of some pictures in this message.</span>` });
      const dl = h("button", { class: "btn", id: "rp-download-pictures", text: "Download pictures" });
      dl.addEventListener("click", () => {
        st.allowRemote = true;
        this.render();
      });
      const always = h("button", { class: "btn", text: "Always from this sender" });
      always.addEventListener("click", async () => {
        await messenger.sgmail.allowRemoteContent(st.sender.email);
        st.allowRemote = true;
        this.render();
      });
      bar.append(dl, always);
      bars.append(bar);
    }
    const invite = h("div", { id: "rp-invite-slot" });

    const atts = h("div", { class: "rp-attachments" });
    for (const a of st.attachments) {
      const chip = h("div", { class: "att-chip", title: a.name, "data-part": a.partName,
        html: `${icon("attach", 18)}<div style="min-width:0"><div class="att-name">${esc(a.name || "attachment")}</div><div class="att-size">${esc(sizeText(a.size || 0))}</div></div>` });
      chip.addEventListener("click", () => showMenu([
        { label: "Open", action: () => this.openAttachment(a) },
        { label: "Save As…", icon: "save", action: () => this.saveAttachment(a) },
        { label: "Save All Attachments…", disabled: st.attachments.length < 2, action: () => st.attachments.forEach(x => this.saveAttachment(x)) },
      ], chip));
      chip.addEventListener("dblclick", () => this.openAttachment(a));
      atts.append(chip);
    }

    const plain = st.body.html === null;
    const frameWrap = h("div", { class: "rp-body" + (plain ? " plain" : "") });
    const iframe = h("iframe", { id: "rp-frame", sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox", title: "Message", referrerpolicy: "no-referrer" });
    let clean;
    if (!plain) clean = sanitize(st.body.html, { cid: st.cid, allowRemote: st.allowRemote });
    else clean = { html: textToHtml(st.body.plain || ""), head: "", remote: false };
    if (clean.remote && !st.remoteFound) {
      st.remoteFound = true;
      if (!st.allowRemote) return this.render();
    }
    const dark = document.documentElement.classList.contains("dark");
    iframe.srcdoc = frameDocument(clean, { allowRemote: st.allowRemote, dark, plain });
    iframe.addEventListener("load", () => this.wireFrame(iframe));
    frameWrap.append(iframe);
    this.el.replaceChildren(head, bars, invite, st.attachments.length ? atts : "", frameWrap);
    this.paintCategories();
    this.lastRender = { remoteBlocked: !!(st.remoteFound && !st.allowRemote), html: clean.html };
    if (st.body.calendar) this.renderInvite(invite);
  }

  wireFrame(iframe) {
    const doc = iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", e => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute("href");
      if (/^mailto:/i.test(href)) this.actions.compose({ mailto: href });
      else if (/^(https?|ftp):/i.test(href)) messenger.windows.openDefaultBrowser(href);
    }, true);
    // keys typed in the message reach the window's shortcuts
    doc.addEventListener("keydown", e => {
      const copy = new KeyboardEvent("keydown", e);
      if (document.dispatchEvent(copy) === false) e.preventDefault();
    });
  }

  async renderInvite(slot) {
    const st = this.state;
    const msgId = this.message.id;
    let info;
    try {
      info = await messenger.sgmail.itipInfo(msgId, st.body.calendar.ics, st.body.calendar.method);
    } catch (e) {
      slot.replaceChildren(h("div", { class: "infobar", text: "This message contains a meeting request SG Mail could not read: " + e.message }));
      return;
    }
    if (!this.message || this.message.id !== msgId) return;
    st.invite = info;
    const ev = info.event;
    const box = h("div", { class: "rp-invite", id: "rp-invite" });
    const text = h("div", { style: "flex:1;min-width:0" });
    if (ev) {
      const when = ev.allDay ? fmt.longDate(new Date(ev.start)) : `${fmt.full(new Date(ev.start))} – ${fmt.time(new Date(ev.end))}`;
      text.append(h("div", { class: "when", text: when }));
      if (ev.location) text.append(h("div", { class: "where", html: `${icon("location", 12)} ${esc(ev.location)}` }));
    }
    text.append(h("div", { class: "label", text: info.label || "" }));
    // more than one calendar it could go in: which, here (the first is the account's)
    let calSel = null;
    if ((info.calendars || []).length > 1 && info.actions.some(a => ["accept", "tentative", "add"].includes(a))) {
      calSel = h("select", { id: "invite-calendar", title: "Calendar" }, info.calendars.map(c => h("option", { value: c.id, text: c.name })));
      text.append(h("div", { class: "where", style: "margin-top:6px" }, "Calendar: ", calSel));
    }
    const acts = h("div", { class: "acts" });
    const labels = { accept: ["accept", "Accept"], tentative: ["tentative", "Tentative"], decline: ["decline", "Decline"],
      add: ["calendar", "Add to Calendar"], update: ["sync", "Update"], delete: ["delete", "Remove from Calendar"], reconfirm: ["sync", "Reconfirm"] };
    for (const a of info.actions) {
      const [ic, label] = labels[a] || ["more", a];
      const b = h("button", { class: "btn small", id: "invite-" + a, html: `${icon(ic, 14)} ${esc(label)}` });
      b.addEventListener("click", async () => {
        for (const x of acts.querySelectorAll("button")) x.disabled = true;
        try {
          const calendarId = calSel ? calSel.value : ((info.calendars || [])[0] || {}).id || null;
          const r = await messenger.sgmail.itipRespond(msgId, a, true, calendarId);
          toast(r.label || (r.ok ? "Done" : "Nothing changed"));
        } catch (e) {
          toast("The response could not be sent: " + e.message);
        }
        if (this.message && this.message.id === msgId) this.renderInvite(slot);
      });
      acts.append(b);
    }
    text.append(acts);
    box.append(h("span", { html: icon("calendar", 28) }), text);
    slot.replaceChildren(box);
  }

  async openAttachment(a) {
    try {
      const tab = await messenger.tabs.getCurrent();
      await messenger.messages.openAttachment(this.message.id, a.partName, tab.id);
    } catch (e) {
      toast("The attachment could not be opened: " + e.message);
    }
  }

  async saveAttachment(a) {
    try {
      const file = await messenger.messages.getAttachmentFile(this.message.id, a.partName);
      const url = URL.createObjectURL(file);
      const link = h("a", { href: url, download: a.name || "attachment" });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      toast("The attachment could not be saved: " + e.message);
    }
  }

  print() {
    const f = this.el.querySelector("#rp-frame");
    f && f.contentWindow && f.contentWindow.print();
  }

  paintCategories() {
    const box = this.el.querySelector("#rp-cats");
    if (!box || !this.message) return;
    const tags = this.tagsOf ? this.tagsOf(this.message.tags) : [];
    box.replaceChildren(...tags.map(t => h("span", { class: "rp-cat", style: `--cat:${t.color}`, text: t.tag })));
  }

  dump() {
    if (!this.message) return { empty: true, many: this.state.many || 0 };
    if (this.state.conversation) {
      return {
        id: this.message.id,
        subject: this.el.querySelector(".rp-subject")?.textContent || "",
        conversation: (this.cards || []).map(c => ({ id: c.msg.id, subject: c.msg.subject, from: parseAddress(c.msg.author).name || parseAddress(c.msg.author).email,
          folder: c.it.folderName || "", expanded: c.expanded, text: (c.text || "").slice(0, 600) })),
      };
    }
    const f = this.el.querySelector("#rp-frame");
    let text = "", images = [];
    try {
      text = f.contentDocument.body.innerText;
      images = [...f.contentDocument.images].map(i => i.getAttribute("src") || "").map(s => s.slice(0, 60));
    } catch (e) {
      // not loaded
    }
    return {
      id: this.message.id,
      subject: this.message.subject,
      remoteBlocked: !!(this.lastRender && this.lastRender.remoteBlocked),
      remoteBar: !!this.el.querySelector("#rp-remote-bar"),
      attachments: (this.state.attachments || []).map(a => a.name),
      text: text.slice(0, 2000),
      images,
      html: this.lastRender ? this.lastRender.html.slice(0, 4000) : "",
      categories: [...this.el.querySelectorAll(".rp-cat")].map(e => e.textContent),
      invite: this.state.invite ? { method: this.state.invite.method, actions: this.state.invite.actions, label: this.state.invite.label } : null,
      sandbox: f ? f.getAttribute("sandbox") : null,
    };
  }
}
