import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { join, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg, type SnapshotResponse } from "../../shared/protocol";
import * as git from "./git";
import { Store } from "./store";
import { Supervisor } from "./supervisor";

const PORT = Number(process.env.PORT ?? 3800);
// 数据目录：CRH_DATA_DIR 覆盖（crh 的安装模式把它指到 ~/.comrade-harness/data）；缺省仓库 data/（开发模式）
const DATA_DIR = resolve(process.env.CRH_DATA_DIR ?? "data");

// ---- 启动端口自愈（2026-08-15）：单实例接管 + 端口顺延 ----
// 旧 daemon 残留（终端被关/重复跑 bun run dev）会占住端口导致 EADDRINUSE。
// 新 daemon 启动时：目标端口被**本系统旧 daemon**占用 → 终止其进程树（含 core）并接管；
// 被**其他程序**占用 → 顺延到 PORT+1 … PORT+9。识别失败一律当"他人占用"处理——绝不误杀。
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 端口是否空闲：绑定探测（0.0.0.0，与 Bun.serve 默认一致）。close 后 Windows 端口释放有延迟，
 *  按 §6.1 的经验等 150ms 再交还，避免紧接着绑定撞 EADDRINUSE。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", () => resolve(false));
    srv.listen(port, "0.0.0.0", () => srv.close(() => setTimeout(() => resolve(true), 150)));
  });
}

/** 占用端口的进程 PID（Windows 用 netstat 的 LISTENING 行，POSIX 用 lsof）。探测失败返回 null。 */
function pidOnPort(port: number): number | null {
  const r =
    process.platform === "win32"
      ? Bun.spawnSync(["netstat", "-ano"], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) return null;
  if (process.platform !== "win32") {
    const pid = Number(r.stdout.toString().trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
  for (const line of r.stdout.toString().split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5 && parts[0] === "TCP" && parts[1].endsWith(`:${port}`) && parts[3] === "LISTENING") {
      return Number(parts[4]) || null;
    }
  }
  return null;
}

/** 进程命令行（Windows 用 wmic；POSIX 读 /proc）。读不到返回 null。 */
function processCommandLine(pid: number): string | null {
  if (process.platform === "win32") {
    const r = Bun.spawnSync(
      ["wmic", "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/format:list"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) return null;
    const m = r.stdout.toString().match(/CommandLine=(.*)/);
    return m ? m[1].trim() : null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return null;
  }
}

/** 是不是本系统的旧 daemon：命令行含 daemon/src/main.ts（core 是 src/index.ts，不会误判）。
 *  分隔符归一化：crh 启动器用绝对路径 spawn 时 Windows 命令行是反斜杠。 */
function isOurDaemon(pid: number): boolean {
  const cmd = processCommandLine(pid)?.replaceAll("\\", "/") ?? null;
  return cmd !== null && cmd.includes("daemon/src/main.ts");
}

/** 终止旧 daemon 进程树：Windows taskkill /F /T（连 core 子进程一起）；
 *  POSIX SIGTERM（daemon 的 SIGTERM 处理器会先 killAll core 再退出）。 */
function killDaemonTree(pid: number) {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "pipe", stderr: "pipe" });
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

/** 单实例接管：选一个能绑定的端口。目标端口被自家旧 daemon 占着 → 杀掉接管；
 *  被别的程序占着/识别不了 → 顺延。最多试 10 个端口，全忙则抛错。 */
async function acquirePort(): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const candidate = PORT + i;
    if (await portFree(candidate)) {
      if (i > 0) console.log(`[daemon] 端口 ${PORT} 被其他程序占用，改用 ${candidate}`);
      return candidate;
    }
    const pid = pidOnPort(candidate);
    if (pid === null || !isOurDaemon(pid)) {
      console.log(
        pid === null
          ? `[daemon] 端口 ${candidate} 被占用且无法识别占用者，顺延（绝不误杀）`
          : `[daemon] 端口 ${candidate} 被其他程序占用（pid ${pid}，非 comrade-harness daemon），顺延`,
      );
      continue;
    }
    console.log(`[daemon] 端口 ${candidate} 被旧 daemon 占用（pid ${pid}），自动接管：终止旧进程及其 core`);
    killDaemonTree(pid);
    for (let w = 0; w < 10; w++) {
      if (await portFree(candidate)) return candidate;
      await sleep(400);
    }
    console.log(`[daemon] 端口 ${candidate} 释放超时，顺延`);
  }
  throw new Error(`[daemon] 端口 ${PORT}~${PORT + 9} 全部不可用，放弃启动`);
}
mkdirSync(join(DATA_DIR, "cores"), { recursive: true });

// 可选控制面令牌：设置后所有 /api/* 与 /ws 都要求 Authorization: Bearer <token>（或 ?token=）。
// 不设则完全开放（默认；仅限可信网络使用，见信任模型）。
const COCKPIT_TOKEN = process.env.COCKPIT_TOKEN?.trim() ?? "";

function authed(req: Request, url: URL): boolean {
  if (!COCKPIT_TOKEN) return true;
  if (req.headers.get("authorization") === `Bearer ${COCKPIT_TOKEN}`) return true;
  return url.searchParams.get("token") === COCKPIT_TOKEN;
}

// 用户 core 的默认位置（fork 到项目外，不被项目 git 跟踪）：~/.comrade-harness/cores
const USER_CORES_DIR = process.env.USER_CORES_DIR ?? join(os.homedir(), ".comrade-harness", "cores");

/** 对外可达的 host：PUBLIC_HOST 显式指定 > 自动探测本机局域网 IPv4 > 127.0.0.1。
 *  所有暴露给浏览器/壳/core 页面的 URL 都用它（本机 daemon⇄core 调用仍用 127.0.0.1）。
 *  探测启发式：跳过回环/APIPA/常见虚拟网卡，优先物理网卡（WLAN/以太网等）。 */
const VIRTUAL_IFACE = /vEthernet|vmware|virtualbox|docker|hyper-?v|wsl|loopback|tap-?|tun-?|npcap|nodebaby/i;
const PHYSICAL_IFACE = /wlan|wireless|wi-?fi|ethernet|以太网|本地连接/i;

function detectPublicHost(): string {
  const explicit = process.env.PUBLIC_HOST?.trim();
  if (explicit) return explicit.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const candidates: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (a.address.startsWith("169.254.")) continue; // APIPA 自动私有地址
      if (VIRTUAL_IFACE.test(name)) continue;
      candidates.push(a.address);
      if (PHYSICAL_IFACE.test(name)) return a.address; // 物理网卡优先
    }
  }
  return candidates[0] ?? "127.0.0.1";
}
const PUBLIC_HOST = detectPublicHost();
let port: number;
try {
  port = await acquirePort();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
if (PUBLIC_HOST !== "127.0.0.1") console.log(`[daemon] 局域网可达: http://${PUBLIC_HOST}:${port}（PUBLIC_HOST 可覆盖）`);

const store = new Store(join(DATA_DIR, "harness.db"));
const wsClients = new Set<ServerWebSocket<unknown>>();

function broadcast(msg: ServerMsg) {
  const raw = JSON.stringify(msg);
  for (const ws of wsClients) {
    try {
      ws.send(raw);
    } catch {}
  }
}

const sup = new Supervisor(
  store,
  (line, core) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[${ts}] ${line}`); // 同时打 stdout，方便无外壳调试
    broadcast({ type: "log", line: `[${ts}] ${line}`, core });
  },
  { daemonUrl: `http://${PUBLIC_HOST}:${port}`, dataDir: DATA_DIR, coresDir: resolve("cores"), publicHost: PUBLIC_HOST },
);

sup.onSwap = (id, port) =>
  broadcast({ type: "swap", id, port, url: `http://${PUBLIC_HOST}:${port}` });
sup.onUiCore = (id) => {
  const info = sup.info(id);
  broadcast({ type: "ui_core", id, url: info.url });
};

/** 注册 cores/ 下每个含 src/index.ts 的目录作为一个 core；并从 store 恢复
 *  之前注册过的 core（含 fork 到项目外的：它们的 dir 记录在 store.cores 表）。
 *  模板 = 目录位于项目 cores/（搜索路径）下的 core（supervisor 判定），没有标记文件。 */
function discoverCores() {
  // ① 从 store 恢复：项目外 fork 的 core 靠它重新被发现（dir 是绝对路径）
  for (const row of store.listCores()) {
    if (existsSync(join(row.dir, "src", "index.ts"))) {
      sup.registerCore(row.id, row.name, row.dir);
    } else {
      // 目录已被删除 → 清理残留记录（2026-08-14 真实踩过：残留记录让 /api/health 崩——git.head 对已删目录 ENOENT）
      store.removeCore(row.id);
    }
  }
  // ② 扫描项目 cores/ 下新增的目录
  const base = resolve("cores");
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base)) {
    // 已注册的（从 store 恢复的）跳过：同名影子目录不能覆盖已有 core 的记录
    if (sup.listCores().includes(entry)) continue;
    const dir = join(base, entry);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, "src", "index.ts"))) {
      sup.registerCore(entry, entry, dir);
    }
  }
}

// ---- 壳的静态托管：壳只从 daemon 加载资源（隔离规则 1） ----
// 构建产物在 shell/dist（app.js），静态文件在 shell/（index.html、app.css）
const SHELL_DIR = resolve("shell");
const SHELL_DIST = resolve("shell/dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveShell(pathname: string): Response {
  let rel: string;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    return new Response("not found", { status: 404 }); // 畸形 URI（如孤立 %）
  }
  for (const root of [SHELL_DIST, SHELL_DIR]) {
    const file = resolve(root, rel);
    if (!file.startsWith(root + sep)) continue; // 防目录穿越
    if (existsSync(file) && statSync(file).isFile()) {
      const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
      return new Response(Bun.file(file), {
        headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
      });
    }
  }
  return new Response("not found", { status: 404 });
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function handleClientMsg(msg: ClientMsg, ws: ServerWebSocket<unknown>) {
  switch (msg.type) {
    case "list":
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          cores: sup.allInfo(),
          uiCoreId: store.getUiCore(),
        } satisfies ServerMsg),
      );
      break;
    case "set_ui_core": {
      const res = await sup.setUiCore(msg.id);
      if (!res.ok) ws.send(JSON.stringify({ type: "log", line: res.error, core: null }));
      break;
    }
    case "reload":
      sup.reload(msg.id);
      break;
    case "snapshot":
      sup.snapshot(msg.id, msg.message || "手动快照");
      break;
    case "rollback":
      sup.rollback(msg.id, msg.sha);
      break;
  }
}

/** 可用的 core（非模板）id 列表。模板 core（如 standard）不运行，只作为 fork 来源。 */
function usableCoreIds(): string[] {
  return sup.allInfo()
    .filter((c) => !c.template)
    .map((c) => c.id);
}

/** 在途 agent 请求的探测：轮询旧进程 /api/status 的 busy 字段。
 *  旧进程还在跑 agent（聊天/自改自）就等它说完再退役；404/不可达 = 立即退役。 */
sup.retireWait = async (_id, port) => {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: authHeaders() });
    if (!r.ok) return false;
    const d = (await r.json()) as { busy?: boolean };
    return d.busy === true;
  } catch {
    return false;
  }
};

function authHeaders(): Record<string, string> {
  return COCKPIT_TOKEN ? { authorization: `Bearer ${COCKPIT_TOKEN}` } : {};
}

/** 请求方要求 SSE 流式（Accept: text/event-stream）；不带则返回与原来一致的 JSON。 */
function wantsSSE(req: Request): boolean {
  return (req.headers.get("accept") ?? "").includes("text/event-stream");
}

/** 把用户消息中继给指定 core 的 agent 端点（缺省当前 UI core，见 /api/chat）。
 *  core 之间互不依赖；daemon 只是基础设施转发。
 *  session 透传给 core（core 内的会话 id，缺省 default——单会话 core 忽略它）。
 *  stream=true 时透传 core 的 SSE 流（旧 core 不支持 → 把 JSON 回复包装成单条 done 事件，调用方照常消费）；
 *  否则返回与原来一致的 JSON（{ok:true, reply}）。错误现在返回真实状态码 + {ok:false, error}。 */
async function relayChat(text: string, coreId: string, stream: boolean, session?: string, pause?: boolean): Promise<Response> {
  if (!sup.listCores().includes(coreId)) return json({ ok: false, error: `没有这个 core: ${coreId}` }, 400);
  const info = sup.info(coreId);
  if (!info.port) return json({ ok: false, error: `没有可用的 core: ${coreId}（未上线）` }, 400);
  try {
    const r = await fetch(`http://127.0.0.1:${info.port}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(stream ? { accept: "text/event-stream" } : {}),
        ...authHeaders(),
      },
      body: JSON.stringify({
        message: text,
        ...(session ? { session } : {}),
        ...(typeof pause === "boolean" ? { pause } : {}),
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!r.ok) {
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      return json({ ok: false, error: data.error ?? `agent 出错: ${r.status}` }, r.status);
    }
    if (stream) {
      if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
        return new Response(r.body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      const data = (await r.json()) as { reply?: string };
      const body = `event: done\ndata: ${JSON.stringify({ reply: data.reply ?? "(空回复)" })}\n\n`;
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    const data = (await r.json()) as { reply?: string };
    return json({ ok: true, reply: data.reply ?? "(空回复)" });
  } catch (e) {
    return json({ ok: false, error: `agent 调用失败: ${e instanceof Error ? e.message : e}` }, 502);
  }
}

discoverCores();

// 默认 UI core：存储的 ui_core 有效（core 存在）→ 用它；否则第一个可用 core（模板也可设为 UI）。
// 不自动 fork——core 是用户的资产，创建由用户显式决定（壳/curl 右键模板卡片 fork）。
const stored = store.getUiCore();
const storedOk = !!stored && sup.listCores().includes(stored);
if (!storedOk) {
  const first = usableCoreIds()[0];
  if (first) void sup.setUiCore(first);
}

let server: Server<undefined>;
try {
  server = Bun.serve({
  port,
  idleTimeout: 255, // Bun 上限；SSE 双跳长连接在 LLM 思考间隙不能被默认 10s 掐断（core 侧早已是 255）
  async fetch(req, srv) {
    const url = new URL(req.url);
    // ---- 控制面鉴权（可选 COCKPIT_TOKEN）：/api/* 与 /ws 都要求；壳的静态资源保持公开 ----
    if (url.pathname.startsWith("/api/") || url.pathname === "/ws") {
      if (!authed(req, url)) return json({ ok: false, error: "unauthorized（daemon 设置了 COCKPIT_TOKEN，请携带令牌）" }, 401);
    }
    // ---- REST 控制面（也是 curl 与未来 agent 的入口） ----
    if (url.pathname === "/api/health") {
      return json({ ok: true, protocol: PROTOCOL_VERSION, uiCoreId: store.getUiCore(), cores: sup.allInfo() });
    }
    if (url.pathname === "/api/cores") return json(sup.allInfo());

    const act = url.pathname.match(/^\/api\/(reload|snapshot|rollback|set-ui|delete)\/([^/]+)$/);
    if (act) {
      // 状态变更一律要求 POST（GET 会被浏览器/图片标签跨站触发——CSRF）
      if (req.method !== "POST") return json({ ok: false, error: "需要 POST" }, 405);
      const [, action, id] = act;
      if (action === "reload") {
        // 始终等待结果（门禁/健康检查），返回 {ok, error}；WS 通道仍走广播日志
        const res = await sup.reload(id);
        return json(res);
      }
      if (action === "snapshot") {
        const msg = url.searchParams.get("message") ?? "REST 手动提交";
        const res = await sup.snapshot(id, msg);
        return json({ ...res, note: res.ok ? (res.sha ? "已快照" : "无改动，未产生新快照") : undefined });
      }
      if (action === "rollback") {
        const sha = url.searchParams.get("sha");
        if (!sha) return json({ ok: false, error: "missing sha" }, 400);
        const res = await sup.rollback(id, sha);
        return json(res);
      }
      if (action === "set-ui") {
        const res = await sup.setUiCore(id);
        return json(res, res.ok ? 200 : 400);
      }
      if (action === "delete") {
        const res = await sup.deleteCore(id);
        if (res.ok) {
          // 删掉的是当前 UI core → 回落第一个可用 core（没有则不设，壳显示空驾驶舱；不自动 fork）
          if (store.getUiCore() === id) {
            const next = usableCoreIds()[0];
            if (next) await sup.setUiCore(next);
          }
          broadcast({
            type: "hello",
            protocol: PROTOCOL_VERSION,
            cores: sup.allInfo(),
            uiCoreId: store.getUiCore(),
          } satisfies ServerMsg);
        }
        return json(res, res.ok ? 200 : 400);
      }
    }
    // 终止指定 core 的当前 agent 任务（UI 直连 core 用 core 自己的 /api/abort；这里给 curl/未来壳用）
    const abortMatch = url.pathname.match(/^\/api\/abort\/([^/]+)$/);
    if (abortMatch && req.method === "POST") {
      const [, id] = abortMatch;
      const info = sup.info(id);
      if (!info || !info.port) return json({ ok: false, error: `没有可用的 core: ${id}` }, 400);
      try {
        const r = await fetch(`http://127.0.0.1:${info.port}/api/abort`, {
          method: "POST",
          headers: authHeaders(),
          signal: AbortSignal.timeout(10_000),
        });
        return json(await r.json(), r.ok ? 200 : r.status);
      } catch (e) {
        return json({ ok: false, error: `abort 调用失败: ${e instanceof Error ? e.message : e}` }, 502);
      }
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const { message, core, session, pause } = (await req.json()) as { message?: unknown; core?: string; session?: unknown; pause?: unknown };
      // 空消息合法（允许发送空消息；逐步暂停中空消息 = 只继续不插入——core 端处理）
      if (typeof message !== "string") return json({ ok: false, error: "missing message" }, 400);
      // 缺省转发给当前 UI core（模板也可设为 UI/聊天——模板可运行，是参考实现/迁移源）
      const ui = store.getUiCore();
      const target = core ?? (ui && sup.listCores().includes(ui) ? ui : usableCoreIds()[0]);
      if (!target) return json({ ok: false, error: "没有可用的 core" }, 400);
      // 带 Accept: text/event-stream 的请求得到 SSE 流（思考/工具/回复增量实时流出）；否则同步 JSON（行为不变）
      return relayChat(message, target, wantsSSE(req), typeof session === "string" ? session : undefined, typeof pause === "boolean" ? pause : undefined);
    }
    // fork：git clone 源 core（全历史）为新 core 并启动；成功后广播 hello 让所有壳刷新
    // dir 指定新 core 的位置（绝对路径），缺省 ~/.comrade-harness/cores（项目外）
    const forkMatch = url.pathname.match(/^\/api\/fork\/([^/]+)$/);
    if (forkMatch && req.method === "POST") {
      const name = url.searchParams.get("name") ?? `${forkMatch[1]}-fork`;
      const dir = url.searchParams.get("dir") ?? USER_CORES_DIR;
      const res = await sup.fork(forkMatch[1], name, dir);
      if (res.ok) {
        broadcast({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          cores: sup.allInfo(),
          uiCoreId: store.getUiCore(),
        } satisfies ServerMsg);
      }
      return json(res, res.ok ? 200 : 400);
    }
    const snaps = url.pathname.match(/^\/api\/snapshots\/([^/]+)$/);
    if (snaps) {
      const dir = sup.coreDir(snaps[1]);
      if (!dir) return json({ dirty: false, list: [] });
      return json({ dirty: git.isDirty(dir), list: git.log(dir) } satisfies SnapshotResponse);
    }
    if (url.pathname === "/ws" && req.headers.get("upgrade") === "websocket") {
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    // ---- 壳的静态资源 ----
    return serveShell(url.pathname);
  },
  websocket: {
    open(ws) {
      wsClients.add(ws);
      ws.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          cores: sup.allInfo(),
          uiCoreId: store.getUiCore(),
        } satisfies ServerMsg),
      );
    },
    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as ClientMsg;
        handleClientMsg(msg, ws);
      } catch (e) {
        ws.send(JSON.stringify({ type: "log", line: `坏消息: ${e}`, core: null }));
      }
    },
    close(ws) {
      wsClients.delete(ws);
    },
  },
  });
} catch (e) {
  if ((e as { code?: string }).code === "EADDRINUSE") {
    console.error(`[daemon] 端口 ${port} 绑定失败：已被其他进程占用（端口自愈已尝试接管/顺延仍失败）。可设置 PORT 环境变量换端口`);
    process.exit(1);
  }
  throw e;
}

console.log(`[daemon] comrade-harness 驾驶舱: http://127.0.0.1:${server.port}`);

// 启动所有 core（端口由 freePort 预分配 + 150ms 释放延迟，并发启动安全）
for (const id of sup.listCores()) {
  sup.boot(id).catch((e) => console.error(`[daemon] boot ${id} 失败:`, e));
}

process.on("SIGINT", async () => {
  await sup.killAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await sup.killAll();
  process.exit(0);
});
