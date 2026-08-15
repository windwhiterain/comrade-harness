import type { ClientMsg, CoreInfo, ServerMsg, SnapshotResponse } from "../../shared/protocol";

/**
 * 驾驶舱外壳 —— 不可扩展的固定件。
 * 只与 daemon 通信；core 的内容永远只进 iframe（跨源隔离）。
 * 控制操作（reload/commit/回滚/fork）走 REST 拿错误反馈；实时状态走 WS。
 */
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const connDot = $("#connDot");
const connText = $("#connText");
const coreList = $("#coreList");
const commitList = $("#commitList");
const commitBtn = $("#commitBtn") as HTMLButtonElement;
const importCoreBtn = $("#importCoreBtn") as HTMLButtonElement;
const frame = $("#frame") as HTMLIFrameElement;
const reloadUiBtn = $("#reloadUiBtn") as HTMLButtonElement;

let cores = new Map<string, CoreInfo>();
let uiCoreId: string | null = null;
let selectedCore: string | null = null;
let ws: WebSocket | null = null;
let retry = 0;

function token(): string {
  return sessionStorage.getItem("cockpitToken") ?? "";
}

/** REST 调用：daemon 设置了 COCKPIT_TOKEN 时自动带 Bearer；401 且没存过令牌 → 提示输入一次。 */
async function api(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const t = token();
  if (t) headers.set("authorization", `Bearer ${t}`);
  let r = await fetch(path, { ...init, headers });
  if (r.status === 401 && !t) {
    const entered = prompt("驾驶舱需要访问令牌（daemon 的 COCKPIT_TOKEN）:");
    if (entered) {
      sessionStorage.setItem("cockpitToken", entered);
      headers.set("authorization", `Bearer ${entered}`);
      r = await fetch(path, { ...init, headers });
    }
  }
  return r;
}

async function control(path: string): Promise<void> {
  const r = await api(path, { method: "POST" });
  const res = await r.json().catch(() => ({}));
  if (!res.ok) alert(`操作失败: ${res.error ?? r.status}`);
}

function send(msg: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function connect() {
  // 先探一次鉴权：需要令牌时在连接 WS 前就提示（WS 升级失败没有可读的状态码）
  if (!token()) {
    try {
      const r = await fetch("/api/health");
      if (r.status === 401) {
        const t = prompt("驾驶舱需要访问令牌（daemon 的 COCKPIT_TOKEN）:");
        if (t) sessionStorage.setItem("cockpitToken", t);
      }
    } catch {}
  }
  ws = new WebSocket(`ws://${location.host}/ws${token() ? `?token=${encodeURIComponent(token())}` : ""}`);
  ws.onopen = () => {
    retry = 0;
    connDot.className = "dot green";
    connText.textContent = "已连接";
  };
  ws.onclose = () => {
    connDot.className = "dot red";
    connText.textContent = "重连中…";
    const delay = Math.min(10000, 1000 * 2 ** retry++);
    setTimeout(connect, delay);
  };
  ws.onmessage = (ev) => handle(JSON.parse(ev.data as string) as ServerMsg);
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "hello":
      cores = new Map(msg.cores.map((c) => [c.id, c]));
      uiCoreId = msg.uiCoreId;
      // 刷新/重连后 selectedCore 归零，但 UI core 持久化在 daemon——选中态跟随它恢复（否则选中框消失而 iframe 还在）
      if (!selectedCore || !cores.has(selectedCore)) {
        selectedCore = uiCoreId ?? null;
        if (selectedCore) loadCommits(selectedCore);
      }
      render();
      break;
    case "swap":
      if (cores.has(msg.id)) {
        cores.set(msg.id, { ...cores.get(msg.id)!, port: msg.port, url: msg.url, status: "healthy" });
      }
      render();
      if (uiCoreId === msg.id) applyUiCore(msg.id);
      break;
    case "ui_core":
      uiCoreId = msg.id;
      // 选中跟随 UI core：跨标签页切换 / 删除回退时，选中框与 iframe 保持一致
      selectedCore = msg.id;
      if (msg.id) {
        applyUiCore(msg.id);
        loadCommits(msg.id);
      } else {
        frame.src = "about:blank";
      }
      render();
      break;
  }
}

function applyUiCore(id: string) {
  const c = cores.get(id);
  if (!c?.url) return;
  const next = `${c.url}?boot=${Date.now()}`;
  if (frame.src !== next) frame.src = next; // URL 变了才重载（换血/切换），状态刷新不闪
}

function render() {
  coreList.textContent = "";
  const all = [...cores.values()];
  if (all.length === 0) {
    const hint = document.createElement("li");
    hint.className = "muted";
    hint.textContent = "没有 core —— 右键卡片可 fork 一个，或用「导入」接入已有 core";
    coreList.append(hint);
  } else {
    for (const c of all) coreList.append(coreCard(c));
  }
  if (uiCoreId) applyUiCore(uiCoreId);
  const ui = uiCoreId ? cores.get(uiCoreId) : undefined;
  reloadUiBtn.disabled = !ui || ui.status !== "healthy";
  reloadUiBtn.title = "蓝绿重载当前 UI core";
  commitBtn.disabled = !selectedCore;
  commitBtn.title = "给选中 core 打 commit（git 提交，可回滚）";
}

function coreCard(c: CoreInfo): HTMLElement {
  const li = document.createElement("li");
  li.className = "core" + (c.id === selectedCore ? " selected" : "") + (c.template ? " tpl" : "");

  // 卡片只显示名字；操作（重载/fork/删除）收进右键菜单
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = c.template ? `📦 ${c.name}` : c.name;
  li.append(name);

  // 模板标识：让用户知道这是项目内置 core（参考实现）。仅此而已——行为与普通 core 完全平等：
  // 可修改、可 reload、可 commit、可删除（2026-08-16 定案：模板特判已废除，只剩标识）。
  if (c.template) {
    li.title = "📦 模板 core（项目内置参考实现）· 点击使用";
  }

  // 点击卡片 = 选中 + 设为 UI core（中间区直接显示它的页面）
  li.onclick = () => {
    selectedCore = c.id;
    send({ type: "set_ui_core", id: c.id });
    render();
    loadCommits(c.id);
  };
  // 右键 = 操作菜单（浏览器默认菜单用我们自己的替代）
  li.oncontextmenu = (e) => {
    e.preventDefault();
    openCoreMenu(c, e.clientX, e.clientY);
  };
  return li;
}

// ---- 右键菜单：卡片只显示名字，重载/fork/删除都收在这里 ----
let menuEl: HTMLElement | null = null;

function closeCoreMenu() {
  menuEl?.remove();
  menuEl = null;
}

function openCoreMenu(c: CoreInfo, x: number, y: number) {
  closeCoreMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  const head = document.createElement("div");
  head.className = "ctxhead";
  head.textContent = `${c.status}${c.port ? ` · :${c.port}` : ""}${c.sha ? ` · ${c.sha.slice(0, 7)}` : ""}`;
  menu.append(head);
  const item = (label: string, danger: boolean, fn: () => void) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.onclick = () => {
      closeCoreMenu();
      fn();
    };
    menu.append(b);
  };
  // 重载只在右上角按钮（重载当前 UI core），右键不重复提供
  // fork 不改源：任意 core 都可以 fork 作来源
  item("fork", false, () => askFork(c.id, c.name));
  item("删除", true, () => deleteCore(c.id, c.name));
  document.body.append(menu);
  // 钳制在视口内，避免超出屏幕
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  menuEl = menu;
}

/** 删除 core（不可逆）：终止进程，目录与全部 git 历史、聊天数据库一并移除 */
function deleteCore(id: string, name: string) {
  if (
    !confirm(`删除 core「${name}」？\n将终止它的进程，并永久删除目录（含全部 git 历史）和聊天数据库，不可恢复。`)
  )
    return;
  api(`/api/delete/${id}`, { method: "POST" })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) alert(`删除失败: ${res.error}`);
      else if (selectedCore === id) {
        // 删除的是当前选中：清掉 commit 列表，core 列表由 daemon 广播的 hello 刷新
        selectedCore = null;
        commitList.textContent = "";
      }
    })
    .catch((err) => alert(`删除失败: ${err}`));
}

// 菜单关闭：点别处 / Esc / 右键点非卡片区域（卡片自身的右键会先开新菜单，这里跳过）
document.addEventListener("click", closeCoreMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCoreMenu();
});
document.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest?.("li.core")) closeCoreMenu();
});

async function loadCommits(id: string) {
  const r = await api(`/api/snapshots/${id}`);
  if (r.ok) {
    const data = (await r.json()) as SnapshotResponse;
    renderCommits(id, data);
  }
}

function renderCommits(id: string, data: SnapshotResponse) {
  if (id !== selectedCore) return;
  commitList.textContent = "";
  // 顶部状态行：当前工作树是否有未提交修改（与提交记录同一次请求，保证新鲜）
  const status = document.createElement("li");
  status.className = data.dirty ? "commit dirty" : "commit clean";
  status.textContent = data.dirty ? "● 有未提交修改" : "✓ 工作区干净";
  commitList.append(status);
  const list = data.list;
  if (list.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "还没有提交记录";
    commitList.append(li);
    return;
  }
  for (const s of list) {
    const li = document.createElement("li");
    li.className = "commit";
    const msg = document.createElement("div");
    msg.className = "msg";
    msg.textContent = s.message;
    const meta = document.createElement("div");
    meta.className = "ts";
    meta.textContent = `${s.sha.slice(0, 7)} · ${new Date(s.ts).toLocaleString()}`;
    li.append(msg, meta);
    li.onclick = () => {
      // 回滚会丢弃工作区未提交改动（旧状态仍在 reflog）
      if (confirm(`回滚到 ${s.sha.slice(0, 7)}？将丢弃工作区未提交改动（旧状态仍在 reflog）。`)) {
        void control(`/api/rollback/${id}?sha=${encodeURIComponent(s.sha)}`);
      }
    };
    commitList.append(li);
  }
}

commitBtn.onclick = () => {
  if (!selectedCore) return;
  const msg = prompt("commit 信息:", "手动提交");
  if (msg === null) return;
  void (async () => {
    await control(`/api/snapshot/${selectedCore}?message=${encodeURIComponent(msg)}`);
    if (selectedCore) loadCommits(selectedCore); // 打完 commit 刷新列表
  })();
};
importCoreBtn.onclick = () => {
  const dir = prompt("导入 core 的目录路径（需包含 src/index.ts）:", "");
  if (!dir?.trim()) return;
  void (async () => {
    const r = await api("/api/import-core", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: dir.trim() }),
    });
    const res = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; warning?: string; core?: CoreInfo };
    if (res.ok) alert(`导入成功: ${res.core?.name ?? res.core?.id}${res.warning ? `\n⚠️ ${res.warning}` : ""}`);
    else alert(`导入失败: ${res.error ?? r.status}`);
  })();
};
reloadUiBtn.onclick = () => {
  if (uiCoreId) void control(`/api/reload/${uiCoreId}`);
};

/** 问名字/位置并 fork（卡片 fork 按钮与右键菜单共用）。
 *  fork 直接基于源的最新提交：源有未提交修改时先弹确认（新 core 不会包含这些改动）。 */
async function askFork(srcId: string, srcName: string) {
  const name = prompt(`fork ${srcName} → 新 core 名字（小写字母/数字/连字符）:`, `${srcName}-fork`);
  if (!name) return;
  // 位置可选：留空 = 默认 ~/.comrade-harness/cores（项目外，不被项目 git 跟踪）
  const dir = prompt(`新 core 的位置（绝对路径，留空用默认）:`, "") ?? "";
  // 拿源的最新 dirty 状态（cores map 是 hello 广播的，可能过期；重拉一次保证新鲜）
  try {
    const r = await api("/api/cores");
    if (r.ok) {
      const fresh = (await r.json()) as CoreInfo[];
      for (const c of fresh) cores.set(c.id, c);
      const src = fresh.find((c) => c.id === srcId);
      if (src?.dirty) {
        if (
          !confirm(
            `源 core「${srcName}」有未提交修改。\n\nfork 直接基于最新提交，新 core 将不包含这些改动。\n仍要 fork 吗？`,
          )
        )
          return;
      }
    }
  } catch {} // 刷新失败不阻塞：daemon 的 fork 响应里也会带 warning
  const params = new URLSearchParams({ name });
  if (dir.trim()) params.set("dir", dir.trim());
  api(`/api/fork/${srcId}?${params}`, { method: "POST" })
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) alert(`fork 失败: ${res.error}`);
      else if (res.warning) alert(`fork 完成（注意：${res.warning}）`);
    })
    .catch((err) => alert(`fork 失败: ${err}`));
}

// ---- 侧栏：拖拽调宽 + 折叠成窄 bar（点标题折叠、点 bar 展开），状态存 localStorage ----
const layoutEl = $(".layout");
const sidePane = $("#sidePane");
const resizer = $("#resizer");
const collapseHead = $("#collapseHead");
const MIN_PANE = 160;
const MAX_PANE = 600;
let paneW = 260;
let collapsed = false;

try {
  const w = parseInt(localStorage.getItem("cockpit.paneW") ?? "", 10);
  if (Number.isFinite(w) && w >= MIN_PANE && w <= MAX_PANE) paneW = w;
  collapsed = localStorage.getItem("cockpit.paneCollapsed") === "1";
} catch {}

function setPaneW(w: number) {
  paneW = Math.max(MIN_PANE, Math.min(MAX_PANE, Math.round(w)));
  layoutEl.style.setProperty("--pane-w", `${paneW}px`);
  try { localStorage.setItem("cockpit.paneW", String(paneW)); } catch {}
}

function setCollapsed(v: boolean) {
  collapsed = v;
  layoutEl.classList.toggle("collapsed", v);
  try { localStorage.setItem("cockpit.paneCollapsed", v ? "1" : "0"); } catch {}
}

setPaneW(paneW);
setCollapsed(collapsed);

resizer.addEventListener("mousedown", (e) => {
  e.preventDefault();
  document.body.classList.add("resizing");
  const startX = e.clientX;
  const startW = paneW;
  const move = (ev: MouseEvent) => setPaneW(startW + ev.clientX - startX);
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing");
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
});

// 点 "cores" 标题折叠（标题里的按钮除外）；折叠后的窄 bar 点击展开
collapseHead.onclick = (e) => {
  if ((e.target as HTMLElement).closest("button")) return;
  setCollapsed(!collapsed);
};
sidePane.addEventListener("click", (e) => {
  if (collapsed && (e.target as HTMLElement).closest(".bar")) setCollapsed(false);
});

connect();
