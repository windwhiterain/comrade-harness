#!/usr/bin/env bun
/**
 * crh — comrade-harness 命令行入口
 *
 * 用法：
 *   bun run crh web   启动驾驶舱（构建壳 + daemon 前台运行；Ctrl+C 退出）
 *                     默认只输出驾驶舱网址一行；CRH_VERBOSE=1 恢复过程日志
 *   crh web           全局安装后从任意目录启动（bun install -g github:windwhiterain/comrade-harness）
 *   crh version       打印版本
 *   crh help          帮助
 *
 * 两种运行形态自动识别（看 cwd 在不在包根下）：
 *   - 开发模式：仓库里跑（bun run crh web）——数据在 <仓库>/data，与旧 bun run dev 一字不差
 *   - 安装模式：bun 的 git 安装只给代码、不带 submodule——首次运行自动初始化内置 core 子模块
 *     （standard / dsh-minimal，fork 的来源，缺了驾驶舱就是空的），数据落到 ~/.comrade-harness/data
 *
 * 环境变量 CRH_DATA_DIR 可覆盖数据目录；LLM 等配置放运行目录的 .env 或系统环境变量
 * （bun 在启动目录自动加载 .env，crh 把 process.env 原样透传给 daemon）。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, ".."); // cli/ 的上一级 = 包根
const cwd = process.cwd();
const installed = cwd !== ROOT && !cwd.startsWith(ROOT + sep);
const DATA_DIR =
  process.env.CRH_DATA_DIR ?? (installed ? join(os.homedir(), ".comrade-harness", "data") : join(ROOT, "data"));

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
const VERSION = pkg.version ?? "0.0.0";
const cmd = process.argv[2] ?? "help";

// 默认静默：crh web 只输出 daemon 打印的网址一行；CRH_VERBOSE=1 恢复 [crh] 过程日志
const log = (line: string) => {
  if (process.env.CRH_VERBOSE === "1") console.log(`[crh] ${line}`);
};
const warn = (line: string) => console.warn(`[crh] ⚠ ${line}`);

function help() {
  console.log(`comrade-harness ${VERSION} — 驾驶舱启动器
用法:
  bun run crh web   启动驾驶舱（daemon + 壳，前台运行；Ctrl+C 退出）
  crh web           全局安装后从任意目录启动（bun install -g github:windwhiterain/comrade-harness）
  crh version       打印版本
  crh help          这份帮助
`);
}

// ---- 内置 core 子模块（standard / dsh-minimal）：fork 的来源 ----
interface Submodule {
  path: string;
  url: string;
}

function readSubmodules(): Submodule[] {
  const file = join(ROOT, ".gitmodules");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const subs: Submodule[] = [];
  for (const section of text.matchAll(/\[submodule\s+"([^"]+)"\]([\s\S]*?)(?=\[submodule|$)/g)) {
    const body = section[2];
    const path = body.match(/^\s*path\s*=\s*(\S+)/m)?.[1];
    const url = body.match(/^\s*url\s*=\s*(\S+)/m)?.[1];
    if (path && url) subs.push({ path, url });
  }
  return subs;
}

const subReady = (sub: Submodule) => existsSync(join(ROOT, sub.path, ".git"));

/** GitHub SSH 可用性探测（项目无关：任何配了 key 的账号都能 SSH 读公开仓库）。
 *  认证成功时输出 "Hi <user>!" 但退出码恒为 1（GitHub 的 ssh -T 惯例），按输出判断：
 *  "ok"（有 key，SSH 优先）；明确 Permission denied → "no-key"（只走 HTTPS）；
 *  超时/无 ssh/网络类 → "unknown"（HTTPS 优先，SSH 兜底——网络差时探测不可信，不能因此丢掉 SSH）。 */
function probeGitHubSsh(): "ok" | "no-key" | "unknown" {
  try {
    const r = Bun.spawnSync(
      ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new", "-T", "git@github.com"],
      { timeout: 15_000, stdout: "pipe", stderr: "pipe" },
    );
    const out = r.stdout.toString() + r.stderr.toString();
    if (out.includes("Hi ")) return "ok";
    if (/Permission denied|publickey|Could not open a connection/i.test(out)) return "no-key";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** HTTPS URL → SSH 形态（只对 github.com 转换；其他 host 返回空，避免改坏形态）。
 *  返回 [SSH(22), SSH-over-443(ssh.github.com:443)]——后者是"只放 443"网络下的逃生通道。 */
function sshVariants(httpsUrl: string): string[] {
  const m = httpsUrl.match(/^https:\/\/github\.com\/(.+)$/);
  if (!m) return [];
  return [`git@github.com:${m[1]}`, `ssh://git@ssh.github.com:443/${m[1]}`];
}

/** 补齐内置 core 子模块。先试 git submodule update --init（仓库检出：钉住 .gitmodules 的 gitlink 版本）；
 *  失败（如 bun 安装的副本没有 .git 元数据）就按 .gitmodules 逐个 git clone（取远端默认分支 = 发布版本）。
 *  克隆走多形态：探测到 SSH key → SSH(22) → HTTPS(443) → SSH-over-443；没 key → 只 HTTPS；
 *  探测不明 → HTTPS 优先、SSH 兜底。每个形态 2 次尝试 + 60s 超时；publickey 拒绝 → 跳过剩余 SSH 形态。 */
async function ensureSubmodules(): Promise<boolean> {
  const subs = readSubmodules();
  if (subs.every(subReady)) return true;
  const names = subs
    .filter((s) => !subReady(s))
    .map((s) => s.path)
    .join(", ");
  log(`初始化内置 core 子模块: ${names} ...`);
  try {
    const r = Bun.spawnSync(["git", "submodule", "update", "--init"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if (r.exitCode === 0 && subs.every(subReady)) return true;
  } catch (e) {
    warn(`git submodule update 不可用（${e instanceof Error ? e.message : e}），改为逐个 clone`);
  }
  const probe = probeGitHubSsh();
  const order =
    probe === "ok" ? (["ssh", "https", "ssh443"] as const) : probe === "no-key" ? (["https"] as const) : (["https", "ssh", "ssh443"] as const);
  if (probe === "ok") log("SSH 可用：克隆优先走 SSH（22），失败回落 HTTPS");
  if (probe === "no-key") log("未检测到 GitHub SSH key：克隆只走 HTTPS");
  let ok = true;
  for (const sub of subs) {
    if (subReady(sub)) continue;
    mkdirSync(join(ROOT, dirname(sub.path)), { recursive: true });
    let cloned = false;
    let skipSsh = false;
    for (const variant of order) {
      if (cloned) break;
      if (variant !== "https" && skipSsh) continue; // 已确认无 key：剩余 SSH 形态全跳过
      const variants = sshVariants(sub.url);
      const url = variant === "https" ? sub.url : variants[variant === "ssh" ? 0 : 1] ?? sub.url;
      const label = variant === "https" ? "HTTPS" : variant === "ssh" ? "SSH(22)" : "SSH(443)";
      for (let attempt = 1; attempt <= 2 && !cloned; attempt++) {
        log(`git clone ${url} → ${sub.path}（${label}，尝试 ${attempt}/2）...`);
        const c = Bun.spawnSync(["git", "clone", url, sub.path], {
          cwd: ROOT,
          stdout: "inherit",
          stderr: "pipe",
          stdin: "inherit",
          timeout: 60_000, // 网络黑洞时 git 的 TCP 超时可能很久，不让它拖死启动
        });
        if (c.exitCode === 0) {
          cloned = true;
          break;
        }
        const err = (c.stderr?.toString() ?? "").trim();
        if (err) process.stderr.write(err + "\n");
        if (/Permission denied|publickey/i.test(err)) skipSsh = true;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 3000)); // 网络抖动（连接被重置）重试
      }
    }
    if (!cloned) ok = false;
  }
  if (!ok)
    warn("内置 core 子模块初始化失败——需要 git 与网络。驾驶舱仍可启动，但没有内置 core 可 fork；重跑 crh web 会自动重试，或手动 git submodule update --init");
  return ok;
}

async function web() {
  await ensureSubmodules();
  if (!existsSync(join(ROOT, "node_modules"))) {
    log("首次运行：安装依赖 (bun install) ...");
    const r = Bun.spawnSync(["bun", "install"], {
      cwd: ROOT,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if (r.exitCode !== 0) warn("依赖安装失败——daemon 本身零依赖仍可运行，类型检查会退回 bunx 自动拉取");
  }
  log("构建壳 (bun build shell/src/app.ts → shell/dist) ...");
  const b = Bun.spawnSync(
    [process.execPath, "build", join(ROOT, "shell", "src", "app.ts"), "--outdir", join(ROOT, "shell", "dist")],
    { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
  );
  if (b.exitCode !== 0) {
    console.error("[crh] ✗ 壳构建失败——驾驶舱 UI 无法加载（错误见上）。检查 shell/src 是否完整");
    process.exit(1);
  }
  log(installed ? `启动 daemon（安装模式：数据 ${DATA_DIR}，内置 core 在包内 cores/）` : `启动 daemon（开发模式：数据 ${DATA_DIR}）`);
  // CRH_DATA_DIR 恒传入（显式化数据位置）；daemon 其余一切从 cwd=ROOT 解析，与 bun run dev 行为一致
  const env = { ...process.env, CRH_DATA_DIR: DATA_DIR };
  const proc = Bun.spawn([process.execPath, "run", "daemon/src/main.ts"], {
    cwd: ROOT,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) console.error(`[crh] daemon 退出，code=${code}`);
  process.exit(code ?? 0);
}

switch (cmd) {
  case "web":
    void web();
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`comrade-harness ${VERSION}`);
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`[crh] 未知命令: ${cmd}`);
    help();
    process.exit(1);
}
