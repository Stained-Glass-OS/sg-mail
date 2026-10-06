/*
 * SG Mail -- Microsoft calendars and contacts (Microsoft 365, Outlook.com,
 * Exchange), read and written through DavMail, a gateway on this computer
 * (the experiment's ms* functions; README "Microsoft calendars and
 * contacts"). Here: the offer when such an account is added, setting it up
 * (DavMail's own sign-in window, our "waiting" box beside it), the state of
 * each account's gateway in the Calendar's side pane (not running, sign in
 * again, offline) and removing it.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, esc, dialog, toast } from "./util.js";

const STATE_TEXT = {
  ok: "Connected",
  stopped: "The calendar service is not running.",
  signin: "Sign in to Microsoft again to see this calendar.",
  password: "Thunderbird asks for this account's Exchange password when the calendar is opened.",
  offline: "Microsoft cannot be reached (offline?).",
  error: "The calendar service reported a problem.",
};

export class MicrosoftCalendars {
  constructor(app) {
    this.app = app;
    this.status = [];          // msStatus(): one per set-up account
    this.accounts = [];        // msAccounts(): those that can have it
    this.busy = new Set();     // account ids being set up or signed in
  }

  async start() {
    await this.refresh();
    // an account added: offer its calendar and contacts
    messenger.accounts.onCreated?.addListener((id, account) => this.onAccountCreated(id || account?.id));
    // and again now and then: an expired sign-in shows without a restart
    setInterval(() => this.refresh(), 5 * 60000);
  }

  async refresh() {
    try {
      this.accounts = await messenger.sgmail.msAccounts();
      this.status = await messenger.sgmail.msStatus();
    } catch (e) {
      console.error("sg-mail: Microsoft calendars", e);
    }
    this.app.calendar.renderSideIfShown?.();
    return this.dump();
  }

  // ---- adding -----------------------------------------------------------------------------------

  async onAccountCreated(accountId) {
    if (!accountId) return;
    // Thunderbird fills the new account in after it says it is there
    let acct = null;
    for (let i = 0; i < 20 && !acct; i++) {
      this.accounts = await messenger.sgmail.msAccounts().catch(() => []);
      acct = this.accounts.find(a => a.accountId === accountId);
      if (!acct) await new Promise(r => setTimeout(r, 500));
    }
    if (!acct || acct.linked) return;
    const yes = await dialog({
      title: "Calendar and contacts (Microsoft)",
      body: `<p><b>${esc(acct.email)}</b> is a Microsoft account. SG Mail can show its calendar and contacts too, and save your changes to them.</p>` +
        `<p>${acct.kind === "exchange" ? "SG Mail asks for this account's password once." : "Microsoft's sign-in opens in its own window (DavMail, the calendar service SG Mail uses). Sign in there; SG Mail never sees your Microsoft password."}</p>`,
      buttons: [{ label: "Add calendar and contacts", value: true, primary: true }, { label: "Not now", value: false, cancel: true }],
      width: 460,
    });
    if (yes) await this.connect(accountId);
  }

  // File > Add Account (and the first start): the address first; a
  // Microsoft account (Outlook.com, Hotmail, Live, Microsoft 365) is set up
  // through DavMail -- mail, calendar and contacts, one Microsoft sign-in --
  // anything else (or the person's choice) in Thunderbird's own setup
  async addAccount() {
    const field = (id, label, type, placeholder) => h("label", { style: "display:block;margin:8px 0" },
      h("span", { text: label, style: "display:block;margin-bottom:3px" }),
      h("input", { id, type, placeholder, autocomplete: "off", style: "width:100%;box-sizing:border-box" }));
    const v = await dialog({
      title: "Add an account",
      body: h("div", {}, field("aa-name", "Your name", "text", "Megan Bowen"), field("aa-email", "E-mail address", "email", "you@example.com")),
      buttons: [{ label: "Next", primary: true, value: box => ({ name: box.querySelector("#aa-name").value.trim(), email: box.querySelector("#aa-email").value.trim() }) },
        { label: "Cancel", value: null, cancel: true }],
      width: 420,
    });
    if (!v || !v.email) return null;
    const det = await messenger.sgmail.msDetect(v.email).catch(() => ({ microsoft: false }));
    if (!det.microsoft) return messenger.sgmail.openAccountSetup(v.email, v.name);
    const how = await dialog({
      title: "Microsoft account",
      body: `<p><b>${esc(v.email)}</b> is a Microsoft account (Outlook.com or Microsoft 365).</p>` +
        "<p>SG Mail connects its <b>mail, calendar and contacts</b> through DavMail, a gateway on this computer, with one sign-in to Microsoft in DavMail's own window. SG Mail never sees your Microsoft password.</p>",
      buttons: [{ label: "Connect", value: "davmail", primary: true }, { label: "Use Thunderbird's account setup", value: "thunderbird" },
        { label: "Cancel", value: null, cancel: true }],
      width: 480,
    });
    if (how === "thunderbird") return messenger.sgmail.openAccountSetup(v.email, v.name);
    if (how !== "davmail") return null;
    const key = "new:" + v.email.toLowerCase();
    this.busy.add(key);
    const waiting = this.waitingBox(v.email, key);
    let r;
    try {
      r = await messenger.sgmail.msAddAccount(v.email, v.name);
    } catch (e) {
      r = { ok: false, error: String(e.message || e) };
    } finally {
      this.busy.delete(key);
      waiting.close();
    }
    await this.refresh();
    if (r.ok) {
      toast(`${v.email}: mail, calendar and contacts added`);
      this.app.calendar.loadCalendars?.();
    } else if (!r.cancelled) {
      await this.failed("The account could not be added", r.error);
    }
    return r;
  }

  // File > Add Shared Mailbox: another mailbox the person may open (a
  // shared mailbox, or one delegated to them), through their Microsoft
  // account's gateway -- its folders a tree of their own beside theirs
  async addSharedMailbox() {
    await this.refresh();
    const own = this.accounts.filter(a => a.linked && a.kind === "microsoft");
    if (!own.length) {
      await dialog({ title: "Add Shared Mailbox", body: "<p>Shared mailboxes are opened through a Microsoft 365 account set up in SG Mail (File &gt; Add Account).</p>" });
      return null;
    }
    const body = h("div", {},
      own.length > 1 ? h("div", { class: "form-row" }, h("label", { text: "Through:" }),
        h("select", { id: "sm-account", style: "flex:1" }, ...own.map(a => h("option", { value: a.accountId, text: a.email })))) : "",
      h("div", { class: "form-row" }, h("label", { text: "Mailbox:" }),
        h("input", { type: "text", id: "sm-mailbox", style: "flex:1", placeholder: "Name or e-mail address", autocomplete: "off" })),
      h("p", { style: "color:var(--muted)", text: "What the mailbox's owner or administrator allows you (read, or read and write) is what you can do in it." }));
    const v = await dialog({ title: "Add Shared Mailbox", body, width: 460,
      buttons: [{ label: "Add", primary: true, value: b => ({ account: b.querySelector("#sm-account")?.value || own[0].accountId, mailbox: b.querySelector("#sm-mailbox").value.trim() }) },
        { label: "Cancel", value: null, cancel: true }] });
    if (!v || !v.mailbox) return null;
    const who = await this.app.calendar.resolvePerson(v.mailbox);
    if (!who) {
      await this.failed("The mailbox could not be added", `SG Mail does not know "${v.mailbox}". Type its e-mail address.`);
      return null;
    }
    let r;
    try {
      r = await messenger.sgmail.msAddSharedMailbox(v.account, who.email);
    } catch (e) {
      r = { ok: false, error: String(e.message || e) };
    }
    if (r.ok) toast(`${who.email}: its folders are added`);
    else await this.failed("The mailbox could not be added", r.error);
    return r;
  }

  // the Calendar's "Add calendar > Microsoft ..." : which account
  async chooseAndConnect() {
    this.accounts = await messenger.sgmail.msAccounts().catch(() => []);
    const free = this.accounts.filter(a => !a.linked);
    if (!free.length) {
      await dialog({ title: "Microsoft 365, Outlook.com or Exchange calendar",
        body: "<p>Add your Microsoft 365, Outlook.com or Exchange mail account first (File &gt; Add Account), then its calendar and contacts here.</p>" });
      return;
    }
    const pick = await dialog({
      title: "Microsoft 365, Outlook.com or Exchange calendar",
      body: h("div", {}, h("p", { text: "Show the calendar and contacts of:" }),
        ...free.map((a, i) => h("label", { class: "ms-pick", style: "display:block;margin:4px 0" },
          h("input", { type: "radio", name: "ms-account", value: a.accountId, ...(i === 0 ? { checked: "" } : {}) }), " " + a.email))),
      buttons: [{ label: "Add", value: box => box.querySelector("input[name=ms-account]:checked")?.value || null, primary: true }, { label: "Cancel", value: null, cancel: true }],
      width: 440,
    });
    if (pick) await this.connect(pick);
  }

  async connect(accountId) {
    if (this.busy.has(accountId)) return null;
    const acct = this.accounts.find(a => a.accountId === accountId);
    this.busy.add(accountId);
    const waiting = acct?.kind === "exchange" ? null : this.waitingBox(acct?.email || "", accountId);
    let r;
    try {
      r = await messenger.sgmail.msConnect(accountId);
    } catch (e) {
      r = { ok: false, error: String(e.message || e) };
    } finally {
      this.busy.delete(accountId);
      waiting?.close();
    }
    await this.refresh();
    if (r.ok) {
      toast(`${acct?.email || "The account"}: calendar and contacts added`);
      this.app.calendar.loadCalendars?.();
    } else if (!r.cancelled) {
      await this.failed("The calendar and contacts could not be added", r.error);
    }
    return r;
  }

  async signInAgain(accountId) {
    if (this.busy.has(accountId)) return null;
    const st = this.status.find(s => s.accountId === accountId);
    this.busy.add(accountId);
    const waiting = this.waitingBox(st?.email || "", accountId);
    let r;
    try {
      r = await messenger.sgmail.msSignIn(accountId);
    } catch (e) {
      r = { ok: false, error: String(e.message || e) };
    } finally {
      this.busy.delete(accountId);
      waiting.close();
    }
    await this.refresh();
    if (r.ok) toast(`${st?.email || "The account"}: signed in`);
    else if (!r.cancelled) await this.failed("The sign-in did not finish", r.error);
    return r;
  }

  // "waiting for Microsoft's sign-in", with Cancel, while DavMail's window is up
  waitingBox(email, accountId) {
    const shade = h("div", { class: "modal-shade ms-waiting" });
    const box = h("div", { class: "modal", role: "dialog", "aria-label": "Signing in to Microsoft", style: "width:460px" });
    const cancel = h("button", { class: "btn", text: "Cancel" });
    cancel.addEventListener("click", () => {
      cancel.disabled = true;
      messenger.sgmail.msCancel(accountId).catch(() => {});
    });
    box.append(h("div", { class: "modal-title", text: "Signing in to Microsoft" }),
      h("div", { class: "modal-body", html: `<p>Microsoft's sign-in window is opening (DavMail). Sign in there as <b>${esc(email)}</b>.</p>` +
        "<p>This box closes by itself when you have signed in.</p>" +
        // work and school accounts whose organisation lets only its
        // administrators approve apps (Microsoft's "Approval required" page)
        '<p class="ms-consent" style="color:var(--muted)">If Microsoft says <i>Approval required</i>, your organisation\'s administrator ' +
        "has to allow DavMail (application ID facd6cff-a294-4415-b59f-c5b01937d7bd) once in Microsoft Entra; until then, Cancel here.</p>" }),
      h("div", { class: "modal-buttons" }, cancel));
    shade.append(box);
    document.body.append(shade);
    return { close: () => shade.remove() };
  }

  failed(title, error) {
    console.error("sg-mail: Microsoft calendars:", title, error);
    return dialog({ title, body: `<p>${esc(title)}.</p>${error ? `<p class="ms-error" style="color:var(--muted);white-space:pre-wrap">${esc(String(error).slice(0, 400))}</p>` : ""}` });
  }

  async start1(accountId) {
    try {
      await messenger.sgmail.msStart(accountId);
    } catch (e) {
      await this.failed("The calendar service did not start", e.message);
    }
    setTimeout(() => this.refresh(), 4000);
  }

  async disconnect(accountId) {
    const st = this.status.find(s => s.accountId === accountId);
    const yes = await dialog({ title: "Remove calendar and contacts",
      body: `<p>Remove the Microsoft calendar and contacts of <b>${esc(st?.email || accountId)}</b> from SG Mail? Nothing is deleted at Microsoft.</p>`,
      buttons: [{ label: "Remove", value: true, primary: true }, { label: "Cancel", value: false, cancel: true }] });
    if (!yes) return;
    await messenger.sgmail.msDisconnect(accountId);
    await this.refresh();
    this.app.calendar.loadCalendars?.();
  }

  // ---- the Calendar's side pane: one line an account that needs something ----------------------

  sideStatus() {
    const box = h("div", { class: "ms-status" });
    for (const s of this.status) {
      if (s.state === "ok") continue;
      const busy = this.busy.has(s.accountId) || s.signingIn;
      const row = h("div", { class: `ms-row ms-${s.state}`, "data-account": s.accountId, "data-state": s.state,
        style: "margin:6px 4px;padding:6px 8px;border:1px solid var(--border);border-left:3px solid #c50f1f;border-radius:4px;font-size:12px" });
      row.append(h("div", { class: "ms-email", style: "font-weight:600", html: `${icon("calendar", 12)} ${esc(s.email)}` }),
        h("div", { class: "ms-text", text: busy ? "Signing in…" : STATE_TEXT[s.state] || s.state }));
      if (s.detail && s.state === "error") row.append(h("div", { class: "ms-detail", style: "color:var(--muted)", text: s.detail.slice(0, 160) }));
      const act = (label, fn) => {
        const b = h("button", { class: "btn small ms-action", text: label, style: "margin-top:4px" });
        b.addEventListener("click", fn);
        row.append(b);
      };
      if (!busy) {
        if (s.state === "stopped") act("Start", () => this.start1(s.accountId));
        if (s.state === "signin" || s.state === "error") act("Sign in again", () => this.signInAgain(s.accountId));
        if (s.state === "offline") act("Try again", () => this.refresh());
      }
      box.append(row);
    }
    return box;
  }

  dump() {
    return {
      accounts: this.accounts.map(a => ({ accountId: a.accountId, email: a.email, kind: a.kind, linked: a.linked })),
      status: this.status.map(s => ({ accountId: s.accountId, email: s.email, state: s.state, detail: s.detail || "", port: s.port })),
      busy: [...this.busy],
    };
  }
}
