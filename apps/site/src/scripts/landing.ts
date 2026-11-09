// Interactions for the landing page. Every animation shows something the product actually does,
// and all of them settle into their final state immediately when reduced motion is requested.
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const root = document.documentElement;
const wait = (ms: number) => new Promise((r) => setTimeout(r, reduced ? 0 : ms));

function setTheme(theme: "dark" | "light") {
  root.dataset.theme = theme;
  try {
    localStorage.setItem("starlight-theme", theme);
  } catch {}
}
document.getElementById("theme-toggle")?.addEventListener("click", () => setTheme(root.dataset.theme === "dark" ? "light" : "dark"));

/** Arrow-key navigation for a row of tabs or radios; `select` does the rest. */
function roving(items: HTMLElement[], select: (el: HTMLElement) => void) {
  items.forEach((el, i) => {
    el.addEventListener("click", () => select(el));
    el.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = items[(i + d + items.length) % items.length];
      select(next);
      next.focus();
    });
  });
}

/** Run `fn` once the element scrolls into view. */
function onVisible(el: Element, fn: () => void) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { threshold: 0.35 });
  io.observe(el);
}

// ---- terminals --------------------------------------------------------------
for (const term of document.querySelectorAll<HTMLElement>("[data-term]")) {
  const full = term.dataset.term === "full";
  const tabs = [...term.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const typedOnce = new Set<string>();

  async function play(panel: HTMLElement) {
    const os = panel.dataset.panel!;
    const typed = panel.querySelector<HTMLElement>(".term-typed")!;
    const lines = [...panel.querySelectorAll<HTMLElement>(".term-out .term-line")];
    if (!full || reduced || typedOnce.has(os)) {
      typed.textContent = typed.dataset.command!;
      lines.forEach((l) => l.classList.add("is-in"));
      panel.classList.add("is-done");
      return;
    }
    typedOnce.add(os);
    panel.classList.remove("is-done");
    lines.forEach((l) => l.classList.remove("is-in"));
    const cmd = typed.dataset.command!;
    panel.classList.add("is-typing");
    for (let i = 0; i <= cmd.length; i += 2) {
      typed.textContent = cmd.slice(0, i);
      await wait(16);
    }
    typed.textContent = cmd;
    panel.classList.remove("is-typing");
    await wait(260);
    for (const l of lines) {
      l.classList.add("is-in");
      await wait(l.classList.contains("term-ok") ? 420 : 170);
    }
    panel.classList.add("is-done");
  }

  const select = (tab: HTMLElement) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = term.querySelector<HTMLElement>(`#${t.getAttribute("aria-controls")}`)!;
      panel.hidden = !on;
      if (on) void play(panel);
    }
  };
  roving(tabs, select);

  // Start with the visitor's own system.
  const preferred = /Windows/i.test(navigator.userAgent) ? tabs.find((t) => t.dataset.os === "windows") : undefined;
  const first = preferred ?? tabs[0];
  if (full) {
    // Blank the command first so the page doesn't flash the full text before typing.
    if (!reduced) term.querySelectorAll<HTMLElement>(".term-typed").forEach((t) => (t.textContent = ""));
    select(first);
  } else if (preferred) select(preferred);

  for (const btn of term.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
    const label = btn.querySelector<HTMLElement>(".term-copy-label")!;
    const idleLabel = label.textContent;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy ?? "");
        btn.classList.add("is-copied");
        label.textContent = "Copied";
        setTimeout(() => {
          btn.classList.remove("is-copied");
          label.textContent = idleLabel;
        }, 1600);
      } catch {}
    });
  }
}

// ---- server software picker --------------------------------------------------
const typesEl = document.querySelector<HTMLElement>("[data-types]");
if (typesEl) {
  const radios = [...typesEl.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const preview = typesEl.querySelector<HTMLElement>(".preview")!;
  roving(radios, (el) => {
    const t = JSON.parse(el.dataset.type!) as Record<string, string | null>;
    for (const r of radios) {
      const on = r === el;
      r.setAttribute("aria-checked", String(on));
      r.tabIndex = on ? 0 : -1;
    }
    preview.style.setProperty("--type", t.color!);
    preview.classList.remove("is-swap");
    void preview.offsetWidth;
    preview.classList.add("is-swap");
    for (const field of preview.querySelectorAll<HTMLElement>("[data-pv]")) {
      const value = t[field.dataset.pv!];
      field.textContent = value ?? "";
      field.hidden = value === null;
    }
  });
}

// ---- console demo -------------------------------------------------------------
const consoleEl = document.querySelector<HTMLElement>("[data-console]");
if (consoleEl) {
  const lines = [...consoleEl.querySelectorAll<HTMLElement>(".dc-log li")];
  const bars = [...consoleEl.querySelectorAll<HTMLElement>("[data-spark] i")];
  const m = (k: string) => consoleEl.querySelector<HTMLElement>(`[data-m="${k}"]`)!;
  if (reduced) lines.forEach((l) => l.classList.add("is-in"));
  else
    onVisible(consoleEl, async () => {
      for (;;) {
        lines.forEach((l) => l.classList.remove("is-in"));
        let players = 0;
        for (const l of lines) {
          l.classList.add("is-in");
          if (/joined the game/.test(l.textContent ?? "")) m("players").textContent = String(++players);
          await wait(900);
        }
        await wait(4000);
      }
    });
  if (!reduced)
    setInterval(() => {
      bars.forEach((b, i) => b.style.setProperty("--v", bars[i + 1]?.style.getPropertyValue("--v") || `${22 + Math.round(Math.random() * 30)}%`));
      m("cpu").textContent = String(9 + Math.round(Math.random() * 9));
      m("tps").textContent = Math.random() > 0.85 ? "19.9" : "20.0";
    }, 1400);
}

// ---- update demo ---------------------------------------------------------------
const updateEl = document.querySelector<HTMLElement>("[data-update]");
if (updateEl) {
  const steps = [...updateEl.querySelectorAll<HTMLElement>("[data-step]")];
  const result = updateEl.querySelector<HTMLElement>("[data-result]")!;
  const buttons = [...updateEl.querySelectorAll<HTMLButtonElement>("[data-run]")];
  const panelStatus = updateEl.querySelector<HTMLElement>("[data-panel-status]")!;
  const panelVersion = updateEl.querySelector<HTMLElement>("[data-panel-version]")!;
  let running = false;
  async function run(fail: boolean) {
    if (running) return;
    running = true;
    buttons.forEach((b) => (b.disabled = true));
    updateEl!.classList.toggle("is-fail", fail);
    updateEl!.dataset.panelState = "updating";
    panelStatus.textContent = "Updating";
    panelVersion.textContent = "v1.0.0";
    steps.forEach((s) => (s.dataset.state = ""));
    result.textContent = "Dashboard updating. Minecraft stays online.";
    for (const s of steps.slice(0, 4)) {
      s.dataset.state = "run";
      await wait(650);
      s.dataset.state = fail && s.dataset.step === "3" ? "fail" : "ok";
      if (s.dataset.step === "3") {
        updateEl!.dataset.panelState = fail ? "failed" : "updating";
        panelStatus.textContent = fail ? "Start failed" : "Reconnecting";
        if (!fail) await wait(450);
      }
    }
    if (fail) {
      const rb = steps[4];
      rb.dataset.state = "run";
      await wait(800);
      rb.dataset.state = "ok";
      result.textContent = "v1.0.1 did not start. v1.0.0 and its database are restored. All 6 players stayed online.";
    } else {
      panelVersion.textContent = "v1.0.1";
      result.textContent = "Connected to v1.0.1. All 6 players stayed online.";
    }
    updateEl!.dataset.panelState = "connected";
    panelStatus.textContent = "Connected";
    buttons.forEach((b) => (b.disabled = false));
    running = false;
  }
  buttons.forEach((b) => b.addEventListener("click", () => void run(b.dataset.run === "fail")));
}

// ---- backup demo ---------------------------------------------------------------
const backupEl = document.querySelector<HTMLElement>("[data-backup]");
if (backupEl) {
  const btn = backupEl.querySelector<HTMLButtonElement>("[data-restore]")!;
  const list = backupEl.querySelector<HTMLElement>("[data-steps]")!;
  btn.addEventListener("click", async () => {
    const chosen = backupEl.querySelector<HTMLInputElement>("input[name=backup]:checked")?.value ?? "the backup";
    btn.disabled = true;
    list.innerHTML = "";
    for (const text of ["Safety backup of the current state", "Verifying archive", `Restored ${chosen} · server starting`]) {
      const li = document.createElement("li");
      li.textContent = text;
      li.dataset.state = "run";
      list.append(li);
      await wait(700);
      li.dataset.state = "ok";
    }
    btn.textContent = "Restore again";
    btn.disabled = false;
  });
}

// ---- closer look ---------------------------------------------------------------
const lookTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-look-tabs] [role=tab]")];
roving(lookTabs, (tab) => {
  for (const t of lookTabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
    const id = t.getAttribute("aria-controls")!;
    const panel = document.getElementById(id)!;
    panel.dataset.active = String(on);
    panel.inert = !on;
    const legend = document.querySelector<HTMLElement>(`[data-legend="${id.replace(/^look-/, "")}"]`);
    if (legend) legend.hidden = !on;
  }
});
// Touch: a tap toggles the tooltip; the legend highlights its hotspot on hover.
for (const spot of document.querySelectorAll<HTMLButtonElement>(".spot")) {
  spot.addEventListener("click", () => {
    const open = spot.classList.toggle("is-open");
    document.querySelectorAll(".spot.is-open").forEach((s) => s !== spot && s.classList.remove("is-open"));
    if (!open) spot.blur();
  });
}
for (const item of document.querySelectorAll<HTMLElement>("[data-spot-ref]")) {
  const spot = document.querySelector<HTMLElement>(`[data-spot="${item.dataset.spotRef}"]`);
  item.addEventListener("mouseenter", () => spot?.classList.add("is-hint"));
  item.addEventListener("mouseleave", () => spot?.classList.remove("is-hint"));
}

// ---- footer console --------------------------------------------------------------
const fc = document.querySelector<HTMLFormElement>("[data-foot-console]");
if (fc) {
  const out = fc.querySelector<HTMLElement>("[data-fc-out]")!;
  const input = fc.querySelector<HTMLInputElement>("input")!;
  const say = (text: string, cls = "") => {
    const li = document.createElement("li");
    li.textContent = text;
    if (cls) li.className = cls;
    out.append(li);
    while (out.children.length > 4) out.firstElementChild?.remove();
  };
  const commands: Record<string, () => string> = {
    help: () => "Try: /time set day, /time set night, /tps, /seed, /op you, /stop, /craftpanel",
    "/help": () => commands.help(),
    "/time set day": () => (setTheme("light"), "Set the time to 1000. Light mode on."),
    "/time set night": () => (setTheme("dark"), "Set the time to 13000. Dark mode on."),
    "/tps": () => "TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0",
    "/seed": () => "Seed: [-1000123]. No, it's not a good one.",
    "/stop": () => "Stopping the server… just kidding. This is a website.",
    "/gamemode creative": () => "You're already creative. You read the footer.",
    "/craftpanel": () => `CraftPanel ${document.querySelector(".hero-kicker a")?.textContent ?? ""} · craftpanel.vctr.site · type help for more`,
  };
  fc.addEventListener("submit", (e) => {
    e.preventDefault();
    const raw = input.value.trim().replace(/\s+/g, " ");
    if (!raw) return;
    say(`> ${raw}`, "fc-cmd");
    const key = raw.toLowerCase();
    const reply = commands[key]?.() ?? (key.startsWith("/op ") ? `Nice try. Opping ${raw.slice(4)} needs an Administrator.` : `Unknown or incomplete command: ${raw}. Type help.`);
    say(reply);
    input.value = "";
  });
}
