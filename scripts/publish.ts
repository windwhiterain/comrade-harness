// comrade-harness 发布脚本：按依赖顺序 amend 四个仓库 + force push main/tag（发布工作流自动化，见 AGENTS.md §2）。
// 用法：bun run publish [--dry-run]
//
// 流程：
//   1. 每个要发的仓库先建并推送备份分支 backup/pre-amend-<YYYYMMDDHHMM>（保住旧 commit，防外部 fork 的旧 lock 失效）
//   2. lib 有改动 → amend + force push → 把新 commit sha 同步进两个模板的 package.json（git 依赖 commit id）
//      → 模板 bun install 刷新 lock（postinstall 自动重链本地覆盖，见各模板 scripts/local-link.ts）
//   3. 模板有改动 → amend + force push
//   4. 根仓库（文档 + gitlink bump）→ amend + force push
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

function publishRepo(cwd: string, name: string, ts: string): void {
  checkMain(cwd, name);
  backupBranch(cwd, name, ts);
  if (!dirty(cwd)) {
    console.log(`[skip] ${name}: 无改动`);
    return;
  }
  console.log(`[publish] ${name}: amend + force push main/${TAG}`);
  if (dry) {
    console.log("  dry-run，将提交: " + git(cwd, ["status", "--porcelain"]).out.trim().replace(/\n/g, " | "));
    return;
  }
  if (!git(cwd, ["add", "-A"]).ok || !git(cwd, ["commit", "--amend", "--no-edit"]).ok) {
    console.error(`✗ ${name} amend 失败`);
    process.exit(1);
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
console.log(dry ? "=== dry-run 结束（未改动任何东西）===" : "=== 发布完成 ===");
