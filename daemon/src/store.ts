import { Database } from "bun:sqlite";

export interface CoreRow {
  id: string;
  name: string;
  dir: string;
}

/** daemon 的唯一持久事实来源。core 自己的数据不在这里（各自 DB_PATH）。 */
export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run(`CREATE TABLE IF NOT EXISTS cores (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, dir TEXT NOT NULL
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ui_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )`);
  }

  listCores(): CoreRow[] {
    return this.db.query("SELECT id, name, dir FROM cores ORDER BY id").all() as CoreRow[];
  }

  addCore(id: string, name: string, dir: string) {
    // UPSERT：core 目录删除后记录会残留，同名 core 重新注册（如 fork 到新位置）必须更新 dir
    this.db.run(
      "INSERT INTO cores (id, name, dir) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, dir = excluded.dir",
      [id, name, dir],
    );
  }

  /** 删除 core 记录（目录已被删时的清理）。 */
  removeCore(id: string) {
    this.db.run("DELETE FROM cores WHERE id = ?", [id]);
  }

  getUiCore(): string | null {
    const row = this.db.query("SELECT value FROM ui_state WHERE key = 'ui_core'").get() as
      | { value: string }
      | null;
    return row?.value ?? null;
  }

  setUiCore(id: string) {
    this.db.run("INSERT OR REPLACE INTO ui_state (key, value) VALUES ('ui_core', ?)", [id]);
  }
}
