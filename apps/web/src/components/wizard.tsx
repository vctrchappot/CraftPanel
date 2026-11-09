"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Boxes, Check, Network, Hammer, ChevronLeft, ChevronRight, Coffee, Feather, Globe, Home, Info, Package, Puzzle, ShieldCheck, Zap } from "lucide-react";
import { Badge, Button, Callout, Field, Input, NativeSelect, PageHeader, Panel, Skeleton, Switch, Textarea, cn } from "@craftpanel/ui";
import { buildFieldLabel, buildName, PERFORMANCE_PRESETS, PRESET_INFO, recommendPreset, SOFTWARE_INFO, softwareLabel, type CreateServerInput, type ServerSoftware } from "@craftpanel/shared";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useServers } from "@/lib/queries";
import { formatBytes, formatDate } from "@/lib/format";
import { useSystem } from "./home";
import { ModpackPicker, type PreparedModpack } from "./modpack-picker";

export interface VersionOption {
  id: string;
  stable: boolean;
  releaseTime?: string;
}
export interface VersionInfo {
  builds: { id: string; channel: string; time: string; changes: string[] }[];
  java: { major: number; recommendedFlags: string[]; available: { path: string; version: string; managed: boolean } | null };
  log4shell: string | null;
}

export const SOFTWARE_CHOICES: { id: ServerSoftware; badge?: string; description: string; icon: React.ReactNode }[] = [
  { id: "paper", badge: "Recommended", description: "Faster than Vanilla and supports Bukkit/Paper plugins. Gameplay matches Vanilla closely.", icon: <Zap /> },
  { id: "purpur", description: "Paper with many extra gameplay and configuration options. Runs the same plugins.", icon: <Feather /> },
  { id: "fabric", description: "Mod loader for server-side Fabric mods (e.g. Lithium for performance). Most mods need Fabric API.", icon: <Puzzle /> },
  { id: "neoforge", description: "Mod loader for NeoForge mods and large modpacks. Uses more memory; plan for 4 GB or more.", icon: <Hammer /> },
  { id: "vanilla", description: "The unmodified official server from Mojang. No plugins or mods.", icon: <Package /> },
];

const STEPS = ["Basics", "Software", "Version", "World", "Gameplay", "Resources", "Network", "Review"] as const;
/** A proxy has no world or gameplay settings. */
const PROXY_STEPS = STEPS.filter((s) => s !== "World" && s !== "Gameplay");

type Form = Required<Omit<CreateServerInput, "javaPath" | "directory" | "build" | "edition" | "modpackId">> & {
  build: string;
  directory: string;
  mode: "survival" | "creative" | "adventure" | "hardcore";
};

export function CreateServerWizard() {
  const router = useRouter();
  const servers = useServers();
  const system = useSystem();
  const [step, setStep] = React.useState(0);
  const [submitting, setSubmitting] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const nextPort = React.useMemo(() => {
    const used = new Set(servers.data?.map((s) => s.port) ?? []);
    let p = 25565;
    while (used.has(p)) p++;
    return p;
  }, [servers.data]);

  const [f, setF] = React.useState<Form>({
    name: "",
    description: "",
    software: "paper",
    mcVersion: "",
    build: "",
    levelName: "world",
    seed: "",
    levelType: "minecraft:normal",
    generateStructures: true,
    gamemode: "survival",
    hardcore: false,
    mode: "survival",
    difficulty: "normal",
    maxPlayers: 20,
    whitelist: false,
    onlineMode: true,
    motd: "A CraftPanel server",
    memoryMb: 2048,
    jvmArgs: "",
    performancePreset: null,
    networkMode: "lan",
    bindAddress: "",
    port: 25565,
    directory: "",
    acceptEula: false,
    autoStart: false,
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }));
  const [fromModpack, setFromModpack] = React.useState(false);
  const [pack, setPack] = React.useState<PreparedModpack | null>(null);
  const modpack = fromModpack ? pack : null;
  const proxy = !fromModpack && SOFTWARE_INFO[f.software].proxy;
  const steps = proxy ? PROXY_STEPS : STEPS;
  const buildLabel = SOFTWARE_INFO[f.software].buildLabel;
  React.useEffect(() => setF((p) => (p.port === 25565 && nextPort !== 25565 ? { ...p, port: nextPort } : p)), [nextPort]);
  const recommended = system.data ? recommendPreset({ arch: system.data.arch, cpus: system.data.cpus, memoryBytes: system.data.memory.total }) : null;
  const presetTouched = React.useRef(false);
  React.useEffect(() => {
    if (recommended && !presetTouched.current) setF((p) => ({ ...p, performancePreset: recommended }));
  }, [recommended]);

  const versions = useQuery({ queryKey: ["catalog", f.software, "versions"], queryFn: () => api.get<VersionOption[]>(`/api/catalog/${f.software}/versions`), staleTime: 600_000 });
  React.useEffect(() => {
    if (!modpack && versions.data?.length && !versions.data.some((v) => v.id === f.mcVersion)) set("mcVersion", versions.data[0].id);
  }, [versions.data, f.mcVersion, modpack]);
  const versionInfo = useQuery({
    queryKey: ["catalog", f.software, "version", f.mcVersion],
    queryFn: () => api.get<VersionInfo>(`/api/catalog/${f.software}/versions/${f.mcVersion}`),
    // Right after a software change the version still belongs to the previous software.
    enabled: !!f.mcVersion && !!versions.data?.some((v) => v.id === f.mcVersion),
    staleTime: 300_000,
  });

  const totalMb = system.data ? Math.floor(system.data.memory.total / 1024 / 1024) : 8192;
  const maxMb = Math.max(1024, Math.floor((totalMb - 512) / 512) * 512);

  const choosePack = (p: PreparedModpack | null) => {
    setPack(p);
    if (!p) return;
    // Modpacks run many mods; 4 GB is a common minimum.
    setF((prev) => ({
      ...prev,
      software: p.info.software,
      mcVersion: p.info.mcVersion,
      build: p.info.loader ?? "",
      name: prev.name || p.info.name.slice(0, 48),
      memoryMb: Math.max(prev.memoryMb, Math.min(4096, maxMb)),
    }));
  };

  const stepError = (): string | null => {
    switch (steps[step]) {
      case "Basics":
        return f.name.trim() ? null : "Give your server a name";
      case "Software":
        return fromModpack && !pack ? "Choose a modpack" : null;
      case "Version":
        return f.mcVersion ? null : "Choose a Minecraft version";
      case "World":
        return /^[A-Za-z0-9 _.-]+$/.test(f.levelName) && !f.levelName.startsWith(".") ? null : "World name may contain letters, digits, spaces, '.', '_' and '-'";
      case "Resources":
        return f.memoryMb > maxMb ? `This machine has ${formatBytes(totalMb * 1024 * 1024)} of RAM` : null;
      case "Network":
        return f.port >= 1024 && f.port <= 65535 ? (servers.data?.some((s) => s.port === f.port) ? `Port ${f.port} is already used by another server` : null) : "Port must be between 1024 and 65535";
      case "Review":
        return f.acceptEula ? null : "You must accept the Minecraft EULA";
      default:
        return null;
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setFieldErrors({});
    try {
      const { mode, build, directory, ...rest } = f;
      const body = {
        ...rest,
        gamemode: mode === "hardcore" ? "survival" : mode,
        hardcore: mode === "hardcore",
        build: build || null,
        directory: directory.trim() || undefined,
        modpackId: modpack?.id,
      };
      const created = await api.post<{ id: string }>("/api/servers", body);
      toast.success("Server created. Installing…");
      router.push(`/server/?id=${created.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.details) setFieldErrors(err.details);
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const err = stepError();
  const isLast = step === steps.length - 1;

  return (
    <div className="space-y-8">
      <PageHeader title="Create a server" description="CraftPanel downloads official server software and a compatible Java runtime. Nothing is shared with third parties." />
      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <ol className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => i < step && setStep(i)}
                disabled={i > step}
                className={cn(
                  "flex h-8 w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 text-[13px] transition-colors",
                  i === step ? "bg-muted font-medium text-foreground" : i < step ? "text-foreground hover:bg-muted/60" : "text-muted-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 items-center justify-center rounded-full border text-[11px] tabular-nums",
                    i < step ? "border-foreground bg-foreground text-background" : i === step ? "border-foreground" : "border-border",
                  )}
                >
                  {i < step ? <Check className="size-3" /> : i + 1}
                </span>
                {s}
              </button>
            </li>
          ))}
        </ol>

        <Panel className="flex min-h-[460px] flex-col">
          <div className="flex-1 space-y-6 p-6 sm:p-8">
            <h2 className="text-lg font-semibold tracking-tight">{steps[step]}</h2>

            {steps[step] === "Basics" && (
              <div className="max-w-lg space-y-5">
                <Field label="Server name" htmlFor="name" error={fieldErrors.name}>
                  <Input id="name" autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Survival with friends" maxLength={48} />
                </Field>
                <Field label="Description" htmlFor="desc" help="Optional. Only shown in CraftPanel.">
                  <Textarea id="desc" value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={280} rows={3} />
                </Field>
                <Field label="Message of the day" htmlFor="motd" help="Shown under the server name in Minecraft's multiplayer list.">
                  <Input id="motd" value={f.motd} onChange={(e) => set("motd", e.target.value)} maxLength={120} />
                </Field>
              </div>
            )}

            {steps[step] === "Software" && (
              <div className="space-y-5">
                <Field label="Edition">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Choice selected title="Java Edition" description="For Minecraft on Windows, macOS and Linux." icon={<Coffee />} onClick={() => undefined} />
                    <Choice
                      disabled
                      title="Bedrock Edition"
                      description="Planned. Requires a different server binary and network setup."
                      icon={<Package />}
                      badge="Planned"
                      onClick={() => undefined}
                    />
                  </div>
                </Field>
                <Field label="Server software">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {SOFTWARE_CHOICES.map((c) => (
                      <Choice
                        key={c.id}
                        selected={!fromModpack && f.software === c.id}
                        title={softwareLabel(c.id)}
                        badge={c.badge}
                        description={c.description}
                        icon={c.icon}
                        onClick={() => (setFromModpack(false), set("software", c.id), set("build", ""))}
                      />
                    ))}
                    <Choice
                      selected={proxy}
                      title="Velocity proxy"
                      badge="Network"
                      description="Puts several of your servers behind one address; players switch with /server. Set up the servers behind it after creating it."
                      icon={<Network />}
                      onClick={() => (setFromModpack(false), set("software", "velocity"), set("build", ""), set("memoryMb", 1024))}
                    />
                    <Choice
                      selected={fromModpack}
                      title="Modpack"
                      description="A ready-made Fabric or NeoForge modpack from Modrinth or your own .mrpack file. Version and loader come from the pack."
                      icon={<Boxes />}
                      onClick={() => (setFromModpack(true), pack && choosePack(pack))}
                    />
                  </div>
                </Field>
                {fromModpack && (
                  <Field label="Modpack">
                    <ModpackPicker value={pack} onChange={choosePack} />
                  </Field>
                )}
              </div>
            )}

            {steps[step] === "Version" && (
              <div className="max-w-lg space-y-5">
                {modpack ? (
                  <Callout icon={<Boxes />} title={`${modpack.info.name} ${modpack.info.version}`}>
                    The modpack sets Minecraft {modpack.info.mcVersion}
                    {modpack.info.loader ? ` with ${buildFieldLabel(modpack.info.software)} ${modpack.info.loader}` : ""}. Players need the same modpack version in their launcher.
                  </Callout>
                ) : (
                  <>
                    <Field
                      label={proxy ? "Velocity version" : "Minecraft version"}
                      htmlFor="version"
                      help={proxy ? "Velocity works with every Minecraft version the servers behind it run." : "Players must use the same version to join."}
                    >
                      {versions.isLoading ? (
                        <Skeleton className="h-9" />
                      ) : versions.error ? (
                        <Callout variant="danger" icon={<AlertTriangle />} title="Could not load versions">
                          {errorMessage(versions.error)}. Check this machine's internet connection.
                        </Callout>
                      ) : (
                        <NativeSelect id="version" value={f.mcVersion} onChange={(e) => (set("mcVersion", e.target.value), set("build", ""))}>
                          {versions.data?.map((v, i) => (
                            <option key={v.id} value={v.id}>
                              {v.id}
                              {i === 0 ? " (latest)" : ""}
                            </option>
                          ))}
                        </NativeSelect>
                      )}
                    </Field>
                    {buildLabel && (
                      <Field
                        label={buildFieldLabel(f.software)}
                        htmlFor="build"
                        help={`The newest stable ${SOFTWARE_INFO[f.software].modLoader ? "version" : "build"} is used by default.`}
                      >
                        <NativeSelect id="build" value={f.build} onChange={(e) => set("build", e.target.value)} disabled={!versionInfo.data}>
                          <option value="">Latest stable</option>
                          {versionInfo.data?.builds.map((b) => (
                            <option key={b.id} value={b.id}>
                              {buildName(f.software, b.id)} · {b.channel.toLowerCase()}
                              {b.time ? ` · ${formatDate(b.time)}` : ""}
                            </option>
                          ))}
                        </NativeSelect>
                      </Field>
                    )}
                  </>
                )}
                {versionInfo.data && (
                  <Callout icon={<Coffee />} title={`Requires Java ${versionInfo.data.java.major}`}>
                    {versionInfo.data.java.available
                      ? `Java ${versionInfo.data.java.available.version} is available${versionInfo.data.java.available.managed ? " (managed by CraftPanel)" : ""}.`
                      : `Not installed yet. CraftPanel will download Eclipse Temurin ${versionInfo.data.java.major} from Adoptium during installation.`}
                  </Callout>
                )}
                {versionInfo.data?.log4shell && (
                  <Callout icon={<ShieldCheck />} title="Log4Shell protection">
                    Minecraft {f.mcVersion} is affected by the Log4Shell vulnerability. CraftPanel protects it automatically on every start: {versionInfo.data.log4shell}.
                  </Callout>
                )}
              </div>
            )}

            {steps[step] === "World" && (
              <div className="max-w-lg space-y-5">
                <Field label="World name" htmlFor="level" help="Folder name of the world." error={fieldErrors.levelName}>
                  <Input id="level" value={f.levelName} onChange={(e) => set("levelName", e.target.value)} maxLength={64} />
                </Field>
                <Field label="Seed" htmlFor="seed" help="Leave empty for a random world.">
                  <Input id="seed" value={f.seed} onChange={(e) => set("seed", e.target.value)} maxLength={64} placeholder="Random" />
                </Field>
                <Field label="World type" htmlFor="ltype">
                  <NativeSelect id="ltype" value={f.levelType} onChange={(e) => set("levelType", e.target.value as Form["levelType"])}>
                    <option value="minecraft:normal">Default</option>
                    <option value="minecraft:flat">Superflat</option>
                    <option value="minecraft:large_biomes">Large biomes</option>
                    <option value="minecraft:amplified">Amplified (needs more CPU and RAM)</option>
                  </NativeSelect>
                </Field>
                <ToggleRow label="Generate structures" help="Villages, temples, strongholds and more." checked={f.generateStructures} onChange={(v) => set("generateStructures", v)} />
              </div>
            )}

            {steps[step] === "Gameplay" && (
              <div className="max-w-lg space-y-5">
                <Field label="Game mode">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {(["survival", "creative", "adventure", "hardcore"] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => set("mode", m)}
                        className={cn(
                          "h-9 rounded-md border text-[13px] font-medium capitalize transition-colors",
                          f.mode === m ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted",
                        )}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                </Field>
                {f.mode === "hardcore" && (
                  <Callout variant="warning" icon={<AlertTriangle />}>
                    Hardcore locks difficulty to Hard. Players become spectators when they die.
                  </Callout>
                )}
                <Field label="Difficulty" htmlFor="diff">
                  <NativeSelect
                    id="diff"
                    value={f.mode === "hardcore" ? "hard" : f.difficulty}
                    disabled={f.mode === "hardcore"}
                    onChange={(e) => set("difficulty", e.target.value as Form["difficulty"])}
                  >
                    <option value="peaceful">Peaceful</option>
                    <option value="easy">Easy</option>
                    <option value="normal">Normal</option>
                    <option value="hard">Hard</option>
                  </NativeSelect>
                </Field>
                <Field label="Maximum players" htmlFor="maxp">
                  <Input id="maxp" type="number" min={1} max={1000} value={f.maxPlayers} onChange={(e) => set("maxPlayers", Number(e.target.value))} className="w-32" />
                </Field>
                <ToggleRow label="Whitelist" help="Only players you add can join. Recommended for private servers." checked={f.whitelist} onChange={(v) => set("whitelist", v)} />
                <ToggleRow
                  label="Online mode"
                  help="Verify players with Mojang accounts. Turning this off allows anyone to join as any name."
                  checked={f.onlineMode}
                  onChange={(v) => set("onlineMode", v)}
                />
                {!f.onlineMode && (
                  <Callout variant="danger" icon={<AlertTriangle />}>
                    Offline mode lets people impersonate any player, including operators. Only use it on isolated networks.
                  </Callout>
                )}
              </div>
            )}

            {steps[step] === "Resources" && (
              <div className="max-w-lg space-y-5">
                <Field
                  label="Memory"
                  htmlFor="mem"
                  aside={<span className="text-[13px] font-medium tabular-nums">{(f.memoryMb / 1024).toFixed(1)} GB</span>}
                  help={system.data ? `This machine has ${formatBytes(system.data.memory.total)} RAM. 2–4 GB suits a few players; leave room for the operating system.` : undefined}
                  error={f.memoryMb > maxMb ? "More than this machine can provide" : null}
                >
                  <input
                    id="mem"
                    type="range"
                    min={512}
                    max={maxMb}
                    step={512}
                    value={Math.min(f.memoryMb, maxMb)}
                    onChange={(e) => set("memoryMb", Number(e.target.value))}
                    className="w-full accent-[var(--foreground)]"
                  />
                </Field>
                <Field
                  label="Performance"
                  htmlFor="preset"
                  help={f.performancePreset ? PRESET_INFO[f.performancePreset].description : "Java's default garbage collector settings and Minecraft's default distances."}
                >
                  <NativeSelect
                    id="preset"
                    value={f.performancePreset ?? ""}
                    onChange={(e) => {
                      presetTouched.current = true;
                      set("performancePreset", (e.target.value || null) as Form["performancePreset"]);
                    }}
                  >
                    {PERFORMANCE_PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {PRESET_INFO[p].label}
                        {p === recommended ? " (recommended for this machine)" : ""}
                      </option>
                    ))}
                    <option value="">None</option>
                  </NativeSelect>
                </Field>
                <Field
                  label="Additional JVM arguments"
                  htmlFor="jvm"
                  help="Optional. Each argument must start with '-'. Memory is set above; the performance preset adds its garbage collector flags."
                  error={fieldErrors.jvmArgs}
                >
                  <Textarea id="jvm" rows={3} value={f.jvmArgs} onChange={(e) => set("jvmArgs", e.target.value)} className="font-mono text-xs" placeholder="-XX:+UseG1GC" />
                </Field>
                <ToggleRow label="Start with CraftPanel" help="Start this server automatically whenever CraftPanel starts." checked={f.autoStart} onChange={(v) => set("autoStart", v)} />
              </div>
            )}

            {steps[step] === "Network" && (
              <div className="max-w-xl space-y-5">
                <Field label="Who should be able to join?">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Choice selected={f.networkMode === "lan"} title="Local network" description="Players on the same Wi-Fi or LAN." icon={<Home />} onClick={() => set("networkMode", "lan")} />
                    <Choice
                      selected={f.networkMode === "wan"}
                      title="Internet"
                      description="Friends anywhere. Requires router port forwarding."
                      icon={<Globe />}
                      onClick={() => set("networkMode", "wan")}
                    />
                  </div>
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Port" htmlFor="port" help="TCP port players connect to." error={fieldErrors.port}>
                    <Input id="port" type="number" min={1024} max={65535} value={f.port} onChange={(e) => set("port", Number(e.target.value))} />
                  </Field>
                  <Field label="Bind address" htmlFor="bind" help="All interfaces is simplest.">
                    <NativeSelect id="bind" value={f.bindAddress} onChange={(e) => set("bindAddress", e.target.value)}>
                      <option value="">All interfaces</option>
                      {(system.data?.lanAddresses ?? system.data?.lan.map((address) => ({ address, kind: "lan", label: "Local network" })) ?? []).map((a) => (
                        <option key={a.address} value={a.address}>
                          {a.address} ({a.label})
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                {f.networkMode === "wan" && (
                  <Callout icon={<Info />} title="Internet access needs your router">
                    Forward TCP port {f.port} on your router to this computer. The Network tab of the server shows your addresses and runs diagnostics. The CraftPanel dashboard itself stays private.
                  </Callout>
                )}
                <Field label="Storage location" htmlFor="dir" help="Optional absolute path for the server files. Leave empty to use CraftPanel's data directory." error={fieldErrors.directory}>
                  <Input id="dir" value={f.directory} onChange={(e) => set("directory", e.target.value)} placeholder="Default" className="font-mono text-xs" />
                </Field>
              </div>
            )}

            {steps[step] === "Review" && (
              <div className="max-w-xl space-y-6">
                <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2.5 text-[13px]">
                  {[
                    ["Name", f.name],
                    ...(modpack ? [["Modpack", `${modpack.info.name} ${modpack.info.version} · ${modpack.info.serverFiles} files`]] : []),
                    ["Software", `${softwareLabel(f.software)} ${f.mcVersion}${f.build ? ` · ${buildFieldLabel(f.software)} ${f.build}` : ""}`],
                    ["Java", versionInfo.data ? `Java ${versionInfo.data.java.major}${versionInfo.data.java.available ? "" : " (will be downloaded)"}` : "—"],
                    ...(proxy
                      ? []
                      : [
                          ["World", `${f.levelName}${f.seed ? ` · seed ${f.seed}` : ""} · ${f.levelType.replace("minecraft:", "")}`],
                          ["Gameplay", `${f.mode} · ${f.mode === "hardcore" ? "hard" : f.difficulty} · ${f.maxPlayers} players${f.whitelist ? " · whitelist" : ""}`],
                        ]),
                    ["Memory", `${(f.memoryMb / 1024).toFixed(1)} GB`],
                    ["Performance", f.performancePreset ? PRESET_INFO[f.performancePreset].label : "Java defaults"],
                    ["Network", `${f.networkMode === "lan" ? "Local network" : "Internet"} · port ${f.port}${f.bindAddress ? ` · ${f.bindAddress}` : ""}`],
                    ["Storage", f.directory || "CraftPanel data directory"],
                  ].map(([k, v]) => (
                    <React.Fragment key={k}>
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="break-all font-medium capitalize-first">{v}</dd>
                    </React.Fragment>
                  ))}
                </dl>
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4">
                  <input type="checkbox" checked={f.acceptEula} onChange={(e) => set("acceptEula", e.target.checked)} className="mt-0.5 size-4 accent-[var(--foreground)]" />
                  <span className="text-[13px]">
                    I have read and accept the{" "}
                    <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                      Minecraft End User License Agreement
                    </a>
                    . The server cannot start without it.
                  </span>
                </label>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4 sm:px-8">
            <Button variant="ghost" onClick={() => (step === 0 ? router.back() : setStep(step - 1))}>
              <ChevronLeft /> {step === 0 ? "Cancel" : "Back"}
            </Button>
            <div className="flex items-center gap-3">
              {err && step > 0 && <p className="hidden text-xs text-muted-foreground sm:block">{err}</p>}
              {isLast ? (
                <Button onClick={submit} disabled={!!err} loading={submitting}>
                  Create server
                </Button>
              ) : (
                <Button onClick={() => setStep(step + 1)} disabled={!!err}>
                  Continue <ChevronRight />
                </Button>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

export function Choice({
  selected,
  disabled,
  title,
  description,
  icon,
  badge,
  onClick,
}: {
  selected?: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  icon: React.ReactNode;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-foreground bg-muted/40" : "border-border hover:border-foreground/30",
      )}
    >
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 space-y-1">
        <span className="flex items-center gap-2 text-sm font-medium">
          {title}
          {badge && <Badge>{badge}</Badge>}
        </span>
        <span className="block text-[13px] text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

export function ToggleRow({ label, help, checked, onChange, disabled }: { label: string; help?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = React.useId();
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="space-y-0.5">
        <label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </label>
        {help && <p className="text-xs text-muted-foreground">{help}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
