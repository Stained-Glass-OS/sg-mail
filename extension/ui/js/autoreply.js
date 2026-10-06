/*
 * SG Mail -- Automatic Replies (out of office): File > Automatic Replies.
 * Where the account's mail server keeps rules (ManageSieve, RFC 5804, with
 * the Sieve vacation extension: Dovecot, Cyrus, Stalwart and many hosts),
 * the reply is set there and is sent while this computer is off. Where it
 * does not, SG Mail can answer from this computer instead, only while it
 * runs -- the dialog and the bar under the ribbon say so. Either way: once
 * to each sender, never to mailing lists or other automatic mail
 * (RFC 3834), within the time range if one is given.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { h, $, esc, toast, dialog, parseAddress, testDump } from "./util.js";

const pad = n => String(n).padStart(2, "0");
const local = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const WEEK = 7 * 86400000;

export class AutoReplies {
  constructor(app) {
    this.app = app;
    this.settings = {};       // accountId -> {on, mode: "server" | "local", start, end, text, server, sent: {email: ms}}
  }

  async load() {
    try {
      const st = await messenger.storage.local.get("autoReplies");
      this.settings = st.autoReplies || {};
    } catch (e) {
      // first start
    }
    this.renderBanner();
  }

  save() {
    return messenger.storage.local.set({ autoReplies: this.settings }).catch(() => {});
  }

  accounts() {
    return this.app.mail.folders.accounts;
  }

  active(s, now = Date.now()) {
    return !!s && s.on && (!s.start || now >= s.start) && (!s.end || now < s.end);
  }

  // the bar under the ribbon while replies are on, as the classic client's
  renderBanner() {
    let bar = $("#autoreply-bar");
    const on = this.accounts().filter(a => this.settings[a.id] && this.settings[a.id].on);
    if (!on.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = h("div", { id: "autoreply-bar", class: "autoreply-bar" });
      $("#ribbon").after(bar);
    }
    const a = on[0];
    const s = this.settings[a.id];
    const who = (a.identities[0] || {}).email || a.name;
    const how = s.mode === "local" ? " from this computer, only while SG Mail is running" : "";
    const off = h("button", { class: "btn small", id: "autoreply-off", text: "Turn off" });
    off.addEventListener("click", () => this.turnOff(a.id));
    bar.replaceChildren(h("span", { class: "ar-label", text: "AUTOMATIC REPLIES" }),
      h("span", { class: "ar-text", text: `Automatic replies are being sent for ${who}${how}.` }), off);
  }

  async turnOff(accountId) {
    const s = this.settings[accountId];
    if (!s) return;
    if (s.mode === "server") {
      try {
        await messenger.sgmail.sieveSetVacation(accountId, s.server || null, { on: false });
      } catch (e) {
        return toast("The server's automatic reply could not be turned off: " + e.message);
      }
    }
    s.on = false;
    await this.save();
    this.renderBanner();
    this.app.setStatus("Automatic replies are off");
  }

  // ---- the dialog --------------------------------------------------------------------------

  async open(accountId) {
    const accounts = this.accounts();
    if (!accounts.length) return toast("Add an account first.");
    let acct = accounts.find(a => a.id === accountId) || (this.app.mail.folder && accounts.find(a => a.id === this.app.mail.folder.accountId)) || accounts[0];
    const s = Object.assign({ on: false, text: "", start: 0, end: 0, server: "" }, this.settings[acct.id] || {});
    const now = new Date();
    const body = h("div", { class: "ar-dialog" });
    const acctSel = h("select", { id: "ar-account" }, accounts.map(a => h("option", { value: a.id, text: (a.identities[0] || {}).email || a.name, selected: a.id === acct.id })));
    const where = h("div", { id: "ar-where", class: "infobar", text: "Looking at your mail server…" });
    const offR = h("input", { type: "radio", name: "ar-on", id: "ar-off", checked: !s.on });
    const onR = h("input", { type: "radio", name: "ar-on", id: "ar-on", checked: s.on });
    const range = h("input", { type: "checkbox", id: "ar-range", checked: !!(s.start || s.end) });
    const start = h("input", { type: "datetime-local", id: "ar-start", value: local(new Date(s.start || now.getTime())) });
    const end = h("input", { type: "datetime-local", id: "ar-end", value: local(new Date(s.end || now.getTime() + WEEK)) });
    const text = h("textarea", { id: "ar-text", rows: "7", style: "width:100%", text: s.text || "" });
    const server = h("input", { type: "text", id: "ar-server", placeholder: "host:4190", value: s.server || "", style: "flex:1" });
    const check = h("button", { class: "btn small", text: "Check" });
    body.append(
      accounts.length > 1 ? h("div", { class: "form-row" }, h("label", { text: "Account:" }), acctSel) : "",
      where,
      h("div", { class: "form-row" }, h("label", { style: "min-width:0" }, offR, " Do not send automatic replies")),
      h("div", { class: "form-row" }, h("label", { style: "min-width:0" }, onR, " Send automatic replies")),
      h("div", { class: "form-row", style: "padding-left:22px" }, h("label", { style: "min-width:0" }, range, " Only send during this time range:")),
      h("div", { class: "form-row", style: "padding-left:44px" }, h("label", { text: "Start time" }), start),
      h("div", { class: "form-row", style: "padding-left:44px" }, h("label", { text: "End time" }), end),
      h("div", { class: "qs-head", text: "Reply once to each sender with:" }),
      text,
      h("details", { class: "ar-advanced" }, h("summary", { text: "Server" }),
        h("div", { class: "form-row" }, h("label", { text: "Rules server (ManageSieve):" }), server, check)));
    let status = null, probes = 0;
    const probe = async () => {
      // (the account or server changed meanwhile: only the last look counts)
      const mine = ++probes;
      where.className = "infobar";
      where.textContent = "Looking at your mail server…";
      status = null;
      const type = acct.type;
      let st;
      if (type !== "imap") {
        st = { available: false, error: type === "ews" || type === "graph" || type === "owl"
          ? "Exchange and Microsoft 365 keep automatic replies on their server; SG Mail cannot set them there yet (set them in the web mail of Microsoft 365 or Exchange)"
          : "This account's server keeps no rules SG Mail can reach" };
      } else {
        try {
          st = await messenger.sgmail.sieveStatus(acct.id, server.value.trim() || null);
        } catch (e) {
          st = { available: false, error: e.message };
        }
      }
      if (mine !== probes) return;
      status = st;
      if (status.available) {
        where.className = "infobar ok";
        where.id = "ar-where";
        where.textContent = `Your mail server (${status.server}) sends these replies, also while this computer is off.`;
        if (status.on && status.settings) {
          onR.checked = true;
          if (status.settings.text && !text.value) text.value = status.settings.text;
        }
      } else {
        where.className = "infobar warn";
        where.textContent = `${status.error || "Your mail server does not offer automatic replies"}. SG Mail can send them from this computer instead: only while SG Mail is running.`;
      }
    };
    check.addEventListener("click", probe);
    acctSel.addEventListener("change", () => {
      acct = accounts.find(a => a.id === acctSel.value);
      const o = this.settings[acct.id] || {};
      text.value = o.text || "";
      onR.checked = !!o.on;
      offR.checked = !o.on;
      server.value = o.server || "";
      probe();
    });
    const v = await dialog({
      title: "Automatic Replies",
      body,
      width: 600,
      init: () => probe(),
      buttons: [{ label: "OK", primary: true, value: "ok" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (v !== "ok") return;
    const next = {
      on: onR.checked,
      text: text.value,
      start: range.checked && start.value ? new Date(start.value).getTime() : 0,
      end: range.checked && end.value ? new Date(end.value).getTime() : 0,
      server: server.value.trim(),
    };
    if (next.on && !next.text.trim()) return toast("Type the reply to send."), this.open(acct.id);
    if (next.on && next.end && next.start && next.end <= next.start) return toast("The end time is before the start time."), this.open(acct.id);
    while (!status) await probe();
    const old = this.settings[acct.id];
    if (status.available) {
      try {
        await messenger.sgmail.sieveSetVacation(acct.id, next.server || null, next);
      } catch (e) {
        return toast("The server did not take the automatic reply: " + e.message);
      }
      this.settings[acct.id] = Object.assign(next, { mode: "server" });
    } else {
      // (who has been answered starts again with each new reply)
      this.settings[acct.id] = Object.assign(next, { mode: "local", sent: old && old.mode === "local" && old.on && next.on && old.text === next.text ? old.sent || {} : {} });
    }
    // a server's reply turned off when replies now come from here (and the other way)
    if (old && old.mode === "server" && this.settings[acct.id].mode === "local") messenger.sgmail.sieveSetVacation(acct.id, old.server || null, { on: false }).catch(() => {});
    await this.save();
    this.renderBanner();
    this.app.setStatus(next.on ? `Automatic replies are on (${this.settings[acct.id].mode === "server" ? "on the server" : "from this computer while SG Mail runs"})` : "Automatic replies are off");
    this.dump();
  }

  // ---- answering from this computer --------------------------------------------------------

  async onNewMail(folder, msgs) {
    if (!(folder.specialUse || []).includes("inbox")) return;
    const s = this.settings[folder.accountId];
    if (!this.active(s) || s.mode !== "local" || !msgs.length) return;
    const acct = this.accounts().find(a => a.id === folder.accountId);
    if (!acct) return;
    const mine = new Set(acct.identities.map(i => (i.email || "").toLowerCase()));
    let info = [];
    try {
      info = await messenger.sgmail.focusInfo(msgs.map(m => m.id), false);
    } catch (e) {
      return;
    }
    s.sent = s.sent || {};
    const now = Date.now();
    for (const m of msgs) {
      const x = info.find(i => i.id === m.id) || {};
      const email = x.email || parseAddress(m.author).email.toLowerCase();
      // never to oneself, lists, newsletters, other automatic mail, or junk
      if (!email || mine.has(email) || x.bulk || m.junk) continue;
      if (s.sent[email] && now - s.sent[email] < (s.end ? s.end - s.start : WEEK)) continue;
      s.sent[email] = now;
      await this.save();
      const ident = acct.identities.find(i => (m.recipients || []).concat(m.ccList || []).some(r => parseAddress(r).email.toLowerCase() === (i.email || "").toLowerCase())) || acct.identities[0];
      try {
        const r = await messenger.sgmail.sendMessage({
          identityId: ident.id,
          accountId: acct.id,
          to: m.author,
          subject: "Automatic reply: " + (m.subject || ""),
          html: `<div>${esc(s.text).replace(/\r?\n/g, "<br>")}</div>`,
          references: m.headerMessageId ? `<${m.headerMessageId}>` : "",
          headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
          noCopy: true,
          mode: "now",
          compType: "new",
        });
        if (!r.ok) throw new Error(r.error || "not sent");
        this.app.setStatus(`Automatic reply sent to ${email}`);
      } catch (e) {
        delete s.sent[email];
        await this.save();
        console.error("sg-mail: automatic reply", e);
      }
    }
    this.dump();
  }

  dump() {
    const data = {
      settings: Object.fromEntries(Object.entries(this.settings).map(([k, v]) => [k, { on: v.on, mode: v.mode, start: v.start, end: v.end, text: v.text, sent: Object.keys(v.sent || {}) }])),
      banner: $("#autoreply-bar") ? $("#autoreply-bar").innerText : "",
      where: $("#ar-where") ? $("#ar-where").textContent : "",
    };
    testDump("autoreply.json", data);
    return data;
  }
}
