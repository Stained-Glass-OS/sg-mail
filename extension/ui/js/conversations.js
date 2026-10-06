/*
 * SG Mail -- conversations: which messages belong together (by the
 * Message-IDs each names: its own, and the ones it answers), and what Clean
 * Up decides by (a message whose whole text is quoted in a later reply of
 * the same conversation says nothing that reply does not).
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

// info: [{id, msgid, refs}] -> Map(id -> conversation key). Messages that
// name one another (directly or through others) are one conversation; its
// key is the smallest Message-ID it names, so it stays as messages come.
export function groupConversations(info) {
  const parent = new Map();
  const find = x => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const n = parent.get(x);
      parent.set(x, r);
      x = n;
    }
    return r;
  };
  const add = x => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a, b) => {
    add(a);
    add(b);
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    // the smaller name stays the root: the key
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const x of info) {
    const own = x.msgid || `sg-no-id-${x.id}`;
    add(own);
    for (const r of x.refs || []) union(own, r);
  }
  const out = new Map();
  for (const x of info) out.set(x.id, find(x.msgid || `sg-no-id-${x.id}`));
  return out;
}

// every Message-ID a conversation's messages name
export function conversationIds(info) {
  const out = new Set();
  for (const x of info) {
    if (x.msgid) out.add(x.msgid);
    for (const r of x.refs || []) out.add(r);
  }
  return [...out];
}

// a message's words as Clean Up compares them: quote marks, blank lines
// and spacing gone
export function cleanText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(l => l.replace(/^(\s*>)+/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Clean Up: the messages (of one conversation) a later reply holds whole.
// items: [{msg, info: {msgid, refs}, text}], oldest first. Unread, flagged
// and categorized messages stay, as Outlook's settings have it by default.
export function redundantMessages(items) {
  const out = [];
  for (const a of items) {
    const m = a.msg;
    if (!m.read || m.flagged || (m.tags || []).length) continue;
    const t = cleanText(a.text);
    if (!t || !a.info.msgid) continue;
    const covered = items.some(b => b !== a && b.msg.date >= m.date && (b.info.refs || []).includes(a.info.msgid) &&
      cleanText(b.text).includes(t));
    if (covered) out.push(m);
  }
  return out;
}

// a message's text: the plain part, or the HTML one made plain
export async function messageText(id) {
  try {
    const parts = await messenger.messages.listInlineTextParts(id);
    const plain = parts.find(p => p.contentType === "text/plain");
    if (plain) return plain.content;
    const html = parts.find(p => p.contentType === "text/html");
    if (html) return await messenger.messengerUtilities.convertToPlainText(html.content);
  } catch (e) {
    // the server is away
  }
  return "";
}
