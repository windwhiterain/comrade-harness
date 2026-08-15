/**
 * 控制面协议：壳(浏览器) ⇄ daemon。
 * 这是全系统唯一必须稳定的契约 —— 版本化，保持最小。
 * 内容通道(iframe → core)不经过这里：core 的页面就是普通 HTML/CSS/JS。
 */
export const PROTOCOL_VERSION = 7;

export type CoreStatus = "boot" | "healthy" | "swapping" | "down" | "error";

export interface CoreInfo {
  id: string;
  name: string;
  /** 实际目录（可能项目外，如 ~/.comrade-harness/cores/<id>；工具层靠它定位任意 core） */
  dir: string;
  status: CoreStatus;
  port: number | null;
  url: string | null;
  sha: string | null;
  /** 工作树是否有未提交修改（git status --porcelain 非空；local:on 的 skip-worktree 文件不算） */
  dirty: boolean;
  /** 模板 core 标识（目录位于项目 cores/ 搜索路径下，如 standard/dsh-minimal）：**仅用于 UI 显示**（📦 卡片），
   *  没有任何行为限制——与普通 core 完全平等：可修改、可 reload、可 commit、可删除（2026-08-16 定案）。 */
  template: boolean;
}

export interface SnapshotInfo {
  sha: string;
  message: string;
  ts: string;
}

/** /api/snapshots/<id> 的响应：dirty = 当前工作树是否有未提交修改（与列表同一次请求，保证新鲜） */
export interface SnapshotResponse {
  dirty: boolean;
  list: SnapshotInfo[];
}

/** shell → daemon */
export type ClientMsg =
  | { type: "list" }
  | { type: "set_ui_core"; id: string }
  | { type: "reload"; id: string }
  | { type: "snapshot"; id: string; message: string }
  | { type: "rollback"; id: string; sha: string };

/** daemon → shell */
export type ServerMsg =
  | { type: "hello"; protocol: number; cores: CoreInfo[]; uiCoreId: string | null }
  | { type: "swap"; id: string; port: number; url: string }
  | { type: "ui_core"; id: string | null; url: string | null }
  | { type: "log"; line: string; core: string | null };

/** core 的运行契约（约定，不是 API）：
 *  - daemon 注入 PORT / CORE_ID / CORE_DIR / DB_PATH / DAEMON_URL / CORES_DIR 环境变量
 *  - CORE_DIR 是本 core 的实际目录（fork 出的 core 可能在项目外）
 *  - 必须提供 GET /health → 200
 *  - 其余一切自由（就是一个普通 Bun 服务）
 */
export interface CoreEnv {
  PORT: string;
  CORE_ID: string;
  CORE_DIR: string;
  DB_PATH: string;
  DAEMON_URL: string;
  CORES_DIR: string;
}
