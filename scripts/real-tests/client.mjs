// Tiny CraftPanel API client for real-server test scenarios. The first sign-in on a fresh data dir creates the owner;
// CP_USER / CP_PASSWORD override the throwaway test account (only ever use these against local test instances).
export function client(base) {
  let cookie = "";
  let csrf = "";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function call(method, url, body) {
    const r = await fetch(base + url, { method, headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf }, body: body !== undefined ? JSON.stringify(body) : method === "GET" || method === "DELETE" ? undefined : "{}" });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(`${method} ${url} ${r.status} ${text}`);
      e.status = r.status;
      e.body = text;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  }
  const c = {
    call,
    session: () => ({ cookie, csrf }),
    sleep,
    async signIn(username = process.env.CP_USER ?? "owner", password = process.env.CP_PASSWORD ?? "owner-password-1") {
      const state = await call("GET", "/api/auth/state");
      const res = state.setupRequired ? await call("POST", "/api/auth/setup", { username, password }) : await call("POST", "/api/auth/login", { username, password });
      csrf = res.csrfToken;
    },
    async create(input) {
      return call("POST", "/api/servers", { acceptEula: true, onlineMode: false, memoryMb: 1536, ...input });
    },
    async server(id) {
      return call("GET", `/api/servers/${id}`);
    },
    async waitInstalled(id, timeoutMs = 15 * 60_000) {
      const t0 = Date.now();
      for (;;) {
        const d = await c.server(id);
        if (d.installState === "installed") return d;
        if (d.installState === "failed") throw new Error(`install failed: ${d.installError}`);
        if (Date.now() - t0 > timeoutMs) throw new Error("install timeout");
        await sleep(2000);
      }
    },
    async waitStatus(id, want, timeoutMs = 5 * 60_000) {
      const t0 = Date.now();
      for (;;) {
        const d = await c.server(id);
        if (d.status === want) return d;
        if (["crashed", "error"].includes(d.status) && want !== d.status) throw new Error(`server ${d.status}: ${d.lastError}`);
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${want} (is ${d.status})`);
        await sleep(1500);
      }
    },
    async start(id) {
      await call("POST", `/api/servers/${id}/start`);
      return c.waitStatus(id, "running");
    },
    async stop(id) {
      await call("POST", `/api/servers/${id}/stop`);
      return c.waitStatus(id, "stopped");
    },
    async command(id, command) {
      return call("POST", `/api/servers/${id}/command`, { command });
    },
    async log(id) {
      return call("GET", `/api/servers/${id}/console?limit=400`).catch(() => null);
    },
  };
  return c;
}
