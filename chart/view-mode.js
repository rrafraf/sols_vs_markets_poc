"use strict";

const MODES = {
  watch: {
    title: "PRICE WATCH",
    status: "chart + indicators"
  },
  arena: {
    title: "GRIND ARENA",
    status: "story + replay"
  },
  evidence: {
    title: "TRACE EVIDENCE",
    status: "raw event log"
  }
};

export function createViewMode({ $ }) {
  let active = document.body.dataset.mode || "arena";
  let theme = document.body.dataset.theme || "light";

  function bind() {
    for (const button of document.querySelectorAll("[data-mode-button]")) {
      button.addEventListener("click", () => setMode(button.dataset.modeButton));
    }
    $("theme-toggle")?.addEventListener("click", () => setTheme(theme === "light" ? "dark" : "light"));
    setMode(active);
    setTheme(theme);
  }

  function setMode(mode) {
    active = MODES[mode] ? mode : "arena";
    document.body.dataset.mode = active;

    const header = MODES[active];
    const title = $("app-title");
    const status = $("mode-status");
    if (title) title.textContent = header.title;
    if (status) status.textContent = header.status;

    for (const button of document.querySelectorAll("[data-mode-button]")) {
      const selected = button.dataset.modeButton === active;
      button.setAttribute("aria-pressed", selected ? "true" : "false");
    }
  }

  function setTheme(nextTheme) {
    theme = nextTheme === "dark" ? "dark" : "light";
    document.body.dataset.theme = theme;

    const button = $("theme-toggle");
    if (button) {
      button.textContent = theme === "light" ? "lights off" : "lights on";
      button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    }

    window.dispatchEvent(new CustomEvent("themechange", { detail: { theme } }));
  }

  return { bind, setMode, setTheme };
}
