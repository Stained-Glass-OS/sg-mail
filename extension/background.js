/*
 * SG Mail -- the background: when Thunderbird starts with SG Mail's profile,
 * each main window becomes SG Mail's window (our page in its own tab, and
 * Thunderbird's own bars hidden).
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
"use strict";

const MAIN_URL = browser.runtime.getURL("ui/main.html");

const claimed = new Map();        // window id -> our tab id
let queue = Promise.resolve();

async function claimNow(win) {
  if (win.type !== "normal" || !(await browser.sgmail.isActive())) return;
  const known = claimed.get(win.id);
  const tabs = await browser.tabs.query({ windowId: win.id });
  if (known && tabs.some(t => t.id === known)) return;
  // a tab of ours the session brought back loaded before we were ready:
  // a fresh one instead
  for (const t of tabs) if (t.url && t.url.startsWith(MAIN_URL)) await browser.tabs.remove(t.id);
  // no mail account yet (the first start): adding one, in front
  const accounts = await browser.accounts.list(false);
  const setup = !accounts.some(a => a.type !== "none" && a.type !== "local");
  // (SG Mail's own first step: the address; a Microsoft account goes
  // through DavMail, any other to Thunderbird's account setup)
  const ours = await browser.tabs.create({ windowId: win.id, url: MAIN_URL + (setup ? "?setup=1" : ""), active: true });
  claimed.set(win.id, ours.id);
  await browser.sgmail.takeOverWindow(win.id, ours.id);
}

function claim(win) {
  queue = queue.then(() => claimNow(win)).catch(e => console.error("sg-mail: claim", e));
  return queue;
}

async function claimAll() {
  for (const win of await browser.windows.getAll({ windowTypes: ["normal"] })) claim(win);
}

// our tab closed (Ctrl+W): the window gets it back
browser.tabs.onRemoved.addListener((tabId, info) => {
  if (claimed.get(info.windowId) === tabId && !info.isWindowClosing) {
    claimed.delete(info.windowId);
    browser.windows.get(info.windowId).then(claim, () => {});
  }
});

browser.windows.onCreated.addListener(win => claim(win));
browser.runtime.onStartup.addListener(claimAll);
browser.runtime.onInstalled.addListener(claimAll);
claimAll();

// A message window Thunderbird opened itself (a mailto: link, "send to" from
// the file manager, the address book's Write): ours instead, with what it
// had in it.
browser.windows.onCreated.addListener(async win => {
  if (win.type !== "messageCompose" || !(await browser.sgmail.isActive())) return;
  let tabs = [];
  for (let i = 0; i < 20 && !tabs.length; i++) {
    tabs = await browser.tabs.query({ windowId: win.id });
    if (!tabs.length) await new Promise(r => setTimeout(r, 100));
  }
  const tab = tabs[0];
  if (!tab) return;
  let details;
  try {
    details = await browser.compose.getComposeDetails(tab.id);
  } catch (e) {
    return;
  }
  const attachments = [];
  try {
    for (const a of await browser.compose.listAttachments(tab.id)) {
      const file = await browser.compose.getAttachmentFile(a.id);
      attachments.push({ name: a.name, contentType: file.type || "application/octet-stream", size: file.size, data: await file.arrayBuffer() });
    }
  } catch (e) {
    console.error("sg-mail: hand-off attachments", e);
  }
  const key = "handoff-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const list = v => (Array.isArray(v) ? v : v ? [v] : []).filter(x => typeof x === "string");
  await browser.storage.local.set({ [key]: {
    to: list(details.to), cc: list(details.cc), bcc: list(details.bcc), subject: details.subject || "",
    body: details.isPlainText ? (details.plainTextBody || "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]).replace(/\n/g, "<br>") : (details.body || ""),
    identityId: details.identityId || "", attachments,
  } });
  await browser.windows.remove(win.id).catch(() => {});
  await browser.windows.create({ type: "popup", url: browser.runtime.getURL("ui/compose.html?handoff=" + encodeURIComponent(key)), width: 1000, height: 760, allowScriptsToClose: true });
});

// An account removed: its Microsoft calendar and contacts (DavMail's
// gateway, settings and token) go with it
browser.accounts.onDeleted.addListener(id => {
  browser.sgmail.msDisconnect(id).catch(e => console.error("sg-mail: Microsoft calendars", e));
});
