/*
 * SG Mail -- a message's HTML made safe to show: no scripts, no frames,
 * forms or plugins, no handlers, no javascript: links, and nothing fetched
 * from the network until the reader asks for the pictures ("Download
 * pictures"). The reading pane shows the result in a sandboxed frame that
 * may not run scripts, under a content security policy that only lets
 * pictures load from where this allowed.
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const DROP = "script, noscript, iframe, frame, frameset, object, embed, applet, base, link, meta, portal, template, svg script, math, form[action] button[type=submit]";
const URL_ATTRS = ["src", "href", "background", "poster", "action", "formaction", "xlink:href", "cite", "longdesc", "lowsrc", "dynsrc", "data"];
const REMOTE = /^\s*(https?:|ftp:|\/\/)/i;

export const BLANK_IMG = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function cleanCss(css, allowRemote, found) {
  // @import pulls in more from elsewhere; url(...) to the network waits
  let out = css.replace(/@import[^;]*;?/gi, () => {
    found.remote = true;
    return "";
  });
  out = out.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => {
    if (/^\s*(javascript|vbscript):/i.test(u)) return "none";
    if (REMOTE.test(u)) {
      found.remote = true;
      return allowRemote ? m : "none";
    }
    return m;
  });
  out = out.replace(/expression\s*\(/gi, "(").replace(/-moz-binding\s*:/gi, "x:").replace(/behavior\s*:/gi, "x:");
  return out;
}

/**
 * html: the message's HTML; cid: a Map content-id -> data: URL (its
 * inline pictures); allowRemote: pictures from the network may load.
 * Returns {html, remote}: remote says whether anything was held back.
 */
export function sanitize(html, { cid = new Map(), allowRemote = false } = {}) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const found = { remote: false };
  for (const el of doc.querySelectorAll(DROP)) el.remove();
  // forms cannot post anywhere: their controls stay, inert
  for (const f of doc.querySelectorAll("form")) {
    const div = doc.createElement("div");
    div.append(...f.childNodes);
    f.replaceWith(div);
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on") || name === "formaction" || name === "action" || name === "srcdoc" || name === "ping") {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === "style") {
        el.setAttribute("style", cleanCss(value, allowRemote, found));
        continue;
      }
      if (name === "srcset") {
        if (REMOTE.test(value) || /,\s*(https?:|\/\/)/i.test(value)) found.remote = true;
        el.removeAttribute(attr.name);
        continue;
      }
      if (URL_ATTRS.includes(name)) {
        if (/^\s*(javascript|vbscript|data:text\/html|file):/i.test(value)) {
          el.removeAttribute(attr.name);
          continue;
        }
        const tag = el.localName;
        if (name === "href" && (tag === "a" || tag === "area")) continue;     // links open in the browser when clicked
        if (/^\s*cid:/i.test(value)) {
          const id = decodeURIComponent(value.trim().slice(4)).replace(/^<|>$/g, "").toLowerCase();
          if (cid.has(id)) el.setAttribute(attr.name, cid.get(id));
          else el.setAttribute(attr.name, BLANK_IMG);
          continue;
        }
        if (REMOTE.test(value)) {
          found.remote = true;
          if (!allowRemote) {
            el.setAttribute("data-sg-" + name, value);
            if (name === "src" && tag === "img") el.setAttribute("src", BLANK_IMG);
            else el.removeAttribute(attr.name);
          }
        }
      }
    }
  }
  for (const st of doc.querySelectorAll("style")) st.textContent = cleanCss(st.textContent, allowRemote, found);
  for (const a of doc.querySelectorAll("a[href]")) {
    a.setAttribute("rel", "noopener noreferrer");
    a.setAttribute("target", "_blank");
  }
  return { html: doc.body ? doc.body.innerHTML : "", head: [...doc.querySelectorAll("head style")].map(s => s.outerHTML).join(""), remote: found.remote };
}

/**
 * The document the reading pane's frame shows: the sanitised body under a
 * policy that blocks everything but inline styles and the pictures allowed.
 */
export function frameDocument(clean, { allowRemote = false, dark = false, plain = false } = {}) {
  const img = allowRemote ? "data: blob: https: http:" : "data: blob:";
  const csp = `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; img-src ${img}; media-src 'none'; style-src 'unsafe-inline'; font-src data:`;
  const base = `
    html { color-scheme: ${dark && plain ? "dark" : "light"}; }
    body { margin: 0; padding: 4px 2px 24px; font: 14px/1.45 "Inter", "Segoe UI", "Noto Sans", "DejaVu Sans", sans-serif;
           color: ${dark && plain ? "#f3f2f1" : "#201f1e"}; background: ${dark && plain ? "#292929" : "#ffffff"}; overflow-wrap: anywhere; }
    pre.plain { white-space: pre-wrap; font: 14px/1.45 "Inter", "Segoe UI", "Noto Sans", "DejaVu Sans", sans-serif; margin: 0; }
    blockquote.q { margin: 0 0 0 2px; padding-left: 10px; border-left: 2px solid ${dark && plain ? "#605e5c" : "#c8c6c4"}; color: ${dark && plain ? "#c8c6c4" : "#605e5c"}; }
    a { color: ${dark && plain ? "#479ef5" : "#0f6cbd"}; }
    img { max-width: 100%; height: auto; }
    img[data-sg-src] { outline: 1px dashed #c8c6c4; min-width: 16px; min-height: 16px; }
    table { max-width: 100%; }
  `;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${base}</style>${clean.head || ""}</head><body>${clean.html}</body></html>`;
}
