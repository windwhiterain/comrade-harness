import type { Subprocess } from "bun";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import type { CoreInfo, CoreStatus } from "../../shared/protocol";
import * as git from "./git";
import type { Store } from "./store";

export type LogSink = (line: string, core: string | null) => void;

export interface ReloadResult {
  ok: boolean;
  error?: string;
}

interface Running {
  proc: Subprocess;
  port: number;
  pid: number;
}

interface CoreState {
  id: string;
  name: string;
  dir: string;
  status: CoreStatus;
  live: Running | null;
}

const HEALTH_TIMEOUT_MS = 8000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      // Windows 上 close 后端口不会立即释放，等一小段再交出，避免 EADDRINUSE 竞态
      srv.close(() => setTimeout(() => resolve(port), 150));
    });
  });
}

/**
 * 蓝绿监督器：门禁 → spawn 新进程 → 健康检查 → 换血。
 * 任何一步失败都保留当前 live 进程 —— 壳永远不看到死应用。
 */
export class Supervisor {
  private store: Store;
  private log: LogSink;
  private daemonUrl: string;
  private dataDir: string;
  private coresDir: string;
  /** 对外可达的 host（局域网 IP 或 PUBLIC_HOST），所有暴露给浏览器/壳的 core URL 用它 */
  private publicHost: string;
  private cores = new Map<string, CoreState>();
  private busy = new Set<string>();
  onSwap: ((id: string, port: number) => void) | null = null;
  onUiCore: ((id: string) => void) | null = null;
  /** 返回 true 表示该 core 旧进程仍有在途请求（如 agent 正在跑），延迟退役。
   *  port 是**旧进程**的端口（轮询它的 /api/status busy 字段）。 */
  retireWait: ((id: string, port: number) => Promise<boolean>) | null = null;
  private static readonly RETIRE_CAP_MS = 90_000;

  constructor(
    store: Store,
    log: LogSink,
    opts: { daemonUrl: string; dataDir: string; coresDir: string; publicHost: string },
  ) {
    this.store = store;
    this.log = log;
    this.daemonUrl = opts.daemonUrl;
    this.dataDir = opts.dataDir;
    this.coresDir = opts.coresDir;
    this.publicHost = opts.publicHost;
  }

  registerCore(id: string, name: string, dir: string) {
    this.store.addCore(id, name, dir);
    if (!this.cores.has(id)) {
      this.cores.set(id, { id, name, dir, status: "down", live: null });
      if (!existsSync(join(dir, ".git"))) {
        this.log(`[${id}] ⚠️ ${dir} 不是 git 仓库——快照/回滚/fork 将不可用`, id);
      }
    }
  }

  /** 模板 core 标识：目录位于项目 cores/（搜索路径，CORES_DIR）之下（standard/dsh-minimal）。
   *  **仅用于 UI 显示**（壳的 📦 卡片让用户知道这是项目内置 core）——没有任何行为限制：
   *  reload/snapshot/删除对模板与普通 core 完全平等（2026-08-16 定案：模板特判已废除，只剩标识）。 */
  private isTemplate(c: CoreState): boolean {
    const base = resolve(this.coresDir).toLowerCase();
    const dir = resolve(c.dir).toLowerCase();
    return dir === base || dir.startsWith(base + sep);
  }

  listCores(): string[] {
    return [...this.cores.keys()];
  }

  coreDir(id: string): string | null {
    return this.cores.get(id)?.dir ?? null;
  }

  info(id: string): CoreInfo {
    const c = this.cores.get(id);
    if (!c) throw new Error(`未知 core: ${id}`);
    return {
      id: c.id,
      name: c.name,
      dir: c.dir,
      status: c.status,
      port: c.live?.port ?? null,
      url: c.live ? `http://${this.publicHost}:${c.live.port}` : null,
      // 目录可能已被用户删除（运行中删 fork）：git 对不存在的 cwd 会 ENOENT 抛错，守卫掉
      sha: existsSync(c.dir) ? git.head(c.dir) : null,
      dirty: existsSync(c.dir) ? git.isDirty(c.dir) : false,
      template: this.isTemplate(c),
    };
  }

  allInfo(): CoreInfo[] {
    return this.listCores().map((id) => this.info(id));
  }

  /** 从任意目录导入一个 core（直接注册 + 启动），用于测试/接入已有 harness core。
   *  目录只需包含 src/index.ts；没有 .git 也能运行，只是快照/回滚/fork 不可用。
   *  name 可选：给 core 一个显示名/ID 基础名；缺省用目录名。ID 会按需追加 -2、-3 避免重复。
   *  启动失败会撤销注册（目录是用户自己的资产，不落库——修好后重新导入即可）；
   *  目录已被其他 core 使用时响应带 warning（两个 core 共享同一工作树，会互相覆盖）。 */
  async importCore(dir: string, name?: string): Promise<{ ok: boolean; error?: string; warning?: string; core?: CoreInfo }> {
    const abs = resolve(dir);
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { ok: false, error: `目录不存在或不是目录: ${abs}` };
      }
      if (!existsSync(join(abs, "src", "index.ts"))) {
        return { ok: false, error: `不是 core 目录（缺少 src/index.ts）: ${abs}` };
      }
      const base = (name?.trim() || basename(abs)).trim();
      const idBase = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "core";
      let id = idBase;
      let n = 1;
      while (this.cores.has(id)) id = `${idBase}-${n++}`;
      const dup = [...this.cores.values()].find((c) => resolve(c.dir) === abs);
      this.log(`[import] 注册 ${id} → ${abs}`, id);
      this.registerCore(id, base, abs);
      const res = await this.spawn(id, true);
      if (res.run) {
        this.swap(id, res.run);
        return {
          ok: true,
          core: this.info(id),
          ...(dup ? { warning: `目录已被 core ${dup.id} 使用——两个 core 共享同一工作树，注意互相覆盖` } : {}),
        };
      }
      // 启动失败 → 撤销注册：不落库（目录是用户自己的资产，修好后重新导入即可）
      this.cores.delete(id);
      this.store.removeCore(id);
      try {
        const dbPath = join(this.dataDir, "cores", `${id}.db`);
        if (existsSync(dbPath)) rmSync(dbPath);
      } catch (e) {
        this.log(`[import] 清理 ${id} 的 DB 失败（忽略）: ${e instanceof Error ? e.message : e}`, id);
      }
      this.log(`[import] 启动失败，撤销注册 ${id}`, id);
      return { ok: false, error: `导入失败: ${res.error ?? "未知错误"}（修好后重新导入）` };
    } catch (e) {
      return { ok: false, error: `导入失败: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async boot(id: string) {
    const c = this.cores.get(id)!;
    if (c.live) return; // 已在运行（如 discover 恢复的 core），boot 循环不再重复 spawn
    const res = await this.spawn(id, true);
    if (res.run) this.swap(id, res.run);
    else if (res.error) this.log(`[${id}] 启动失败: ${res.error}`, id);
  }

  async reload(id: string): Promise<ReloadResult> {
    return this.doReload(id);
  }

  /** 完整的蓝绿重载（快照→门禁→spawn→健康→换血）。 */
  private async doReload(id: string): Promise<ReloadResult> {
    const c = this.cores.get(id)!;
    if (this.busy.has(id)) {
      this.log(`[${id}] reload 进行中，忽略`, id);
      return { ok: false, error: "reload 进行中" };
    }
    this.busy.add(id);
    try {
      this.log(`[${id}] ===== 开始蓝绿重载 =====`, id);
      // 不自动快照（2026-08-15：reload 验证的就是工作树上的未提交改动——改完代码直接 reload 是常态，
      // 不产生 auto commit；回滚本来就会丢弃未提交改动，用户自己决定何时 commit）
      // 1. 门禁：typecheck
      this.log(`[${id}] 门禁: tsc --noEmit ...`, id);
      const gate = Bun.spawnSync(["bunx", "tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: c.dir });
      if (gate.exitCode !== 0) {
        const err = gate.stdout.toString() + gate.stderr.toString();
        this.log(`[${id}] 门禁失败，保留当前版本：`, id);
        for (const line of err.split("\n")) {
          if (line.trim()) this.log(`    ${line}`, id);
        }
        return { ok: false, error: err.trim().slice(0, 3000) };
      }
      this.log(`[${id}] 门禁通过`, id);
      // 2+3. spawn 新进程 + 健康检查
      const res = await this.spawn(id, false);
      if (!res.run) return { ok: false, error: res.error ?? "启动失败" };
      // 4. 换血（不阻塞：旧进程退役在后台进行）
      this.swap(id, res.run);
      return { ok: true };
    } finally {
      this.busy.delete(id);
    }
  }

  /** 确保 core 的依赖已安装（package.json 声明，如 link:comrade-harness-lib）。
   *  bun install 在依赖已满足时很快（~100ms），每次 spawn 前跑一次保证依赖最新。 */
  private ensureDeps(id: string, dir: string): boolean {
    if (!existsSync(join(dir, "package.json"))) return true; // 无依赖声明的裸 core
    this.log(`[${id}] 检查依赖 (bun install) ...`, id);
    const r = Bun.spawnSync(["bun", "install"], { cwd: dir, timeout: 60_000, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      const err = r.stdout.toString() + r.stderr.toString();
      this.log(`[${id}] 依赖安装失败: ${err.trim().slice(0, 800)}`, id);
      return false;
    }
    return true;
  }

  /** spawn 新进程并等健康检查。返回失败原因（依赖安装失败 vs 健康检查失败），不要笼统报"健康检查失败"。 */
  private async spawn(id: string, first: boolean): Promise<{ run: Running | null; error?: string }> {
    const c = this.cores.get(id)!;
    if (!this.ensureDeps(id, c.dir)) return { run: null, error: "依赖安装失败（bun install 未通过）" };
    // 端口竞态/启动失败自动换端口重试，最多 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      const port = await freePort();
      c.status = first ? "boot" : "swapping";
      this.log(`[${id}] spawn 新进程(尝试 ${attempt}/3) → 端口 ${port}`, id);
      const dbPath = join(this.dataDir, "cores", `${id}.db`);
      const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], {
        cwd: c.dir,
        env: {
          ...process.env,
          PORT: String(port),
          CORE_ID: id,
          CORE_DIR: c.dir, // 本 core 实际目录（fork 出的 core 在项目外，工具层靠它定位自己）
          DB_PATH: dbPath,
          DAEMON_URL: this.daemonUrl,
          CORES_DIR: this.coresDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream) continue;
        (async () => {
          const reader = stream.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, i);
              buf = buf.slice(i + 1);
              if (line.trim()) this.log(`[${id}] ${line}`, id);
            }
          }
        })();
      }
      const ok = await this.waitHealth(port);
      if (ok) {
        this.log(`[${id}] 健康检查通过 (pid ${proc.pid})`, id);
        return { run: { proc, port, pid: proc.pid } };
      }
      this.log(`[${id}] 健康检查失败（端口 ${port}），清理并重试`, id);
      try {
        proc.kill();
      } catch {}
      await sleep(300);
    }
    this.log(`[${id}] 连续 3 次启动失败`, id);
    c.status = first ? "error" : c.live ? "healthy" : "error";
    return { run: null, error: `健康检查失败（${HEALTH_TIMEOUT_MS / 1000}s 内 /health 未就绪）` };
  }

  private swap(id: string, run: Running) {
    const c = this.cores.get(id)!;
    const old = c.live;
    c.live = run;
    c.status = "healthy";
    this.log(`[${id}] 换血完成 → 端口 ${run.port}`, id);
    this.onSwap?.(id, run.port);
    if (old) void this.retireLater(id, old);
  }

  /** 旧进程延迟退役（后台执行，绝不阻塞换血）：
   *  若旧进程仍在忙（agent 任务在途，如正在改自己或回答聊天），
   *  先等它自然结束再杀，上限 90s。否则 reload 与在途请求会互相等待而死锁。 */
  private async retireLater(id: string, old: Running) {
    if (this.retireWait) {
      const t0 = Date.now();
      let waited = false;
      while (Date.now() - t0 < Supervisor.RETIRE_CAP_MS && (await this.retireWait(id, old.port))) {
        waited = true;
        await sleep(500);
      }
      if (waited) this.log(`[${id}] 在途请求结束，旧进程开始退役`, id);
    }
    try {
      old.proc.kill();
    } catch {}
    this.log(`[${id}] 旧进程 (pid ${old.pid}) 已退役`, id);
  }

  private async waitHealth(port: number): Promise<boolean> {
    const url = `http://127.0.0.1:${port}/health`;
    const t0 = Date.now();
    while (Date.now() - t0 < HEALTH_TIMEOUT_MS) {
      try {
        const r = await fetch(url);
        if (r.ok) return true;
      } catch {}
      await sleep(200);
    }
    return false;
  }

  async snapshot(id: string, message: string): Promise<{ ok: boolean; sha: string | null; error?: string }> {
    const c = this.cores.get(id)!;
    const res = git.snapshot(c.dir, message);
    if (!res.ok) {
      this.log(`[${id}] 快照失败: ${res.error}`, id);
      return { ok: false, sha: null, error: res.error };
    }
    if (res.sha) this.log(`[${id}] 快照 ${res.sha.slice(0, 8)}: ${message}`, id);
    else this.log(`[${id}] 无改动，跳过快照`, id);
    return { ok: true, sha: res.sha };
  }

  async rollback(id: string, sha: string): Promise<ReloadResult> {
    const c = this.cores.get(id)!;
    this.log(`[${id}] 回滚到 ${sha.slice(0, 8)}`, id);
    if (!git.rollback(c.dir, sha)) {
      this.log(`[${id}] 回滚失败`, id);
      return { ok: false, error: "git reset --hard 失败" };
    }
    return this.doReload(id);
  }

  /** git 意义上的 fork：git clone 源 core（复制全部历史，源记为 origin），注册并启动为新 core。
   *  源 core 不受影响（任意 core 都可以 fork 作来源）。
   *  fork 直接基于源的最新提交（不自动快照）——源有未提交修改时不会进新 core，响应带 warning 明说
   *  （UI 在 fork 前先查 dirty 并弹确认；agent 的 fork_core 工具先 snapshot 再 fork）。
   *  dir 指定新 core 的位置（绝对路径），缺省项目 cores/ 下；可以是项目外的任意目录。 */
  async fork(
    srcId: string,
    name: string,
    dir?: string,
  ): Promise<{ ok: boolean; error?: string; warning?: string; core?: CoreInfo }> {
    const src = this.cores.get(srcId);
    if (!src) return { ok: false, error: `源 core 不存在: ${srcId}` };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      return { ok: false, error: `名字不合法: ${name}（只能小写字母、数字、连字符，且不能以连字符开头）` };
    }
    if (this.cores.has(name)) return { ok: false, error: `core 已存在: ${name}` };
    const destDir = resolve(dir ?? this.coresDir);
    if (!isAbsolute(destDir)) return { ok: false, error: `dir 必须是绝对路径: ${dir}` };
    const dest = join(destDir, name);
    if (existsSync(dest)) return { ok: false, error: `目录已存在: ${dest}` };
    mkdirSync(destDir, { recursive: true });
    this.log(`[${srcId}] fork → ${name}（git clone 全历史，位置 ${destDir}）`, srcId);
    const dirty = existsSync(src.dir) && git.isDirty(src.dir);
    if (dirty) {
      this.log(`[${srcId}] ⚠️ fork 源有未提交修改——新 core 将不包含这些改动（直接基于最新提交）`, srcId);
    }
    const clone = Bun.spawnSync(["git", "clone", "--no-hardlinks", src.dir, dest]);
    if (clone.exitCode !== 0) {
      const err = clone.stdout.toString() + clone.stderr.toString();
      return { ok: false, error: `git clone 失败: ${err.trim().slice(0, 1000)}` };
    }
    this.registerCore(name, name, dest);
    const res = await this.spawn(name, true);
    if (res.run) {
      this.swap(name, res.run);
      return {
        ok: true,
        core: this.info(name),
        ...(dirty ? { warning: `源 core ${srcId} 有未提交修改，fork 出的新 core 不包含这些改动（直接基于最新提交）` } : {}),
      };
    }
    return {
      ok: false,
      error: `目录已创建（${name} 拥有完整 git 历史）但启动失败: ${res.error ?? "未知错误"}，可修复后 reload`,
    };
  }

  async setUiCore(id: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.cores.get(id);
    if (!c) return { ok: false, error: `没有这个 core: ${id}` };
    this.store.setUiCore(id);
    this.onUiCore?.(id);
    return { ok: true };
  }

  /** 删除一个 core（不可逆）：终止进程 → 清 store 记录 → 删目录（含全部 git 历史）与聊天 DB。
   *  删除的是 core 的整个存在，git 历史一并销毁，没有后悔药。 */
  async deleteCore(id: string): Promise<{ ok: boolean; error?: string }> {
    const c = this.cores.get(id);
    if (!c) return { ok: false, error: `没有这个 core: ${id}` };
    if (this.busy.has(id)) return { ok: false, error: "reload 进行中，稍后再试" };
    if (c.live) {
      try {
        c.live.proc.kill();
      } catch {}
      // Windows 上 TerminateProcess 后进程句柄（cwd）释放有延迟——立刻 rm 会 EBUSY，
      // 且记录已删、目录还在，半删除状态无法再通过 API 删除（真实踩过）。等进程真正退出再删。
      try {
        await Promise.race([c.live.proc.exited, sleep(3000)]);
      } catch {}
      c.live = null;
    }
    this.cores.delete(id);
    this.store.removeCore(id);
    const gone: string[] = [];
    if (existsSync(c.dir)) {
      rmSync(c.dir, { recursive: true, force: true });
      gone.push(c.dir);
    }
    const dbPath = join(this.dataDir, "cores", `${id}.db`);
    if (existsSync(dbPath)) {
      rmSync(dbPath);
      gone.push(dbPath);
    }
    this.log(`[${id}] 已删除：进程终止，目录与 git 历史、DB 一并移除`, id);
    return { ok: true };
  }

  async killAll() {
    for (const c of this.cores.values()) {
      if (c.live) {
        try {
          c.live.proc.kill();
        } catch {}
      }
    }
  }
}
