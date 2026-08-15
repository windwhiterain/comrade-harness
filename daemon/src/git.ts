import { spawnSync } from "bun";
import { resolve } from "node:path";

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(["git", ...args], { cwd: dir });
  return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
}

/** 目录必须是**独立** git 仓库（自己的 .git），不能落在某个外层仓库里——
 *  否则 add/commit/reset 会作用到外层仓库（如项目 cores/ 下没建 git 的"裸 core"会污染根仓库，真实踩过）。 */
function ownRepo(dir: string): boolean {
  const r = git(dir, ["rev-parse", "--show-toplevel"]);
  return r.ok && resolve(r.out.trim()) === resolve(dir);
}

export type SnapshotResult = { ok: true; sha: string | null } | { ok: false; error: string };

/** 提交工作区当前状态，返回新 sha。
 *  - ok:true, sha:null → 无改动
 *  - ok:false → 不是独立 git 仓库 / add / commit 失败（未配置 user.name/email 等），错误要明说，不能静默当"无改动" */
export function snapshot(dir: string, message: string): SnapshotResult {
  if (!ownRepo(dir)) {
    return { ok: false, error: "目录不是独立 git 仓库（快照会写进外层仓库，已拒绝）" };
  }
  const add = git(dir, ["add", "-A"]);
  if (!add.ok) return { ok: false, error: add.out.trim().slice(0, 300) || "git add 失败" };
  const dirty = git(dir, ["status", "--porcelain"]).out.trim();
  if (!dirty) return { ok: true, sha: null };
  const commit = git(dir, ["commit", "-m", message]);
  if (!commit.ok) {
    return {
      ok: false,
      error: commit.out.trim().slice(0, 300) || "git commit 失败（是否配置了 user.name / user.email？）",
    };
  }
  const sha = git(dir, ["rev-parse", "HEAD"]).out.trim();
  return { ok: true, sha: sha || null };
}

/** 硬回滚到指定 sha（丢弃未提交改动 —— 回滚的意义所在，旧状态仍在 reflog）。 */
export function rollback(dir: string, sha: string): boolean {
  if (!ownRepo(dir)) return false; // 不是独立仓库绝不 reset——防止误伤外层仓库
  return git(dir, ["reset", "--hard", sha]).ok;
}

export function head(dir: string): string | null {
  if (!ownRepo(dir)) return null;
  const r = git(dir, ["rev-parse", "HEAD"]);
  return r.ok ? r.out.trim() : null;
}

/** 工作树是否有未提交修改（status --porcelain 非空）。非独立 git 仓库按 false（无信息）处理。
 *  skip-worktree 的文件（模板 local:on 的 package.json/bun.lock）不会出现在 porcelain 输出里，不误报。 */
export function isDirty(dir: string): boolean {
  if (!ownRepo(dir)) return false;
  return git(dir, ["status", "--porcelain"]).out.trim().length > 0;
}

export function log(dir: string, limit = 30): { sha: string; message: string; ts: string }[] {
  if (!ownRepo(dir)) return [];
  const r = git(dir, ["log", "--format=%H%x1f%ct%x1f%s", "-n", String(limit)]);
  if (!r.ok) return [];
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ct, ...rest] = line.split("\x1f");
      return { sha, ts: new Date(Number(ct) * 1000).toISOString(), message: rest.join("\x1f") };
    });
}
