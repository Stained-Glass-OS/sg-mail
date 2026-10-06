/*
 * SG Mail -- the ribbon: tabs, each with groups of large and small buttons,
 * as Outlook's classic ribbon.
 *
 * definition: { file: action, tabs: [{ id, label, groups: [{ label, items: [
 *   { id, icon, label, large: true, action, menu: () => items, title },
 *   { col: [ small items ] } ] }] }] }
 *
 * Copyright (C) 2026 Stained Glass OS contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { icon } from "./icons.js";
import { h, showMenu, esc } from "./util.js";

export class Ribbon {
  constructor(container, def) {
    this.container = container;
    this.buttons = new Map();
    this.def = def;
    this.render();
  }

  render() {
    const tabs = h("div", { class: "ribbon-tabs", role: "tablist" });
    if (this.def.file) {
      tabs.append(h("button", { class: "ribbon-tab file", id: "rt-file", text: "File", onclick: e => this.def.file(e.currentTarget) }));
    }
    this.body = h("div", { class: "ribbon-body" });
    for (const tab of this.def.tabs) {
      const btn = h("button", { class: "ribbon-tab", role: "tab", "data-tab": tab.id, text: tab.label, onclick: () => this.select(tab.id) });
      tabs.append(btn);
    }
    tabs.append(h("div", { class: "spacer" }));
    if (this.def.extra) tabs.append(this.def.extra);
    this.container.replaceChildren(tabs, this.body);
    this.tabsEl = tabs;
    this.select(this.def.tabs[0].id);
  }

  select(id) {
    this.current = id;
    for (const b of this.tabsEl.querySelectorAll(".ribbon-tab[data-tab]")) b.classList.toggle("active", b.dataset.tab === id);
    const tab = this.def.tabs.find(t => t.id === id);
    this.body.replaceChildren();
    for (const g of tab.groups) {
      const items = h("div", { class: "ribbon-group-items" });
      for (const it of g.items) items.append(it.col ? h("div", { class: "ribbon-col" }, it.col.map(c => this.button(c))) : this.button(it));
      this.body.append(h("div", { class: "ribbon-group", "data-group": g.label }, items, h("div", { class: "ribbon-group-label", text: g.label })));
    }
    // the state of buttons that are shown again
    for (const [bid, st] of this.state || []) this.apply(bid, st);
  }

  button(it) {
    const label = h("span", { class: "rb-label", text: it.label });
    const b = h("button", {
      class: "rb" + (it.large ? " large" : "") + (it.menu ? " has-menu" : ""),
      id: "rb-" + it.id,
      title: it.title || it.label + (it.shortcut ? ` (${it.shortcut})` : ""),
      "data-id": it.id,
      html: icon(it.icon, it.large ? 32 : 16),
    });
    b.append(label);
    if (it.menu) (it.large ? label : b).insertAdjacentHTML("beforeend", ` <span class="caret">${icon("chevron-down", 10)}</span>`);
    b.addEventListener("click", e => {
      if (it.menu && (!it.action || e.target.closest(".caret"))) showMenu(it.menu(), b);
      else it.action && it.action(b);
    });
    this.buttons.set(it.id, b);
    return b;
  }

  apply(id, st) {
    const b = this.body.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!b) return;
    if ("enabled" in st) b.disabled = !st.enabled;
    if ("toggled" in st) b.classList.toggle("toggled", st.toggled);
    if ("label" in st) b.querySelector(".rb-label").firstChild.textContent = st.label;
    if ("icon" in st) {
      const svg = b.querySelector(":scope > svg.icon");
      if (svg) svg.outerHTML = icon(st.icon, b.classList.contains("large") ? 32 : 16);
    }
  }

  set(id, st) {
    this.state = this.state || new Map();
    this.state.set(id, Object.assign(this.state.get(id) || {}, st));
    this.apply(id, st);
  }

  enable(id, on) {
    this.set(id, { enabled: !!on });
  }

  toggle(id, on) {
    this.set(id, { toggled: !!on });
  }
}

export function tellMeBox(onSearch) {
  const box = h("label", { class: "tell", html: `${icon("search", 14)}` });
  const input = h("input", { type: "text", placeholder: "Tell me what you want to do", style: "border:0;background:transparent;width:200px;padding:2px", "aria-label": "Tell me what you want to do" });
  input.addEventListener("keydown", e => {
    if (e.key === "Enter" && input.value.trim()) {
      onSearch(input.value.trim(), input);
    }
  });
  box.append(input);
  return box;
}

export { esc };
