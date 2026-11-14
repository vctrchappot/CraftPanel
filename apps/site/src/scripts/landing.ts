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
    const typed = panel.querySelector<HTMLElement>(".term-typed");
    if (!typed) return; // the macOS tab has no command to type
    if (!full || reduced || typedOnce.has(os)) {
      typed.textContent = typed.dataset.command!;
      return;
    }
    typedOnce.add(os);
    const cmd = typed.dataset.command!;
    panel.classList.add("is-typing");
    for (let i = 0; i <= cmd.length; i += 2) {
      typed.textContent = cmd.slice(0, i);
      await wait(16);
    }
    typed.textContent = cmd;
    panel.classList.remove("is-typing");
  }

  /** After the command was copied: what the installer is going to print, once per panel. */
  async function preview(panel: HTMLElement) {
    if (panel.classList.contains("is-ran")) return;
    panel.classList.add("is-ran");
    for (const l of panel.querySelectorAll<HTMLElement>(".term-out .term-line")) {
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
      if (on) {
        void play(panel);
        // Keep the chosen tab in view when the bar is narrower than its tabs.
        const bar = t.parentElement!;
        if (bar.scrollWidth > bar.clientWidth) bar.scrollLeft = Math.max(0, t.offsetLeft - 8);
      }
    }
  };
  roving(tabs, select);

  // Start with the page's platform, or else the visitor's own system.
  const ua = navigator.userAgent;
  const preferredOs = term.dataset.os ?? (/Windows/i.test(ua) ? "windows" : /Macintosh|Mac OS X/i.test(ua) ? "macos" : null);
  const preferred = preferredOs ? tabs.find((t) => t.dataset.os === preferredOs) : undefined;
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
      const panel = btn.closest<HTMLElement>("[data-panel]");
      if (full && panel) void preview(panel);
      try {
        await navigator.clipboard.writeText(btn.dataset.copy ?? "");
        btn.classList.add("is-copied");
        label.textContent = "Copied";
        setTimeout(() => {
          btn.classList.remove("is-copied");
          label.textContent = idleLabel;
        }, 2000);
      } catch {
        // No clipboard access (insecure context, permission denied): select the command so Ctrl+C works.
        const cmd = panel?.querySelector(".term-typed");
        if (cmd) {
          const range = document.createRange();
          range.selectNodeContents(cmd);
          const sel = getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        label.textContent = "Selected, press Ctrl+C";
        setTimeout(() => (label.textContent = idleLabel), 3000);
      }
    });
  }
}

// ---- server software picker --------------------------------------------------
interface SoftwareEntry {
  key: string;
  name: string;
  color: string;
  title: string;
  versions: [string, string][];
  java: string;
  tabs: string[];
  highlightTab: string | null;
  servers: { name: string; status: "on" | "up" | "off" }[];
  players: string;
  middleStat: [string, string];
  memRatio: number;
  sourceIcon: "plug" | "mod" | "cube";
  source: string;
}

const typesEl = document.querySelector<HTMLElement>("[data-types]");
if (typesEl) {
  const softwareMap = JSON.parse(typesEl.dataset.software!) as Record<string, SoftwareEntry>;
  const preview = typesEl.querySelector<HTMLElement>(".preview")!;
  const verSelect = typesEl.querySelector<HTMLSelectElement>("[data-wz-ver]")!;
  const ctaBtn = typesEl.querySelector<HTMLButtonElement>("[data-wz-cta]")!;
  const wzSwName = typesEl.querySelector<HTMLElement>('[data-wz="sw-name"]')!;
  const wzIcons = [...typesEl.querySelectorAll<HTMLElement>("[data-wz-icon]")];
  const sourceIcons = [...typesEl.querySelectorAll<HTMLElement>("[data-source-icon]")];
  const pv = (k: string) => typesEl.querySelector<HTMLElement>(`[data-pv="${k}"]`)!;

  const state = { sw: "paper", ver: 0, mem: 2 };

  function flash(el: HTMLElement) {
    if (reduced) return;
    el.classList.remove("is-swap");
    void el.offsetWidth;
    el.classList.add("is-swap");
  }

  function render(changed: "sw" | "ver" | "mem") {
    const s = softwareMap[state.sw];
    const v = s.versions[state.ver] ?? s.versions[0];
    const usedMem = (state.mem * s.memRatio).toFixed(1);
    const totalMem = state.mem.toFixed(1);

    preview.style.setProperty("--type", s.color);
    wzSwName.textContent = s.name;
    for (const icon of wzIcons) icon.hidden = icon.dataset.wzIcon !== state.sw;
    ctaBtn.textContent = `Create a ${s.name} server`;
    pv("cap").textContent = `${s.name} ${v[0]} selected`;

    if (changed === "sw") {
      verSelect.innerHTML = s.versions.map((ver, i) => `<option value="${i}">${ver[0]}</option>`).join("");
      verSelect.value = String(state.ver);
    }

    pv("title").textContent = s.title;
    pv("name").textContent = s.name;
    pv("meta").textContent = [`${s.name} ${v[0]}`, v[1], s.java].filter(Boolean).join(" · ");

    pv("tabs").innerHTML = s.tabs
      .map((t, i) => `<span class="pv-tab${i === 0 ? " is-on" : ""}${t === s.highlightTab ? " is-new" : ""}">${t}</span>`)
      .join("");

    pv("players").textContent = s.players;
    pv("mid-label").textContent = s.middleStat[0];
    pv("mid-val").textContent = s.middleStat[1];
    pv("mem").innerHTML = `<span>${usedMem} / ${totalMem}</span><small>GB</small>`;

    for (const icon of sourceIcons) icon.hidden = icon.dataset.sourceIcon !== s.sourceIcon;
    pv("addons").textContent = s.source;

    pv("servers").innerHTML = s.servers
      .map((srv) => `<span class="pv-side-item is-${srv.status}"><span class="pv-srv-dot"></span><span>${srv.name}</span></span>`)
      .join("");

    const targets: Record<typeof changed, string[]> = {
      sw: ["name", "meta", "tabs", "stats", "source-wrap", "servers"],
      ver: ["meta"],
      mem: ["stats"],
    };
    targets[changed].forEach((k) => flash(pv(k)));
  }

  typesEl.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement | HTMLSelectElement;
    if (target.name === "sw") {
      state.sw = target.value;
      state.ver = 0;
      render("sw");
    } else if (target === verSelect) {
      state.ver = Number(verSelect.value);
      render("ver");
    } else if (target.name === "wz-mem") {
      state.mem = Number(target.value);
      render("mem");
    }
  });

  ctaBtn.addEventListener("click", () => {
    document.getElementById("install")?.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  });
}

// ---- scene motion ----------------------------------------------------------------
// Looping scenes pause while they are off-screen; tiles and device cards settle in once.
const sceneIo = new IntersectionObserver((entries) => {
  for (const e of entries) (e.target as HTMLElement).toggleAttribute("data-paused", !e.isIntersecting);
});
document.querySelectorAll(".iso, .runtime-figure, .pb").forEach((el) => sceneIo.observe(el));

// Section heads, tiles, cards and rules rise once in reading order (styled under "scroll motion" in landing.css).
if (!reduced) {
  root.classList.add("motion");
  const reveal = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("is-in");
      reveal.unobserve(e.target);
    }
  }, { threshold: 0.15, rootMargin: "0px 0px -6% 0px" });
  const groups: Element[][] = [
    ...[...document.querySelectorAll(".sec-head")].map((h) => [...h.querySelectorAll(".sec-no, h2, .sec-lead, [role=tablist]")]),
    ...[...document.querySelectorAll(".bento, .devices, .compare tbody, .choices, .faq")].map((g) => [...g.children]),
    ...[...document.querySelectorAll(".px-rule")].map((r) => [r]),
  ];
  for (const group of groups)
    group.forEach((el, i) => {
      (el as HTMLElement).dataset.reveal = "";
      (el as HTMLElement).style.setProperty("--i", String(i));
      reveal.observe(el);
    });
}

// ---- faq ---------------------------------------------------------------------------
// A link to #faq-<id> opens that answer.
const openFaq = () => {
  const target = location.hash.startsWith("#faq-") ? document.getElementById(location.hash.slice(1)) : null;
  if (target instanceof HTMLDetailsElement) target.open = true;
};
openFaq();
addEventListener("hashchange", openFaq);

// ---- experience bar ---------------------------------------------------------------
// CSS fills the bar from a scroll timeline; without one (or with reduced motion) this sets it in the same steps.
const xpFill = document.querySelector<HTMLElement>(".xp-fill");
if (xpFill && (reduced || !CSS.supports("animation-timeline: scroll()"))) {
  let queued = false;
  const update = () => {
    queued = false;
    const max = root.scrollHeight - innerHeight;
    xpFill.style.setProperty("--xp", String(max > 0 ? Math.round((scrollY / max) * 90) / 90 : 0));
  };
  addEventListener("scroll", () => {
    if (!queued) (queued = true), requestAnimationFrame(update);
  }, { passive: true });
  update();
}
// The level is the numbered section crossing the upper half of the screen; reaching a new one shows its name.
const xpLevel = document.querySelector<HTMLElement>("[data-xp-level]");
const levels = [...document.querySelectorAll<HTMLElement>(".sec-no")].map((no) => ({
  section: no.closest("section")!,
  n: no.querySelector("span")?.textContent ?? "",
  name: [...no.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent).join("").trim(),
}));
if (xpLevel && levels.length) {
  let current: number | null = null; // null until the first check, which only records where the page opened
  let hide = 0;
  const pick = () => {
    const line = innerHeight * 0.45;
    let next = -1;
    levels.forEach((l, i) => {
      if (l.section.getBoundingClientRect().top <= line) next = i;
    });
    if (next === current) return;
    const first = current === null;
    current = next;
    if (next < 0 || first) return xpLevel.classList.remove("is-up");
    xpLevel.querySelector("b")!.textContent = `lvl ${levels[next].n}`;
    xpLevel.querySelector("span")!.textContent = levels[next].name;
    xpLevel.classList.add("is-up");
    clearTimeout(hide);
    hide = window.setTimeout(() => xpLevel.classList.remove("is-up"), 1600);
  };
  const levelIo = new IntersectionObserver(pick, { rootMargin: "-45% 0px -55% 0px" });
  levels.forEach((l) => levelIo.observe(l.section));
}

// ---- process band ------------------------------------------------------------------
// The story plays once through while the band is on screen: the line fills and each step turns "done" in
// turn, rests, then starts over. Hovering or focusing a step shows the state right after that step.
const band = document.querySelector<HTMLElement>("[data-band]");
if (band) {
  const steps = [...band.querySelectorAll<HTMLElement>(".pb-step")];
  const note = band.querySelector<HTMLElement>("[data-pb-note]")!;
  const idleNote = note.textContent ?? "";
  let pinned = false;
  /** `on` is the current step (or -1), `done` how many steps before it are finished. */
  const paint = (on: number, done: number) => {
    steps.forEach((s, k) => {
      s.classList.toggle("is-on", k === on);
      s.classList.toggle("is-done", k < done);
    });
    band.classList.toggle("is-start", on >= 0 || done > 0);
    band.classList.toggle("is-end", done === steps.length);
    note.textContent = on >= 0 ? steps[on].dataset.note! : idleNote;
  };
  steps.forEach((s, i) => {
    const pin = () => {
      pinned = true;
      paint(i, i);
    };
    s.addEventListener("mouseenter", pin);
    s.addEventListener("focusin", pin);
  });
  const release = () => {
    pinned = false;
    if (reduced) paint(-1, steps.length);
  };
  band.addEventListener("mouseleave", release);
  band.addEventListener("focusout", (e) => {
    if (!band.contains(e.relatedTarget as Node | null)) release();
  });
  if (reduced) paint(-1, steps.length);
  else
    onVisible(band, async () => {
      for (;;) {
        for (let i = 0; i < steps.length; i++) {
          if (!pinned) paint(i, i);
          await wait(1800);
        }
        if (!pinned) paint(-1, steps.length);
        await wait(3200);
        if (!pinned) paint(-1, 0);
        await wait(700);
      }
    });
}

// ---- plugin search demo -----------------------------------------------------------
const searchEl = document.querySelector<HTMLElement>(".demo-search");
if (searchEl && !reduced) {
  const query = searchEl.querySelector<HTMLElement>(".dp-query")!;
  const results = [...searchEl.querySelectorAll<HTMLElement>(".demo-plugins li")];
  const text = query.textContent ?? "";
  query.textContent = "";
  onVisible(searchEl, async () => {
    await wait(400);
    for (const ch of text) {
      query.textContent += ch;
      await wait(140);
    }
    searchEl.classList.add("is-typed");
    for (const r of results) {
      await wait(180);
      r.classList.add("is-in");
    }
    await wait(180);
    searchEl.classList.add("is-done");
  });
}

// ---- console demo -------------------------------------------------------------
const consoleEl = document.querySelector<HTMLElement>("[data-console]");
if (consoleEl) {
  const lines = [...consoleEl.querySelectorAll<HTMLElement>(".dc-log li")];
  const bars = [...consoleEl.querySelectorAll<HTMLElement>("[data-spark] i")];
  const m = (k: string) => consoleEl.querySelector<HTMLElement>(`[data-m="${k}"]`)!;
  const playerDelta = (l: HTMLElement) => (/joined the game/.test(l.textContent ?? "") ? 1 : /left the game/.test(l.textContent ?? "") ? -1 : 0);
  if (reduced) lines.forEach((l) => l.classList.add("is-in"));
  else
    onVisible(consoleEl, async () => {
      // The first lines are the history that is already there; the rest arrive live.
      const history = lines.length - 4;
      for (;;) {
        let players = 0;
        lines.forEach((l, i) => {
          l.classList.toggle("is-in", i < history);
          if (i < history) players += playerDelta(l);
        });
        m("players").textContent = String(players);
        for (const l of lines.slice(history)) {
          await wait(1400);
          l.classList.add("is-in");
          players += playerDelta(l);
          m("players").textContent = String(players);
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

// ---- assistant demo -----------------------------------------------------------
// The conversation arrives row by row; Approve runs the change, Decline leaves things as they are.
const aiEl = document.querySelector<HTMLElement>("[data-ai]");
if (aiEl) {
  const rows = [...aiEl.querySelectorAll<HTMLElement>(".ai-row")];
  const card = aiEl.querySelector<HTMLElement>("[data-ai-card]")!;
  const state = aiEl.querySelector<HTMLElement>("[data-ai-state]")!;
  const out = aiEl.querySelector<HTMLElement>("[data-ai-out]")!;
  const act = (name: string) => aiEl.querySelector<HTMLButtonElement>(`[data-ai-act="${name}"]`)!;
  const settle = (next: "done" | "declined" | null) => {
    card.dataset.state = next ?? "";
    state.textContent = next === "done" ? "Done · approved by you" : next === "declined" ? "Declined · nothing changed" : "Waiting for your approval";
    act("approve").hidden = act("decline").hidden = !!next;
    act("reset").hidden = !next;
    out.hidden = next !== "done";
  };
  act("approve").addEventListener("click", () => settle("done"));
  act("decline").addEventListener("click", () => settle("declined"));
  act("reset").addEventListener("click", () => {
    settle(null);
    act("approve").focus();
  });
  if (reduced) rows.forEach((r) => r.classList.add("is-in"));
  else
    onVisible(aiEl, async () => {
      for (const r of rows) {
        await wait(r.classList.contains("ai-user") ? 200 : 650);
        r.classList.add("is-in");
      }
    });
}

const perfEl = document.querySelector<HTMLElement>("[data-perf]");
if (perfEl) onVisible(perfEl, () => perfEl.classList.add("is-in"));

// ---- closer look ---------------------------------------------------------------
// Picking a legend number zooms the screenshot onto that spot; picking it again, the button, Esc or a click zooms out.
const look = document.querySelector<HTMLElement>("[data-look]");
const lookOut = document.querySelector<HTMLButtonElement>("[data-look-out]");
let zoomed: string | null = null;
const zoom = (ref: string | null) => {
  zoomed = ref;
  if (look) look.toggleAttribute("data-zoomed", !!ref);
  if (lookOut) lookOut.hidden = !ref;
  for (const b of document.querySelectorAll<HTMLElement>("[data-spot-ref]")) b.setAttribute("aria-pressed", String(b.dataset.spotRef === ref));
  for (const s of document.querySelectorAll<HTMLElement>(".spot")) {
    const on = s.dataset.spot === ref;
    s.classList.toggle("is-hint", on);
    const stage = s.closest<HTMLElement>(".look-zoom");
    if (!on || !stage) continue;
    stage.style.setProperty("--zx", `${s.dataset.x}%`);
    stage.style.setProperty("--zy", `${s.dataset.y}%`);
    // Ask for a sharper source at the zoomed size; the browser keeps the larger one once it has it.
    const width = Math.round(stage.offsetWidth * (matchMedia("(max-width: 620px)").matches ? 3 : 2));
    stage.querySelectorAll("img").forEach((img) => (img.sizes = `${width}px`));
  }
};
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-spot-ref]")) {
  b.addEventListener("click", () => zoom(zoomed === b.dataset.spotRef ? null : b.dataset.spotRef!));
  b.addEventListener("mouseenter", () => !zoomed && document.querySelector(`[data-spot="${b.dataset.spotRef}"]`)?.classList.add("is-hint"));
  b.addEventListener("mouseleave", () => !zoomed && document.querySelector(`[data-spot="${b.dataset.spotRef}"]`)?.classList.remove("is-hint"));
}
lookOut?.addEventListener("click", () => zoom(null));
document.querySelectorAll(".look-zoom").forEach((z) => z.addEventListener("click", (e) => {
  if (zoomed && !(e.target as Element).closest(".spot")) zoom(null);
}));
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && zoomed) zoom(null);
});

const lookTabs = [...document.querySelectorAll<HTMLButtonElement>("[data-look-tabs] [role=tab]")];
roving(lookTabs, (tab) => {
  zoom(null);
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
// A marker zooms like its legend entry; while zoomed out, hover and focus still show its tooltip.
for (const spot of document.querySelectorAll<HTMLButtonElement>(".spot")) {
  spot.addEventListener("click", () => zoom(zoomed === spot.dataset.spot ? null : spot.dataset.spot!));
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
