/*
 * SG Mail -- its icons: simple line drawings on a 20 px grid, in the text's
 * colour, with the accent where a colour says something (a flag, a new item).
 * Our own drawings.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const S = 'fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';
const A = 'fill="none" stroke="var(--accent)" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"';

const envelope = `<rect x="2.5" y="4.5" width="15" height="11" rx="1.5" ${S}/><path d="M3 5.5l7 5.5 7-5.5" ${S}/>`;
const plus = (x, y) => `<circle cx="${x}" cy="${y}" r="3.6" fill="var(--accent)"/><path d="M${x} ${y - 2}v4M${x - 2} ${y}h4" stroke="#fff" stroke-width="1.3" stroke-linecap="round"/>`;
const calendarBase = `<rect x="2.5" y="3.5" width="15" height="13.5" rx="1.5" ${S}/><path d="M2.5 7.5h15M6.5 2v3M13.5 2v3" ${S}/>`;
const folderBase = `<path d="M2.5 6V15a1.5 1.5 0 0 0 1.5 1.5h12A1.5 1.5 0 0 0 17.5 15V7.5A1.5 1.5 0 0 0 16 6h-6.5L8 4H4a1.5 1.5 0 0 0-1.5 1.5z" ${S}/>`;

const ICONS = {
  "mail": envelope,
  "mail-new": envelope + plus(15.5, 14.5),
  "mail-read": `<path d="M2.5 8.5v7a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-7L10 3.5z" ${S}/><path d="M3 9l7 5 7-5" ${S}/>`,
  "mail-unread": envelope + `<circle cx="16" cy="4.5" r="2.6" fill="var(--accent)"/>`,
  "calendar": calendarBase + `<path d="M6 10.5h2M9 10.5h2M12 10.5h2M6 13.5h2M9 13.5h2" ${S}/>`,
  "appointment-new": calendarBase + plus(15, 14.5),
  "meeting-new": calendarBase + `<circle cx="8" cy="11.5" r="1.6" ${S}/><path d="M5.3 15.5a2.8 2.8 0 0 1 5.4 0" ${S}/>` + plus(15, 14.5),
  "people": `<circle cx="7.5" cy="7" r="2.8" ${S}/><path d="M2.5 16a5 5 0 0 1 10 0" ${S}/><circle cx="14" cy="8" r="2.2" ${S}/><path d="M13 12.2a4.2 4.2 0 0 1 4.8 3.8" ${S}/>`,
  "person": `<circle cx="10" cy="7" r="3.2" ${S}/><path d="M4 17a6 6 0 0 1 12 0" ${S}/>`,
  "tasks": `<rect x="3" y="3" width="14" height="14" rx="2" ${S}/><path d="M6.5 10l2.3 2.3 4.7-4.8" ${S}/>`,
  "delete": `<path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M5 5.5l.8 10.6A1.5 1.5 0 0 0 7.3 17.5h5.4a1.5 1.5 0 0 0 1.5-1.4L15 5.5M8.5 8.5v6M11.5 8.5v6" ${S}/>`,
  "archive": `<rect x="2.5" y="3.5" width="15" height="4" rx="1" ${S}/><path d="M3.8 7.5V15a1.5 1.5 0 0 0 1.5 1.5h9.4a1.5 1.5 0 0 0 1.5-1.5V7.5M8 10.5h4" ${S}/>`,
  "junk": `<circle cx="10" cy="10" r="7" ${S}/><path d="M5 5l10 10" ${S}/>`,
  "reply": `<path d="M8 4.5L3 9.5l5 5" ${S}/><path d="M3.5 9.5H12a5 5 0 0 1 5 5v1" ${S}/>`,
  "reply-all": `<path d="M9 4.5l-5 5 5 5M5.5 4.5l-5 5 5 5" ${S}/><path d="M4.5 9.5H12a5 5 0 0 1 5 5v1" ${S}/>`,
  "forward": `<path d="M12 4.5l5 5-5 5" ${S}/><path d="M16.5 9.5H8a5 5 0 0 0-5 5v1" ${S}/>`,
  "move": folderBase + `<path d="M8 11.5h5.5M11.5 9.5l2 2-2 2" ${A}/>`,
  "flag": `<path d="M5 17.5V3M5 3.5h9.5l-2 3.5 2 3.5H5" ${S}/>`,
  "flag-filled": `<path d="M5 17.5V3" ${S}/><path d="M5 3.5h9.5l-2 3.5 2 3.5H5z" fill="#d13438" stroke="#d13438" stroke-width="1.3" stroke-linejoin="round"/>`,
  "flag-done": `<path d="M5 17.5V3M5 3.5h9.5l-2 3.5 2 3.5H5" ${S}/><path d="M11 13.5l2 2 3.5-4" stroke="#107c10" stroke-width="1.4" fill="none" stroke-linecap="round"/>`,
  "search": `<circle cx="8.5" cy="8.5" r="5" ${S}/><path d="M12.2 12.2L17 17" ${S}/>`,
  "sync": `<path d="M16 7.5A6.5 6.5 0 0 0 4.4 6M4 12.5A6.5 6.5 0 0 0 15.6 14" ${S}/><path d="M16.5 3.5v4h-4M3.5 16.5v-4h4" ${S}/>`,
  "offline": `<path d="M3 3l14 14M6.5 13.5a5 5 0 0 1 4.6-1.4M3.5 9.8a9 9 0 0 1 4-2.3M12 7.3a9 9 0 0 1 4.5 2.5" ${S}/><circle cx="10" cy="16" r="1" fill="currentColor"/>`,
  "attach": `<path d="M15.5 9.5l-5.8 5.8a3.5 3.5 0 0 1-5-5l6.3-6.3a2.3 2.3 0 0 1 3.3 3.3l-6.1 6.1a1.2 1.2 0 0 1-1.7-1.7L12 6" ${S}/>`,
  "folder": folderBase,
  "folder-open": `<path d="M2.5 15V5.5A1.5 1.5 0 0 1 4 4h4l1.5 2H15a1.5 1.5 0 0 1 1.5 1.5V9" ${S}/><path d="M2.5 15l2.3-5.3A1.5 1.5 0 0 1 6.2 8.8h11.3l-2.6 6.6a1.5 1.5 0 0 1-1.4.9H3.8" ${S}/>`,
  "inbox": `<path d="M2.5 11l2.3-6.5A1.5 1.5 0 0 1 6.2 3.5h7.6a1.5 1.5 0 0 1 1.4 1L17.5 11v4a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 15z" ${S}/><path d="M2.5 11h4l1 2h5l1-2h4" ${S}/>`,
  "drafts": `<path d="M12.5 3.5l4 4-8.5 8.5H4v-4z" ${S}/><path d="M10.5 5.5l4 4" ${S}/>`,
  "sent": `<path d="M3 10L17 3l-4 14-3.3-5.7z" ${S}/><path d="M9.7 11.3L17 3" ${S}/>`,
  "outbox": `<path d="M2.5 11v4a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-4" ${S}/><path d="M10 12V3M6.5 6.5L10 3l3.5 3.5" ${S}/>`,
  "templates": `<rect x="3.5" y="2.5" width="13" height="15" rx="1.5" ${S}/><path d="M6.5 6.5h7M6.5 9.5h7M6.5 12.5h4" ${S}/>`,
  "chevron-down": `<path d="M5.5 8l4.5 4.5L14.5 8" ${S}/>`,
  "chevron-right": `<path d="M8 5.5l4.5 4.5L8 14.5" ${S}/>`,
  "chevron-left": `<path d="M12 5.5L7.5 10l4.5 4.5" ${S}/>`,
  "chevron-up": `<path d="M5.5 12L10 7.5l4.5 4.5" ${S}/>`,
  "today": calendarBase + `<rect x="8" y="10" width="4" height="4" rx=".5" fill="var(--accent)"/>`,
  "view-day": `<rect x="3" y="3" width="14" height="14" rx="1.5" ${S}/><path d="M3 7h14" ${S}/><rect x="6" y="9" width="8" height="5.5" rx=".8" fill="var(--accent)"/>`,
  "view-workweek": `<rect x="2.5" y="3" width="15" height="14" rx="1.5" ${S}/><path d="M2.5 7h15M5.5 7v10M8.5 7v10M11.5 7v10M14.5 7v10" ${S}/>`,
  "view-week": `<rect x="2.5" y="3" width="15" height="14" rx="1.5" ${S}/><path d="M2.5 7h15M4.6 7v10M6.7 7v10M8.9 7v10M11.1 7v10M13.3 7v10M15.4 7v10" ${S}/>`,
  "view-month": `<rect x="2.5" y="3" width="15" height="14" rx="1.5" ${S}/><path d="M2.5 7h15M2.5 10.3h15M2.5 13.6h15M6.3 7v10M10 7v10M13.7 7v10" ${S}/>`,
  "accept": `<path d="M4 10.5l4 4 8-9" fill="none" stroke="#107c10" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  "tentative": `<path d="M7 7.5a3 3 0 1 1 4.2 2.7c-.8.4-1.2 1-1.2 1.8v.5" fill="none" stroke="#8a6d00" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="15.5" r="1" fill="#8a6d00"/>`,
  "decline": `<path d="M5 5l10 10M15 5L5 15" fill="none" stroke="#c50f1f" stroke-width="1.8" stroke-linecap="round"/>`,
  "picture": `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5" ${S}/><circle cx="7" cy="8" r="1.5" ${S}/><path d="M3 15l4.5-4.5 3 3 2-2 4.5 4" ${S}/>`,
  "settings": `<circle cx="10" cy="10" r="2.5" ${S}/><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" ${S}/>`,
  "account-add": `<circle cx="8" cy="7" r="3" ${S}/><path d="M2.5 16.5a5.5 5.5 0 0 1 9-4.2" ${S}/>` + plus(15, 14),
  "address-book": `<rect x="4" y="2.5" width="12" height="15" rx="1.5" ${S}/><circle cx="10" cy="8" r="2.2" ${S}/><path d="M6.8 13.8a3.4 3.4 0 0 1 6.4 0M2.5 6h2.5M2.5 10h2.5M2.5 14h2.5" ${S}/>`,
  "filter": `<path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" ${S}/>`,
  "print": `<path d="M5.5 7.5v-4h9v4" ${S}/><rect x="2.5" y="7.5" width="15" height="6.5" rx="1.2" ${S}/><path d="M5.5 12h9v5h-9z" ${S}/>`,
  // Quick Steps (a lightning bolt), a new one; Clean Up; Ignore; conversations
  "quick-step": `<path d="M11.5 2.5L5 11h4.5l-1 6.5L15 9h-4.5z" fill="none" stroke="var(--accent)" stroke-width="1.3" stroke-linejoin="round"/>`,
  "quick-new": `<path d="M10.5 2.5L4.5 10.5h4l-1 6" ${S}/><path d="M12 5.5L10 8.5" ${S}/>` + plus(14.5, 13.5),
  "clean-up": `<path d="M12.5 2.5l-4 7M6 9.5l5 2.6-2.4 5.4H3.5L6 9.5zM5.5 17.5l1.5-3M8 17.5l1.6-3.6" ${S}/><path d="M14.5 12.5h3M16 11v3M15 4.5h2" ${A}/>`,
  "ignore": envelope + `<circle cx="15" cy="14.5" r="3.6" fill="var(--bg, #fff)" stroke="#c50f1f" stroke-width="1.3"/><path d="M12.5 17l5-5" stroke="#c50f1f" stroke-width="1.3"/>`,
  "conversation": `<path d="M3 4.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H8l-3 2.5V11.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" ${S}/><path d="M15.5 8h1.5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1v2l-2.5-2H9.5a1 1 0 0 1-1-1V13.5" ${A}/>`,
  // Automatic Replies (an envelope with a return arrow), the Scheduling
  // Assistant (a time grid), a shared calendar (two people's), a new task
  "out-of-office": envelope + `<circle cx="15" cy="14.5" r="3.6" fill="var(--accent)"/><path d="M16.5 15.8v-1a1.3 1.3 0 0 0-1.3-1.3h-2.3m1-1l-1 1 1 1" stroke="#fff" stroke-width="1.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  "scheduling": `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5" ${S}/><path d="M2.5 7.5h15M7 3.5v13M12 3.5v13" ${S}/><rect x="7.6" y="9" width="8.8" height="2.6" rx=".6" fill="var(--accent)"/>`,
  "shared-calendar": calendarBase + `<circle cx="7.5" cy="11.5" r="1.5" ${S}/><path d="M5 15.5a2.6 2.6 0 0 1 5 0" ${S}/><circle cx="13" cy="11.5" r="1.5" ${A}/><path d="M10.6 15.5a2.6 2.6 0 0 1 4.8 0" ${A}/>`,
  "task-new": `<rect x="3" y="3" width="12" height="12" rx="2" ${S}/><path d="M6 9l2 2 4-4.2" ${S}/>` + plus(15, 15),
  "close": `<path d="M5 5l10 10M15 5L5 15" ${S}/>`,
  "save": `<path d="M4 3.5h9.5l3 3V15a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 15V5A1.5 1.5 0 0 1 5 3.5z" ${S}/><path d="M6.5 3.5v4h6v-4M6.5 16.5v-5h7v5" ${S}/>`,
  "send": `<path d="M3 10L17 3l-4 14-3.3-5.7z" ${S}/><path d="M9.7 11.3L17 3" ${A}/>`,
  "bold": `<path d="M6 3.5h5a3 3 0 0 1 0 6H6zM6 9.5h6a3.5 3.5 0 0 1 0 7H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
  "italic": `<path d="M8.5 3.5h6M5.5 16.5h6M11.5 3.5l-3 13" ${S}/>`,
  "underline": `<path d="M6 3.5v6a4 4 0 0 0 8 0v-6M4.5 17h11" ${S}/>`,
  "bullets": `<circle cx="4.5" cy="5.5" r="1.2" fill="currentColor"/><circle cx="4.5" cy="10" r="1.2" fill="currentColor"/><circle cx="4.5" cy="14.5" r="1.2" fill="currentColor"/><path d="M8 5.5h9M8 10h9M8 14.5h9" ${S}/>`,
  "numbering": `<path d="M3.5 4.5l1-1v4M3 13a1.3 1.3 0 0 1 2.4.6c0 .9-2.4 1.9-2.4 2.9h2.6M8 5.5h9M8 10h9M8 14.5h9" ${S}/>`,
  "align-left": `<path d="M3 4.5h14M3 8.5h9M3 12.5h14M3 16.5h9" ${S}/>`,
  "align-center": `<path d="M3 4.5h14M5.5 8.5h9M3 12.5h14M5.5 16.5h9" ${S}/>`,
  "align-right": `<path d="M3 4.5h14M8 8.5h9M3 12.5h14M8 16.5h9" ${S}/>`,
  "link": `<path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.8-2.8a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.8 2.8a3 3 0 0 0 4.2 4.2l1-1" ${S}/>`,
  "signature": `<path d="M2.5 15.5c2-3 3.5-8 5.5-8s-1 7 1 7 2.5-3 4-3 1 2 3 2" ${S}/><path d="M2.5 17.5h15" ${S}/>`,
  "importance-high": `<path d="M10 3v9" fill="none" stroke="#c50f1f" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="16" r="1.3" fill="#c50f1f"/>`,
  "importance-low": `<path d="M10 4v11M6 11l4 4 4-4" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  "more": `<circle cx="5" cy="10" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/><circle cx="15" cy="10" r="1.2" fill="currentColor"/>`,
  "repeat": `<path d="M4 9V8a3 3 0 0 1 3-3h9M13.5 2.5L16 5l-2.5 2.5M16 11v1a3 3 0 0 1-3 3H4M6.5 17.5L4 15l2.5-2.5" ${S}/>`,
  "bell": `<path d="M5.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5l1.5 2H4zM8.3 17a1.8 1.8 0 0 0 3.4 0" ${S}/>`,
  "location": `<path d="M10 17.5s-5.5-5.3-5.5-9a5.5 5.5 0 0 1 11 0c0 3.7-5.5 9-5.5 9z" ${S}/><circle cx="10" cy="8.5" r="2" ${S}/>`,
  "clock": `<circle cx="10" cy="10" r="7" ${S}/><path d="M10 6v4l2.5 2" ${S}/>`,
  "import": `<path d="M10 3v9M6.5 8.5L10 12l3.5-3.5M3.5 13v2.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V13" ${S}/>`,
  "export": `<path d="M10 12V3M6.5 6.5L10 3l3.5 3.5M3.5 13v2.5A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5V13" ${S}/>`,
  "info": `<circle cx="10" cy="10" r="7" ${S}/><path d="M10 9v5" ${S}/><circle cx="10" cy="6.3" r=".9" fill="currentColor"/>`,
  "sun": `<circle cx="10" cy="10" r="3.2" ${S}/><path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7L6 6M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3" ${S}/>`,
  "moon": `<path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" ${S}/>`,
  "expand": `<path d="M12 3.5h4.5V8M8 16.5H3.5V12M16.5 3.5l-5 5M3.5 16.5l5-5" ${S}/>`,
  "reading-right": `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5" ${S}/><path d="M8.5 3.5v13M4.5 7h2.5M4.5 10h2.5M4.5 13h2.5" ${S}/><rect x="10" y="6" width="6" height="8.5" rx=".6" fill="var(--accent)" opacity=".85"/>`,
  "reading-bottom": `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5" ${S}/><path d="M2.5 9.5h15M5 6h10M5 8h7" ${S}/><rect x="4.5" y="11" width="11" height="4" rx=".6" fill="var(--accent)" opacity=".85"/>`,
  "reading-off": `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5" ${S}/><path d="M5 7h10M5 10h10M5 13h10" ${S}/>`,
  "focused": `<circle cx="10" cy="10" r="6.5" ${S}/><circle cx="10" cy="10" r="2.5" fill="var(--accent)"/>`,
  "rules": `<path d="M3 4h14l-5.5 6.5V16l-3-1.5v-4z" ${S}/><path d="M13.5 13.5h4M15.5 11.5l2 2-2 2" ${A}/>`,
  "category": `<rect x="3" y="3" width="6" height="6" rx="1" fill="#d13438"/><rect x="11" y="3" width="6" height="6" rx="1" fill="#0f6cbd"/><rect x="3" y="11" width="6" height="6" rx="1" fill="#107c10"/><rect x="11" y="11" width="6" height="6" rx="1" fill="#e8a317"/>`,
  "search-folder": folderBase + `<circle cx="10" cy="11" r="2.4" ${A}/><path d="M11.8 12.8l2 2" ${A}/>`,
  "group": `<circle cx="7" cy="7.5" r="2.5" ${S}/><circle cx="13" cy="7.5" r="2.5" ${S}/><path d="M2.5 16a4.5 4.5 0 0 1 9 0M8.5 16a4.5 4.5 0 0 1 9 0" ${S}/>`,
  "person-add": `<circle cx="8" cy="7" r="3" ${S}/><path d="M2.5 16.5a5.5 5.5 0 0 1 9-4.2" ${S}/>` + plus(15, 14),
  "group-add": `<circle cx="6.5" cy="7.5" r="2.4" ${S}/><circle cx="11.5" cy="7.5" r="2.4" ${S}/><path d="M2 15.5a4.5 4.5 0 0 1 8.5-2" ${S}/>` + plus(15, 14),
  "edit": `<path d="M12.5 3.5l4 4-8.5 8.5H4v-4z" ${S}/>`,
  "phone": `<path d="M5 3h3l1.5 3.5-2 1.5a9 9 0 0 0 4.5 4.5l1.5-2L17 12v3a2 2 0 0 1-2 2A13 13 0 0 1 3 5a2 2 0 0 1 2-2z" ${S}/>`,
  "star": `<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" ${S}/>`,
  "star-filled": `<path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" fill="#e8a317" stroke="#e8a317" stroke-width="1.2" stroke-linejoin="round"/>`,
};

export function icon(name, size = 20, cls = "") {
  const body = ICONS[name] || ICONS["more"];
  return `<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;
}

export function hasIcon(name) {
  return name in ICONS;
}
