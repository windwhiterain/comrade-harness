// comrade-harness 发布脚本：按依赖顺序发布四个仓库（发布工作流自动化，见 AGENTS.md §2）。
// 用法：bun run publish [--dry-run] [版本号]
//   版本号可选（如 v0.2.0，建议与现有 v0.1.0 同风格）：给了就把**四个仓库**（含无改动的）在各自当前
//   HEAD 打上新 tag 并推送（force 语义，与 amend 工作流一致；再次同版本发布会移到新 HEAD）；
//   不给则只有 v0.1.0 照常移动（滚动尖端标记，见下）。
//
// 语义：**只 amend HEAD（最后一条 commit），绝不 squash 历史**——正式 commit 不会被压掉：
//   - 工作树有改动        → 改动并进 HEAD 后发布（HEAD 是正式 commit 就并进它；v0.1.0 及其余历史原封不动）
//   - 干净但有未推送 commit → 直接推送（不 amend）
//   - 全部干净            → 跳过
//   tag v0.1.0 每次发布都移到最新 HEAD（tag 标记发布尖端；旧 commit 由备份分支保住，防外部 fork 锁失效）。
//
// 流程：
//   1. 每个要发的仓库先建并推送备份分支 backup/pre-amend-<YYYYMMDDHHMM>（保住 force push 前的旧 commit）
//   2. lib 有改动 → 发布 → 把新 commit sha 同步进两个模板的 package.json（git 依赖 commit id）
//      → 模板 bun install 刷新 lock（postinstall 自动重链本地覆盖，见各模板 scripts/local-link.ts）
//   3. 模板有改动 → 发布
//   4. 根仓库（文档 + gitlink bump）→ 发布
// 只发布有改动的仓库。lib 路径用环境变量 LIB_DIR 覆盖（默认 C:/resource/comrade-harness-lib，本机路径）。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = process.env.LIB_DIR ?? "C:/resource/comrade-harness-lib";
const STANDARD = join(ROOT, "cores", "standard");
const DSH = join(ROOT, "cores", "dsh-minimal");
const TAG = "v0.1.0";
const dry = process.argv.includes("--dry-run");
const version = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? null;
if (version && !/^[A-Za-z0-9._-]+$/.test(version)) {
  console.error(`✗ 版本号不合法: ${version}（git tag 名只允许字母、数字、. _ -）`);
  process.exit(1);
}

if (!existsSync(join(LIB, ".git"))) {
  console.error(`✗ LIB_DIR 不是 git 仓库: ${LIB}（用环境变量 LIB_DIR 指定 lib 路径）`);
  process.exit(1);
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "").trim() };
}

function run(cwd: string, cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(" ")} 失败 (${r.status})`);
    process.exit(1);
  }
}

function checkMain(cwd: string, name: string): void {
  const br = git(cwd, ["branch", "--show-current"]);
  if (!br.ok || br.out.trim() !== "main") {
    console.error(`✗ ${name} 不在 main 分支（当前: ${br.out.trim() || "?"}）`);
    process.exit(1);
  }
}

function backupBranch(cwd: string, name: string, ts: string): void {
  const b = `backup/pre-amend-${ts}`;
  if (git(cwd, ["rev-parse", "--verify", b]).ok) return; // 本分钟已建过 → 复用
  console.log(`[backup] ${name}: ${b}`);
  if (dry) return;
  if (!git(cwd, ["branch", b]).ok || !git(cwd, ["push", "origin", b]).ok) {
    console.error(`✗ ${name} 备份分支失败`);
    process.exit(1);
  }
}

function dirty(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain"]).out.trim().length > 0;
}

function unpushed(cwd: string): string {
  // 本地领先 origin/main 的 commit（干净工作树下的"正式 commit"也要发布；先静默 fetch 保证 ref 新鲜）
  git(cwd, ["fetch", "origin", "main", "--quiet"]);
  if (!git(cwd, ["rev-parse", "--verify", "origin/main"]).ok) {
    console.error(`✗ ${basename(cwd)}: 无法确定与 origin/main 的差距`);
    process.exit(1);
  }
  return git(cwd, ["log", "origin/main..HEAD", "--oneline"]).out.trim();
}

function publishRepo(cwd: string, name: string, ts: string): void {
  checkMain(cwd, name);
  const isDirty = dirty(cwd);
  const ahead = unpushed(cwd);
  if (!isDirty && !ahead) {
    console.log(`[skip] ${name}: 无改动、无未推送 commit`);
    return;
  }
  backupBranch(cwd, name, ts);
  console.log(`[publish] ${name}: ${isDirty ? "amend HEAD + " : ""}force push main/${TAG}`);
  if (dry) {
    const parts: string[] = [];
    if (isDirty) parts.push("将 amend: " + git(cwd, ["status", "--porcelain"]).out.trim().replace(/\n/g, " | "));
    if (ahead) parts.push("将推送未推送 commit: " + ahead.replace(/\n/g, " | "));
    console.log("  dry-run，" + parts.join("；"));
    return;
  }
  if (isDirty) {
    // 只 amend HEAD（最后一条 commit）——正式 commit 不会被 squash，v0.1.0 及其余历史原封不动
    if (!git(cwd, ["add", "-A"]).ok || !git(cwd, ["commit", "--amend", "--no-edit"]).ok) {
      console.error(`✗ ${name} amend 失败`);
      process.exit(1);
    }
  }
  git(cwd, ["tag", "-f", TAG]);
  const p1 = git(cwd, ["push", "--force", "origin", "main"]);
  const p2 = git(cwd, ["push", "--force", "origin", TAG]);
  if (!p1.ok || !p2.ok) {
    console.error(`✗ ${name} push 失败\n${p1.out}\n${p2.out}`);
    process.exit(1);
  }
  console.log(`✓ ${name}: ${git(cwd, ["rev-parse", "HEAD"]).out.trim()}`);
}

function syncLibSha(): void {
  const sha = git(LIB, ["rev-parse", "HEAD"]).out.trim();
  for (const tpl of [STANDARD, DSH]) {
    const p = join(tpl, "package.json");
    const text = readFileSync(p, "utf8").replace(
      /github:windwhiterain\/comrade-harness-lib#[0-9a-f]+/,
      `github:windwhiterain/comrade-harness-lib#${sha}`,
    );
    writeFileSync(p, text);
    console.log(`[sync] ${basename(tpl)}: comrade-harness-lib -> #${sha.slice(0, 7)}`);
    if (!dry) run(tpl, "bun", ["install"]); // 刷新 lock；postinstall 重链本地覆盖
  }
}

const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
console.log(dry ? "=== publish (dry-run) ===" : "=== publish ===");
const libChanged = dirty(LIB);
if (libChanged) {
  publishRepo(LIB, "lib", ts);
  syncLibSha();
} else {
  console.log("[skip] lib: 无改动（模板依赖 sha 已是最新）");
}
publishRepo(STANDARD, "standard", ts);
publishRepo(DSH, "dsh-minimal", ts);
publishRepo(ROOT, "root", ts);
// 可选版本号：四个仓库（含无改动的）都在当前 HEAD 打上新 tag 并推送——版本 tag 是发布快照标记
if (version) {
  for (const [cwd, name] of [
    [LIB, "lib"],
    [STANDARD, "standard"],
    [DSH, "dsh-minimal"],
    [ROOT, "root"],
  ] as const) {
    console.log(`[tag] ${name}: ${version}`);
    if (dry) continue;
    if (!git(cwd, ["tag", "-f", version]).ok || !git(cwd, ["push", "--force", "origin", version]).ok) {
      console.error(`✗ ${name} 版本 tag ${version} 失败`);
      process.exit(1);
    }
  }
}
console.log(dry ? "=== dry-run 结束（未改动任何东西）===" : "=== 发布完成 ===");
