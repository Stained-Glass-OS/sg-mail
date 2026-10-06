/*
 * SG Mail -- the message window: From, To, Cc, Bcc (with names completed
 * from the address books and the addresses written to before), Subject,
 * attachments and the text, written in rich text. Replies quote the
 * original under Outlook's header (From, Sent, To, Cc, Subject); Forward
 * brings its attachments. Send hands it to Thunderbird (sgmail.sendMessage:
 * SMTP or the account's own way, a copy in Sent Items); Save keeps it in
 * Drafts.
 *
 *   compose.html?mode=new|reply|replyAll|forward|draft&id=MESSAGE&identity=ID
 *   compose.html?mailto=mailto:...      compose.html?handoff=KEY
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, $, $$, esc, fmt, showMenu, toast, dialog, applyLook, parseAddress, splitAddresses, formatAddress, validEmail, sizeText, debounce, testDump, searchAddressBooks } from "./util.js";
import { Ribbon } from "./ribbon.js";
import { sanitize } from "./sanitize.js";
import { bodyOf } from "./reader.js";
import { installTestHook } from "./testhook.js";

const params = new URLSearchParams(location.search);
const state = {
  mode: params.get("mode") || "new",
  originalId: params.get("id") ? Number(params.get("id")) : null,
  identities: [],
  attachments: [],          // {name, contentType, size, data: ArrayBuffer}
  references: "",
  priority: "",
  dirty: false,
  draftId: null,            // the saved draft this replaces
  sending: false,
};

function markDirty() {
  state.dirty = true;
}

// ---- the window -------------------------------------------------------------------------------

async function init() {
  applyLook();
  $("#send-icon").innerHTML = icon("send", 28);
  buildRibbon();
  await loadIdentities();
  for (const id of ["to", "cc", "bcc"]) wireAddressField($("#" + id));
  for (const b of $$(".c-label-btn")) b.addEventListener("click", () => pickFromAddressBook(b.dataset.field));
  $("#send").addEventListener("click", () => send("now"));
  $("#subject").addEventListener("input", () => {
    updateTitle();
    markDirty();
  });
  $("#editor").addEventListener("input", markDirty);
  for (const id of ["to", "cc", "bcc"]) $("#" + id).addEventListener("input", markDirty);
  document.addEventListener("keydown", onKey);
  window.addEventListener("beforeunload", e => {
    if (state.dirty && !state.sending && !state.closing) {
      e.preventDefault();
    }
  });
  try {
    await prefill();
    // Quick Steps: a forward to (or a new message for) the addresses it keeps
    if (params.get("to") && !params.get("mailto")) $("#to").value = params.get("to");
    if (params.get("subject") && !params.get("mailto")) $("#subject").value = params.get("subject");
  } catch (e) {
    console.error("sg-mail: compose", e);
    infobar("The original message could not be read: " + e.message);
  }
  // the original is read: a Quick Step may move or delete it now
  messenger.runtime.sendMessage({ type: "sgmail-compose-prefilled", originalId: state.originalId }).catch(() => {});
  state.dirty = false;
  updateTitle();
  // Outlook saves an unsent message every few minutes
  setInterval(() => {
    if (state.dirty && !state.sending) send("draft", { quiet: true });
  }, 3 * 60 * 1000);
  window.sgmailCompose = { state, send, dump };
  // (send and close answer first: the window may be gone before an answer)
  installTestHook("compose", { dump, send: a => !setTimeout(() => send(a.mode || "now"), 50), close: () => !setTimeout(closeWindow, 50), contacts: a => searchContacts(a.term) });
  testDump("compose-ready.json", dump());
}

function updateTitle() {
  document.title = `${$("#subject").value || "Untitled"} - Message (HTML)`;
}

function infobar(text) {
  $("#bars").replaceChildren(h("div", { class: "infobar", id: "c-error", html: `${icon("info", 16)}<span style="flex:1">${esc(text)}</span>` }));
}

function buildRibbon() {
  const exec = (cmd, arg) => () => {
    $("#editor").focus();
    document.execCommand(cmd, false, arg);
    markDirty();
  };
  const fonts = ["Inter", "Arial", "Calibri", "Cambria", "Courier New", "Georgia", "Liberation Sans", "Liberation Serif", "Times New Roman", "Verdana"];
  new Ribbon($("#ribbon"), {
    tabs: [
      { id: "message", label: "Message", groups: [
        { label: "Clipboard", items: [{ col: [
          { id: "cut", icon: "move", label: "Cut", action: exec("cut") },
          { id: "copy", icon: "templates", label: "Copy", action: exec("copy") },
          { id: "paste", icon: "drafts", label: "Paste", action: () => toast("Paste with Ctrl+V") },
        ] }] },
        { label: "Basic Text", items: [
          { col: [
            { id: "font", icon: "drafts", label: "Font", menu: () => fonts.map(f => ({ label: f, action: exec("fontName", f) })) },
            { id: "size", icon: "drafts", label: "Size", menu: () => [["8", 1], ["10", 2], ["11", 3], ["14", 4], ["18", 5], ["24", 6], ["36", 7]].map(([l, v]) => ({ label: l, action: exec("fontSize", String(v)) })) },
            { id: "color", icon: "drafts", label: "Color", menu: () => [["Automatic", "inherit"], ["Red", "#c50f1f"], ["Blue", "#0f6cbd"], ["Green", "#107c10"], ["Orange", "#ca5010"], ["Purple", "#8764b8"], ["Gray", "#605e5c"]].map(([l, c]) => ({ label: l, swatch: c === "inherit" ? "transparent" : c, action: exec("foreColor", c === "inherit" ? "#201f1e" : c) })) },
          ] },
          { col: [
            { id: "bold", icon: "bold", label: "Bold", shortcut: "Ctrl+B", action: exec("bold") },
            { id: "italic", icon: "italic", label: "Italic", shortcut: "Ctrl+I", action: exec("italic") },
            { id: "underline", icon: "underline", label: "Underline", shortcut: "Ctrl+U", action: exec("underline") },
          ] },
          { col: [
            { id: "bullets", icon: "bullets", label: "Bullets", action: exec("insertUnorderedList") },
            { id: "numbering", icon: "numbering", label: "Numbering", action: exec("insertOrderedList") },
            { id: "align", icon: "align-left", label: "Align", menu: () => [
              { label: "Left", icon: "align-left", action: exec("justifyLeft") },
              { label: "Center", icon: "align-center", action: exec("justifyCenter") },
              { label: "Right", icon: "align-right", action: exec("justifyRight") },
            ] },
          ] },
        ] },
        { label: "Names", items: [
          { id: "address-book", icon: "address-book", label: "Address Book", large: true, action: () => pickFromAddressBook("to") },
          { id: "check-names", icon: "person", label: "Check Names", large: true, action: () => checkNames(true) },
        ] },
        { label: "Include", items: [
          { id: "attach-file", icon: "attach", label: "Attach File", large: true, action: () => attachFiles() },
          { id: "signature", icon: "signature", label: "Signature", large: true, action: () => insertSignature(true) },
        ] },
        { label: "Tags", items: [{ col: [
          { id: "high", icon: "importance-high", label: "High Importance", action: () => setPriority("High") },
          { id: "low", icon: "importance-low", label: "Low Importance", action: () => setPriority("Low") },
        ] }] },
      ] },
      { id: "insert", label: "Insert", groups: [
        { label: "Include", items: [
          { id: "attach-file2", icon: "attach", label: "Attach File", large: true, action: () => attachFiles() },
          { id: "signature2", icon: "signature", label: "Signature", large: true, action: () => insertSignature(true) },
        ] },
        { label: "Links", items: [
          { id: "link", icon: "link", label: "Link", large: true, action: () => insertLink() },
        ] },
        { label: "Illustrations", items: [
          { id: "picture", icon: "picture", label: "Pictures", large: true, action: () => insertPicture() },
        ] },
      ] },
      { id: "options", label: "Options", groups: [
        { label: "Show Fields", items: [
          { id: "show-bcc", icon: "people", label: "Bcc", large: true, action: () => toggleBcc() },
          { id: "show-from", icon: "person", label: "From", large: true, action: () => $("#from").focus() },
        ] },
        { label: "More Options", items: [
          { id: "save-draft", icon: "save", label: "Save", large: true, shortcut: "Ctrl+S", action: () => send("draft") },
          { id: "send-later", icon: "outbox", label: "Send Later", large: true, action: () => send("later") },
        ] },
      ] },
    ],
  });
}

async function loadIdentities() {
  const accounts = await messenger.accounts.list(false);
  const sel = $("#from");
  for (const a of accounts) {
    for (const i of a.identities || []) {
      state.identities.push(Object.assign({ account: a }, i));
      sel.append(h("option", { value: i.id, text: formatAddress({ name: i.name, email: i.email }) }));
    }
  }
  const want = params.get("identity");
  if (want && state.identities.some(i => i.id === want)) sel.value = want;
  sel.addEventListener("change", () => insertSignature(false, true));
}

function identity() {
  return state.identities.find(i => i.id === $("#from").value) || state.identities[0];
}

function toggleBcc(on) {
  const row = $("#bcc-row");
  row.hidden = on === undefined ? !row.hidden : !on;
}

function setPriority(p) {
  state.priority = state.priority === p ? "" : p;
  toast(state.priority ? `${p} importance` : "Normal importance");
}

// ---- prefilling ----------------------------------------------------------------------------------

const PREFIX = { reply: "RE: ", replyAll: "RE: ", forward: "FW: " };

function stripPrefixes(subject) {
  return (subject || "").replace(/^((re|fw|fwd|aw|wg|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, "");
}

function signatureHtml() {
  const i = identity();
  if (!i || !i.signature) return "";
  const sig = i.signatureIsPlainText ? esc(i.signature).replace(/\n/g, "<br>") : sanitize(i.signature).html;
  return `<div class="sg-signature">${sig}</div>`;
}

function insertSignature(atCursor, replaceOld = false) {
  const ed = $("#editor");
  const old = ed.querySelector(".sg-signature");
  const html = signatureHtml();
  if (replaceOld && old) {
    if (html) old.outerHTML = html;
    else old.remove();
    return;
  }
  if (!html) {
    if (atCursor) toast("This account has no signature: set one in Account Settings.");
    return;
  }
  if (atCursor) {
    ed.focus();
    document.execCommand("insertHTML", false, html);
  }
  markDirty();
}

async function prefill() {
  const ed = $("#editor");
  const mode = state.mode;
  if (params.get("mailto")) return prefillMailto(params.get("mailto"));
  if (params.get("handoff")) return prefillHandoff(params.get("handoff"));
  if (mode === "new" || !state.originalId) {
    ed.innerHTML = `<p><br></p><p><br></p>${signatureHtml()}`;
    setTimeout(() => $("#to").focus(), 0);
    return;
  }
  const orig = await messenger.messages.get(state.originalId);
  const full = await messenger.messages.getFull(state.originalId);
  const body = bodyOf(full);
  const header = name => {
    const v = full.headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v || "";
  };
  if (mode === "draft") {
    state.draftId = state.originalId;
    $("#to").value = (orig.recipients || []).join(", ");
    $("#cc").value = (orig.ccList || []).join(", ");
    if ((orig.bccList || []).length) {
      $("#bcc").value = orig.bccList.join(", ");
      toggleBcc(true);
    }
    $("#subject").value = orig.subject || "";
    ed.innerHTML = body.html !== null ? sanitize(body.html, { allowRemote: true }).html : esc(body.plain || "").replace(/\n/g, "<br>");
    await addOriginalAttachments(state.originalId);
    state.references = header("references");
    selectIdentityFor([orig.author]);
    return;
  }
  // reply / reply all / forward
  $("#subject").value = PREFIX[mode] + stripPrefixes(orig.subject);
  const mine = new Set(state.identities.map(i => i.email.toLowerCase()));
  if (mode === "reply" || mode === "replyAll") {
    const replyTo = header("reply-to");
    const to = replyTo ? splitAddresses(replyTo) : [orig.author];
    if (mode === "replyAll") {
      for (const r of orig.recipients || []) to.push(r);
    }
    const seen = new Set();
    const keep = list => list.filter(a => {
      const e = parseAddress(a).email.toLowerCase();
      if (!e || seen.has(e) || mine.has(e)) return false;
      seen.add(e);
      return true;
    });
    let toList = keep(to);
    // a reply to our own message goes to its recipients
    if (!toList.length && mine.has(parseAddress(orig.author).email.toLowerCase())) toList = keep(orig.recipients || []);
    $("#to").value = toList.join(", ");
    if (mode === "replyAll") $("#cc").value = keep(orig.ccList || []).join(", ");
    const msgid = orig.headerMessageId ? `<${orig.headerMessageId}>` : "";
    state.references = [header("references"), msgid].filter(Boolean).join(" ").trim();
  } else {
    await addOriginalAttachments(state.originalId);
  }
  selectIdentityFor([...(orig.recipients || []), ...(orig.ccList || [])]);
  const quoted = body.html !== null
    ? sanitize(body.html, { allowRemote: false }).html
    : esc(body.plain || "").replace(/\n/g, "<br>");
  const line = (label, value) => value ? `<b>${label}:</b> ${esc(value)}<br>` : "";
  const head = `<div class="sg-quote-head">${line("From", orig.author)}${line("Sent", fmt.full(orig.date))}${line("To", (orig.recipients || []).join("; "))}${line("Cc", (orig.ccList || []).join("; "))}${line("Subject", orig.subject)}</div>`;
  ed.innerHTML = `<p><br></p><p><br></p>${signatureHtml()}${head}<blockquote type="cite" class="sg-quoted">${quoted}</blockquote>`;
  // the cursor at the top, as Outlook's
  const r = document.createRange();
  r.setStart(ed.firstChild, 0);
  r.collapse(true);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  setTimeout(() => (mode === "forward" ? $("#to") : ed).focus(), 0);
}

function selectIdentityFor(addresses) {
  if (params.get("identity") && state.mode === "new") return;
  const emails = addresses.map(a => parseAddress(a).email.toLowerCase());
  const hit = state.identities.find(i => emails.includes(i.email.toLowerCase()));
  if (hit) $("#from").value = hit.id;
}

async function addOriginalAttachments(id) {
  let list = [];
  try {
    list = await messenger.messages.listAttachments(id);
  } catch (e) {
    return;
  }
  for (const a of list) {
    if (/^text\/calendar/i.test(a.contentType || "")) continue;
    try {
      const file = await messenger.messages.getAttachmentFile(id, a.partName);
      state.attachments.push({ name: a.name || "attachment", contentType: a.contentType || "application/octet-stream", size: file.size, data: await file.arrayBuffer() });
    } catch (e) {
      console.error(e);
    }
  }
  renderAttachments();
}

function prefillMailto(url) {
  const u = new URL(url);
  const q = u.searchParams;
  const to = [decodeURIComponent(u.pathname || ""), q.get("to") || ""].filter(Boolean).join(", ");
  $("#to").value = to;
  if (q.get("cc")) $("#cc").value = q.get("cc");
  if (q.get("bcc")) {
    $("#bcc").value = q.get("bcc");
    toggleBcc(true);
  }
  $("#subject").value = q.get("subject") || "";
  const body = q.get("body") || "";
  $("#editor").innerHTML = `${esc(body).replace(/\n/g, "<br>")}<p><br></p>${signatureHtml()}`;
  setTimeout(() => ($("#subject").value ? $("#editor") : $("#subject")).focus(), 0);
}

async function prefillHandoff(key) {
  const st = await messenger.storage.local.get(key);
  const d = st[key] || {};
  await messenger.storage.local.remove(key);
  $("#to").value = (d.to || []).join(", ");
  $("#cc").value = (d.cc || []).join(", ");
  if ((d.bcc || []).length) {
    $("#bcc").value = d.bcc.join(", ");
    toggleBcc(true);
  }
  $("#subject").value = d.subject || "";
  $("#editor").innerHTML = d.body ? sanitize(d.body, { allowRemote: true }).html : `<p><br></p>${signatureHtml()}`;
  for (const a of d.attachments || []) state.attachments.push(a);
  renderAttachments();
  if (d.identityId) $("#from").value = d.identityId;
}

// ---- addresses ---------------------------------------------------------------------------------------

function contactFromVCard(vcard) {
  const fn = (vcard.match(/^FN[^:]*:(.*)$/mi) || [])[1] || "";
  const emails = [...vcard.matchAll(/^EMAIL[^:]*:(.*)$/gmi)].map(m => m[1].trim());
  return emails.map(email => ({ name: fn.replace(/\\,/g, ",").trim(), email }));
}

async function searchContacts(term) {
  let nodes = [];
  try {
    nodes = await searchAddressBooks(term);
  } catch (e) {
    return [];
  }
  const out = [], seen = new Set();
  for (const n of nodes) {
    const vcard = n.vCard || "";
    const list = vcard ? contactFromVCard(vcard) : [{ name: (n.properties || {}).DisplayName || "", email: (n.properties || {}).PrimaryEmail || "" }];
    for (const c of list) {
      const k = c.email.toLowerCase();
      if (!c.email || seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
  }
  return out.slice(0, 12);
}

function wireAddressField(input) {
  const box = $("#complete");
  let items = [], active = -1;
  const current = () => {
    const v = input.value;
    const cut = Math.max(v.lastIndexOf(","), v.lastIndexOf(";"));
    return { before: cut >= 0 ? v.slice(0, cut + 1) + " " : "", term: v.slice(cut + 1).trim() };
  };
  const close = () => {
    box.hidden = true;
    items = [];
    active = -1;
  };
  const choose = i => {
    const c = items[i];
    if (!c) return;
    input.value = current().before + formatAddress(c) + ", ";
    close();
    markDirty();
    input.focus();
  };
  const show = debounce(async () => {
    const { term } = current();
    if (term.length < 1 || document.activeElement !== input) return close();
    items = await searchContacts(term);
    if (!items.length) return close();
    active = 0;
    box.replaceChildren(...items.map((c, i) => {
      const d = h("div", { class: i === 0 ? "active" : "", html: `${esc(c.name || c.email)} ${c.name ? `<span class="em">&lt;${esc(c.email)}&gt;</span>` : ""}` });
      d.addEventListener("mousedown", e => {
        e.preventDefault();
        choose(i);
      });
      return d;
    }));
    const r = input.getBoundingClientRect();
    box.style.left = r.left + "px";
    box.style.top = r.bottom + 2 + "px";
    box.hidden = false;
  }, 150);
  input.addEventListener("input", show);
  input.addEventListener("blur", () => setTimeout(close, 150));
  input.addEventListener("keydown", e => {
    if (box.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      $$("div", box).forEach((d, i) => d.classList.toggle("active", i === active));
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (active >= 0) {
        e.preventDefault();
        choose(active);
      }
    } else if (e.key === "Escape") {
      close();
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

function addressesOf(id) {
  return splitAddresses($("#" + id).value).map(parseAddress).filter(a => a.email);
}

// resolve what was typed: "Name <a@b>" or a@b stays; a name alone is looked up
async function checkNames(report) {
  let bad = [];
  for (const id of ["to", "cc", "bcc"]) {
    const out = [];
    for (const raw of splitAddresses($("#" + id).value)) {
      const a = parseAddress(raw);
      if (validEmail(a.email)) {
        out.push(formatAddress(a));
        continue;
      }
      const hits = await searchContacts(raw);
      if (hits.length === 1) out.push(formatAddress(hits[0]));
      else {
        out.push(raw);
        bad.push(raw);
      }
    }
    $("#" + id).value = out.join(", ");
  }
  if (report && !bad.length) toast("All names are recognised.");
  return bad;
}

async function pickFromAddressBook(field) {
  const results = h("div", { style: "height:260px;overflow:auto;border:1px solid var(--border);border-radius:3px;margin-top:6px" });
  const search = h("input", { type: "text", placeholder: "Search", style: "width:100%" });
  const picked = { to: [], cc: [], bcc: [] };
  const run = debounce(async () => {
    const list = await searchContacts(search.value.trim() || "@");
    results.replaceChildren(...list.map(c => {
      const row = h("div", { class: "menu-item", html: `${icon("person", 16)}<span>${esc(c.name || c.email)}</span><span style="color:var(--muted)">${esc(c.email)}</span>` });
      row.addEventListener("dblclick", () => {
        picked[field].push(formatAddress(c));
        toast(`${c.name || c.email} added`);
      });
      return row;
    }));
  }, 200);
  search.addEventListener("input", run);
  run();
  const ok = await dialog({
    title: "Select Names",
    width: 520,
    body: h("div", {}, search, results, h("p", { style: "color:var(--muted);font-size:12px", text: "Double-click a name to add it." })),
    buttons: [{ label: "OK", primary: true, value: true }, { label: "Cancel", value: false, cancel: true }],
  });
  if (ok && picked[field].length) {
    const cur = $("#" + field).value.trim().replace(/[,;]\s*$/, "");
    $("#" + field).value = (cur ? cur + ", " : "") + picked[field].join(", ");
    if (field === "bcc") toggleBcc(true);
    markDirty();
  }
}

// ---- attachments and insertions ------------------------------------------------------------------------

function attachFiles() {
  const input = h("input", { type: "file", multiple: true, style: "display:none" });
  input.addEventListener("change", async () => {
    for (const f of input.files) await addFile(f);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

async function addFile(f) {
  state.attachments.push({ name: f.name, contentType: f.type || "application/octet-stream", size: f.size, data: await f.arrayBuffer() });
  renderAttachments();
  markDirty();
}

function renderAttachments() {
  $("#atts-row").hidden = !state.attachments.length;
  $("#atts").replaceChildren(...state.attachments.map((a, i) => {
    const chip = h("div", { class: "c-att", title: a.name, html: `${icon("attach", 14)}<span class="n">${esc(a.name)}</span><span class="s">${esc(sizeText(a.size || a.data.byteLength))}</span>` });
    const x = h("button", { title: "Remove attachment", html: icon("close", 12) });
    x.addEventListener("click", () => {
      state.attachments.splice(i, 1);
      renderAttachments();
      markDirty();
    });
    chip.append(x);
    return chip;
  }));
}

async function insertLink() {
  const url = await dialog({
    title: "Insert Hyperlink",
    body: `<div class="form-row"><label>Address:</label><input id="ln-url" type="text" style="flex:1" value="https://"></div>`,
    buttons: [{ label: "OK", primary: true, value: box => box.querySelector("#ln-url").value.trim() }, { label: "Cancel", value: null, cancel: true }],
  });
  if (!url || !/^(https?|mailto|ftp):/i.test(url)) return;
  $("#editor").focus();
  const sel = getSelection();
  if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${esc(url)}">${esc(url)}</a>`);
  else document.execCommand("createLink", false, url);
  markDirty();
}

function insertPicture() {
  const input = h("input", { type: "file", accept: "image/*", style: "display:none" });
  input.addEventListener("change", async () => {
    const f = input.files[0];
    input.remove();
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      $("#editor").focus();
      document.execCommand("insertImage", false, r.result);
      markDirty();
    };
    r.readAsDataURL(f);
  });
  document.body.append(input);
  input.click();
}

// files dropped on the window are attached
document.addEventListener("dragover", e => {
  if (e.dataTransfer.types.includes("Files")) e.preventDefault();
});
document.addEventListener("drop", async e => {
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) await addFile(f);
});

// ---- sending -------------------------------------------------------------------------------------------

function bodyHtml() {
  const ed = $("#editor").cloneNode(true);
  // pictures of the original held back while writing go with the message
  for (const el of ed.querySelectorAll("[data-sg-src]")) {
    el.setAttribute("src", el.getAttribute("data-sg-src"));
    el.removeAttribute("data-sg-src");
  }
  for (const el of ed.querySelectorAll("[data-sg-background]")) {
    el.setAttribute("background", el.getAttribute("data-sg-background"));
    el.removeAttribute("data-sg-background");
  }
  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head>` +
    `<body style="font-family: Inter, Calibri, Arial, sans-serif; font-size: 11pt;">${ed.innerHTML}</body></html>`;
}

async function send(mode, { quiet = false } = {}) {
  if (state.sending) return;
  const id = identity();
  if (!id) {
    infobar("There is no account to send from: add one first (File > Add Account).");
    return;
  }
  if (mode !== "draft") {
    const bad = await checkNames(false);
    if (bad.length) {
      infobar(`SG Mail does not recognise ${bad.map(b => `"${b}"`).join(", ")}. Type the full e-mail address.`);
      return;
    }
    if (!addressesOf("to").length && !addressesOf("cc").length && !addressesOf("bcc").length) {
      infobar("There must be at least one name or contact group in the To, Cc, or Bcc box.");
      return;
    }
    if (!$("#subject").value.trim()) {
      const go = await dialog({ title: "SG Mail", body: "<p>This message has no subject. Do you want to send it anyway?</p>",
        buttons: [{ label: "Send Anyway", value: true, primary: true }, { label: "Don't Send", value: false, cancel: true }] });
      if (!go) return;
    }
  }
  state.sending = true;
  $("#send").disabled = true;
  if (!quiet) toast(mode === "draft" ? "Saving…" : "Sending…", 20000);
  const details = {
    identityId: id.id,
    accountId: id.accountId,
    to: addressesOf("to").map(formatAddress).join(", "),
    cc: addressesOf("cc").map(formatAddress).join(", "),
    bcc: addressesOf("bcc").map(formatAddress).join(", "),
    subject: $("#subject").value,
    html: bodyHtml(),
    attachments: state.attachments.map(a => ({ name: a.name, contentType: a.contentType, data: a.data })),
    mode,
    compType: state.mode === "draft" ? "draft" : state.mode,
    originalMessageId: ["reply", "replyAll", "forward"].includes(state.mode) ? state.originalId : null,
    references: state.references,
    replaceDraftMessageId: state.draftId,
    priority: state.priority,
  };
  let result;
  try {
    result = await messenger.sgmail.sendMessage(details);
  } catch (e) {
    result = { ok: false, error: e.message };
  }
  state.sending = false;
  $("#send").disabled = false;
  testDump("compose-result.json", { mode, result, details: Object.assign({}, details, { attachments: details.attachments.map(a => a.name), html: details.html.slice(0, 3000) }) });
  if (!result.ok) {
    infobar((mode === "draft" ? "The message could not be saved: " : "The message could not be sent: ") + (result.error || "unknown error"));
    return;
  }
  if (mode === "draft") {
    state.dirty = false;
    // the next save replaces this one: find it in Drafts by its Message-ID
    if (result.messageId) findDraft(result.messageId);
    if (!quiet) toast("Saved to Drafts");
    return;
  }
  state.closing = true;
  window.close();
}

async function findDraft(messageId) {
  const mid = messageId.replace(/^<|>$/g, "");
  for (let i = 0; i < 10; i++) {
    try {
      const r = await messenger.messages.query({ headerMessageId: mid });
      if (r.messages.length) {
        state.draftId = r.messages[r.messages.length - 1].id;
        return;
      }
    } catch (e) {
      // not yet
    }
    await new Promise(res => setTimeout(res, 500));
  }
}

async function closeWindow() {
  if (state.dirty) {
    const v = await dialog({
      title: "SG Mail",
      body: "<p>Want to save your changes to this message?</p>",
      buttons: [{ label: "Save", value: "save", primary: true }, { label: "Don't Save", value: "discard" }, { label: "Cancel", value: null, cancel: true }],
    });
    if (!v) return;
    if (v === "save") await send("draft", { quiet: true });
  }
  state.closing = true;
  window.close();
}

function onKey(e) {
  if (document.querySelector(".modal-shade")) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const run = fn => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
  if ((ctrl && k === "Enter") || (e.altKey && k === "s")) return run(() => send("now"));
  if (ctrl && !e.shiftKey && k === "s") return run(() => send("draft"));
  if (ctrl && e.shiftKey && k === "b") return run(() => pickFromAddressBook("to"));
  if (ctrl && k === "k" && !e.shiftKey) return run(() => checkNames(true));
  if (k === "Escape" && !document.querySelector(".menu")) return run(() => closeWindow());
  if (ctrl && k === "w") return run(() => closeWindow());
  if (ctrl && e.shiftKey && k === "a") return run(() => attachFiles());
}

function dump() {
  return {
    mode: state.mode,
    from: identity() ? identity().email : "",
    to: $("#to").value,
    cc: $("#cc").value,
    bcc: $("#bcc").value,
    subject: $("#subject").value,
    body: $("#editor").innerText.slice(0, 3000),
    attachments: state.attachments.map(a => a.name),
    title: document.title,
  };
}

init();
