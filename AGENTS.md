# AGENTS.md — comrade-harness 开发手册

> 给接手开发的 agent：这份手册的目标是让你在**没有对话历史**的情况下理解这个项目——
> 它是什么、为什么存在、怎么跑、改哪里、哪里不能碰、前人踩过什么坑。

---

## 0. 一句话定位

**后现代 harness 的活体证明：agent 时代，纯代码包组合优于传统插件系统。**

- 不是"插件自由"，而是**根本没有插件这一层**：系统里不存在插件注册表、技能 DSL、能力配置 schema。
- 可进化部分全部是**普通代码包**（`cores/` 下的目录，就是普通的 Bun/TS 服务）。**每个 core 自包含、互不依赖**：standard 是完整 agent harness 的**模板**（LLM 客户端 + 工具集 + agent loop + UI 全在一个包里；本身不运行，fork 出的 core 运行这份代码）。
- 固定部分刻意最小、最笨、不可扩展：daemon + 驾驶舱外壳 + standard 模板库。
- **元循环**（已实现）：standard 是 📦 不可运行的模板库（只作为 fork 来源），`fork_core` 复制出的新 core 自带完整 harness，它的 agent 能修改任何 core——**包括运行它自己的那个**。改完自己 reload 后继续用新代码工作。这是整个设计真正想证明的事。

---

## 1. 进程模型与两条铁律

```
┌──────────────── 浏览器 ────────────────┐
│ 驾驶舱外壳(固定,不可扩展,只连 daemon)    │
│ [cores 列表] [快照/回滚] [重载]          │
│ ┌───────────────────────────────────┐  │
│ │ iframe ← 当前 UI-core 的页面       │  │
│ │ (普通 HTML/CSS/JS,随时可能坏)      │  │
│ └───────────────────────────────────┘  │
└────────────┬──────────────┬────────────┘
             │ 控制 WS(不朽) │ iframe(可死,换血重载)
      ┌──────▼──────┐   ┌────▼───────────────┐
      │ daemon      │◀─▶│ core(s)           │
      │ spawn/健康/  │   │ standard📦        │
      │ 转发/存储/git│   │  (模板:不运行,    │
      └─────────────┘   │   仅 fork 来源)   │
                        └───────────────────┘
```

**两条铁律（任何改动不得违背）：**

1. **daemon 是唯一不死进程。** 壳连接它永不掉线；core 进程可被任意替换。
2. **事实来源只有两个：daemon 的 SQLite（`data/harness.db`）和 cores 的 git 仓库。** 其他一切（进程、iframe、内存）都是可丢弃的。

**core 的运行契约（约定，不是 API）：** daemon 注入环境变量 `PORT / CORE_ID / CORE_DIR / DB_PATH / DAEMON_URL / CORES_DIR`（`CORE_DIR` 是本 core 的实际目录，fork 出的 core 可能在项目外），core 必须提供 `GET /health → 200`。其余完全自由——core 就是一个普通 Bun 服务，没有任何插件 API。

---

## 2. 目录与文件地图

```
comrade-harness/
├─ AGENTS.md               ← 你正在读的
├─ README.md               ← 面向人类的文档（含 mermaid 架构图）
├─ package.json            scripts: crh / dev / build:shell / typecheck；bin: crh → cli/crh.ts
├─ .gitmodules             cores/standard + cores/dsh-minimal 的 submodule 注册（URL → GitHub）
├─ tsconfig.json           daemon+cores 的 TS 配置（types: bun, 无 DOM）
├─ .env.example            LLM 配置样板（Bun 自动加载 .env）
├─ cli/
│  └─ crh.ts               ★ crh 命令行入口（bun run crh web；全局安装的 bin）：子模块初始化 +
│                            根依赖 + 构建壳 + 前台起 daemon（安装模式细节见 §2 一键安装）
├─ shared/
│  └─ protocol.ts          ★ 唯一稳定契约：控制面协议 v6
│                          （CoreInfo / ClientMsg / ServerMsg / CoreEnv）
├─ daemon/                 唯一长驻进程（Bun/TS，零运行时依赖）
│  └─ src/
│     ├─ main.ts           ★ 入口：HTTP+WS 服务、壳静态托管、REST 控制面、
│     │                      聊天转发(relayChat)、默认 UI core、discover(store 恢复)
│     ├─ supervisor.ts     ★ 蓝绿监督器：registerCore/discover、spawn(重试3次)、
│     │                      waitHealth、swap、retireLater(轮询 busy 退役)、
│     │                      reload/snapshot/rollback/fork(任意位置)
│     ├─ store.ts          bun:sqlite：cores 表（UPSERT，dir 记录任意位置）+ ui_state 表
│     └─ git.ts            snapshot / rollback / head / log（spawnSync git）
├─ shell/                  驾驶舱外壳（vanilla TS，无框架）
│  ├─ index.html           布局：左 cores 列表（可拖拽调宽/折叠成 bar），中 iframe
│  ├─ app.css              深色驾驶舱风格
│  └─ src/app.ts           ★ 壳逻辑：WS 重连、卡片(仅名字)+右键菜单(重载/fork/删除)、
│                            点击卡片=设为UI、commit/回滚、模板卡片显示且只能 fork、
│                            侧栏拖拽调宽 + 折叠(状态存 localStorage)、iframe 防闪
├─ cores/                  ★★ 被 agent 重写的世界（standard 与 dsh-minimal 都是根仓库的 git submodule，见 .gitmodules）
│  ├─ standard/            📦 模板库 = **一个数据流**（自包含，不依赖其他 core；可运行：参考实现/迁移源）
│  │  ├─ src/index.ts      ★ 数据流 = lib 的 standardFlow 一行（子图分层定制见 §4.3：选项 → hooks → 整层换函数 → 手拼）
│  │  └─ public/           UI 覆盖层（空壳 + README；对话 UI 资产在 lib 的 ui/ 目录，同名文件放这里即覆盖）
│  └─ dsh-minimal/         📦 极简模式 core（模板）= standard 的活体变体（deepseek-harness minimal preset；可运行）
│     ├─ src/index.ts      system prompt = 纯 PERSONA_TEXT（"You are a helpful software engineer
│     │                    assistant."，恰好一句、零注入——过拟合保护，别拼 buildSystemPrompt）；
│     │                    工具同样只有极简双工具（bash + str_replace_editor），不拼 toolsCore——
│     │                    lib 控制工具的描述对模型也是"别的 prompt"，混入会破坏过拟合的极简行为
│     ├─ public/           （fork 自 standard，UI 同款）
│     └─ package.json      依赖 comrade-harness-lib + dsh-minimal 库（本地 local:on 切 link）
└─ data/                   (gitignore) harness.db + cores/*.db
```

**外部仓库（GitHub 上，被本项目依赖/消费）：**

```
github.com/windwhiterain/comrade-harness-lib       ★★ harness 节点库（包名 comrade-harness-lib）
│  index.ts（入口）/ nodes.ts（节点）/ flow.ts（子图：loadContext/agentLoop/saveTurn/standardFlow）/ llm.ts / tools.ts / memory.ts / runtime.ts（HTTP 壳）/ types.ts（契约）/ ui/（默认对话 UI 三件套）
└─ 依赖方式：core 的 package.json 提交 **git 依赖 + commit id**（如 "github:windwhiterain/comrade-harness-lib#2e0ba22…"，
   **不用 tag**——tag 被 force amend 移动后 bun 不感知，lock 永远锁旧 sha，fork 出的 core 静默装旧代码，真实踩过；
   commit id 不可变，package.json 与 bun.lock 天然一致，即使 fork 复制旧 lock，bun install 也按 package.json 的 id 拉正确版本）。
   任何机器 clone 后 bun install 直接拉 GitHub，无需本地注册（fork 也能跑）。
   本地开发用 gitignored 的 local.override.json 覆盖依赖解析（2026-08-16 起，取代 package.local.json/skip-worktree）：
   `cd cores/standard && bun run local:on` 生成 marker（依赖名 → 本地路径，从 local.override.json.example 复制）
   并 install；package.json 的 postinstall 钩子（scripts/local-link.ts）每次 install 后把列出的依赖链成
   junction/符号链接——package.json 始终保持 git 依赖（提交版即运行版，无切换、无 skip-worktree），改 lib
   即时生效、类型检查走本地代码；`local:off` 删 marker 还原 GitHub 安装。fork/他人机器无 marker → 钩子 no-op。

github.com/windwhiterain/comrade-harness-standard  ★ standard core 的远端（submodule 的 URL）
└─ 项目内 cores/standard 是根仓库的 **git submodule**（.gitmodules 注册，gitlink 钉住版本；
   本地路径就是 cores/standard，改它 = 在 cores/standard 里提交 + 根仓库 bump gitlink）

github.com/windwhiterain/comrade-harness-dsh-minimal  ★ dsh-minimal core 的远端（submodule 的 URL）
└─ 项目内 cores/dsh-minimal 是根仓库的 **git submodule**（与 standard 同形态：目录内完整 .git）。
   它是极简模式 core：依赖 dsh-minimal 库（github:windwhiterain/dsh-minimal#<commit id>，本地 local:on 切 link）。
   fork 出的用户 core 也能 fork 它。模板识别没有标记文件：目录位于项目 cores/（搜索路径）下的 core 即模板（见 §4.4）。
```

**发布工作流（2026-08-15 定案；2026-08-16 起自动化）**：四个 GitHub 仓库（root/lib/standard/dsh-minimal 库）都压平为**单 commit v0.1.0**（tag 同名）。**后续更新一律直接 `git commit --amend` 到 v0.1.0 + force push main 与 tag**——不新建 commit、不 bump 版本。dsh-minimal core 仓库（comrade-harness-dsh-minimal）同规则。涉及 submodule 时先改并 push submodule，根仓库 amend 更新 gitlink 再 push。**amend lib 或 dsh-minimal 库后必须同步**：把新 commit sha 写进两个模板（cores/standard、cores/dsh-minimal）的 package.json（git 依赖是 commit id，不更新则 fork 出的 core 锁旧 id），`bun install` 刷新 bun.lock 后随模板一起 amend 提交。**发布自动化**：根仓库 `bun run publish [--dry-run] [版本号]`（scripts/publish.ts）一步完成——按 lib → 模板 → 根顺序，每个仓库自动备份分支（backup/pre-amend-<时间戳>，保住 force push 前的旧 commit）→ **只 amend HEAD（最后一条 commit），绝不 squash 历史**——想正式添加 commit 直接加，publish 不会压掉它（工作树改动并进 HEAD；干净但有未推送 commit 时直接推送不 amend）→ tag -f（v0.1.0 标记发布尖端）→ force push，只发有改动的仓库；lib 发布后自动把新 sha 同步进模板 package.json 并 install。**可选版本号**（如 `bun run publish v0.2.0`）：四个仓库（含无改动的）在各自当前 HEAD 打上新 tag 并推送——版本 tag 是发布快照标记，v0.1.0 继续作为滚动尖端。`--dry-run` 预览。

**fork 出的用户 core 默认放 `~/.comrade-harness/cores/<name>`**（项目外，不被项目 git 跟踪），也可用 `dir` 参数指定任意绝对路径。daemon 重启后从 store（cores 表存了每个 core 的 dir）恢复它们。**daemon 在 spawn 每个 core 前自动 `bun install`**（依赖已满足时 ~100ms），所以 fork 后/换机器后无需手动装依赖。

**一键安装（2026-08-16 落地，Cargo install 风格）**：`bun install -g github:windwhiterain/comrade-harness` 后，任意目录直接 `crh web`。package.json 的 `bin` 入口（crh → cli/crh.ts），首次运行自动补齐三件事：① 模板子模块——bun 的 git 安装不拉 submodule、克隆不带 .git（实测），`crh web` 先试 `git submodule update --init`（仓库检出路径），失败则按 .gitmodules 逐个 `git clone`（取远端默认分支 = 发布版本），**克隆多形态（2026-08-16）**：探测 `ssh -T git@github.com`（项目无关，任何配了 key 的账号都能 SSH 读公开仓库）——有 key 则 SSH(22) → HTTPS(443) → SSH-over-443(ssh.github.com) 依次尝试，没 key 只走 HTTPS，探测不明则 HTTPS 优先 SSH 兜底；每形态 2 次 + 60s 超时，publickey 拒绝自动跳过剩余 SSH 形态；② 根依赖（node_modules 缺失时 `bun install`——daemon 本身零依赖，装的是 typescript/@types/bun）；③ 壳构建（shell/dist 是 gitignored，每次启动时构建）。**数据目录**：开发模式（cwd 在仓库内）= 仓库 `data/`（与旧 `bun run dev` 一字不差）；安装模式（cwd 在仓库外）= `~/.comrade-harness/data`；daemon 侧新增 `CRH_DATA_DIR` 环境变量覆盖（main.ts 的 DATA_DIR 解析）。LLM 配置放**运行目录**的 .env 或系统环境变量——bun 在启动目录自动加载 .env，crh 把 process.env 原样透传给 daemon。
**更新陷阱（bun 上游 bug #20647/#32757，本机实测）**：`bun install -g` **首次安装正常**，但同一包名**重装**（发布工作流 amend + force push 后用户再跑 install）报 `has a dependency loop`（全局 manifest 追加重复根依赖）。解法：`bun remove -g comrade-harness && bun install -g github:windwhiterain/comrade-harness`。`bunx github:windwhiterain/comrade-harness` 是免安装的一次性入口（同样要求远端有 bin）。
**Windows PATH 注意（实测）**：全局 `crh` 是 bun 的 bin shim，需要 **bun.exe 在 PATH**——npm 方式装 bun 的机器 PATH 里只有 bun.cmd（`%APPDATA%\npm`），直接跑 `crh` 报 "bun is not installed in %PATH%"；把 bun.exe 所在目录（`%APPDATA%\npm\node_modules\bun\bin`）加进 PATH 即可。官方安装方式（bun.exe 在 `~/.bun/bin` 且已在 PATH）无此问题。`bun run crh web`（仓库内）不受影响。

---

## 3. 开发命令（Windows / Git Bash）

```bash
cd /c/resource/comrade-harness
git submodule update --init    # 首次 clone 后拉 cores/standard（= comrade-harness-standard 的 checkout）
bun install                    # 只有 typescript + @types/bun 两个 devDeps
cp .env.example .env           # 填 LLM_API_KEY（或直接用环境变量 DEEPSEEK_API_KEY）
bun run crh web                # 启动驾驶舱 = 构建壳 + daemon 前台运行（bun run dev 是同义别名）
bun run build:shell            # 只构建壳（crh web 内部也会做）
bun run typecheck              # 两个 tsconfig 都查（根 + shell）
```

**git 提交：涉及哪个仓库提交哪个（cores/ 根目录不是仓库；cores/standard 是 submodule）**

```bash
git add -A && git commit ...                       # 根仓库：daemon/shell/docs 等
cd cores/standard && git add -A && git commit ...  # standard 仓库（改组装/UI 时）
cd .. && git add cores/standard && git commit -m "chore: bump standard"  # 根仓库记录新版本
cd /c/resource/comrade-harness-lib && git add -A && git commit ...      # harness 组件库（改组件时）
```

**reload 不自动快照**（2026-08-15）：reload 验证的就是工作树上的未提交改动——改完代码直接 reload 是常态，不产生 auto commit；回滚本来就会丢弃未提交改动，何时 commit 由用户自己决定（commit 按钮 + dirty 显示）。改 standard 的代码需重启 daemon 生效；改动只影响**之后** fork 出的新 core。改了 harness 组件库后，**重启 daemon** 让所有 core 用新组件（core 的 link 是符号链接，启动时解析到最新代码）。

**REST 控制面（curl 可测）：**

| 端点 | 作用 |
|---|---|
| `GET /api/health` | daemon + cores 状态 + uiCoreId |
| `GET /api/cores` | core 列表（id/status/port/sha/dirty/template） |
| `POST /api/reload/<id>` | 蓝绿重载，**始终等待**结果返回 `{ok,error}` |
| `POST /api/snapshot/<id>?message=` | git 快照（per-core：只提交该 core 的仓库；**模板拒绝**——不是你的资产，要修改先 fork） |
| `POST /api/rollback/<id>?sha=` | 回滚 + 重载（per-core：只回滚该 core） |
| `GET /api/snapshots/<id>` | `{dirty, list}`：dirty = 工作树是否有未提交修改；list = 该 core 自己仓库的 git log |
| `POST /api/fork/<src>?name=<new>&dir=<abs>` | git clone 源 core 为新 core（全历史，**直接基于源的最新提交，不自动快照**；源有未提交修改时响应带 `warning` 明说）并启动；dir 缺省 `~/.comrade-harness/cores`（项目外）；成功后广播 hello |
| `POST /api/set-ui/<id>` | 切换 UI core（模板也可以——模板可运行） |
| `POST /api/delete/<id>` | 永久删除 core（2026-08-15）：终止进程 + 删目录（含全部 git 历史）+ 删聊天 DB，不可恢复；删的是当前 UI core 时自动回落到第一个可用 core（没有则 UI core 置空，**不自动 fork**——core 是用户资产，创建由用户显式决定）；成功后广播 hello |
| `POST /api/chat` | 向 core 的 agent 转发消息，**同步返回最终回复**（`{ok, reply}`）；带 `Accept: text/event-stream` 则返回 SSE 流（think/tool/toolResult/delta/done，实时流出）；body `{message, core?, session?}`，core 缺省当前 UI core（standard 是模板，不可运行），session 透传给 core（core 内的会话 id，缺省 default） |
| `POST /api/abort/<id>` | 终止指定 core 的当前 agent 任务（转发到 core 自己的 `/api/abort`；幂等，无任务返回 `aborted:false`） |
| `GET /ws` | 控制面 WebSocket（壳用） |

**方法约束与鉴权**：除 `GET /api/health`、`GET /api/cores`、`GET /api/snapshots/<id>` 外，控制面一律要求 **POST**（GET 会被浏览器/图片标签跨站触发，即 CSRF）。daemon 设置 `COCKPIT_TOKEN` 后，**所有 `/api/*` 与 `/ws`** 都要求 `Authorization: Bearer <token>`（或 URL `?token=`）；壳和 standard 对话 UI 在 401 时自动提示输入并记住（浏览器 sessionStorage）。token 同时传播给 core（core 的 `/api/*` 同样校验，`/health` 保持开放供健康检查）。不设 token = 完全开放，只应在可信网络使用。

**LLM 配置**：`LLM_API_KEY`（或 `DEEPSEEK_API_KEY`）/ `LLM_BASE_URL`（默认 api.deepseek.com）/ `LLM_MODEL`（默认 deepseek-chat）。brain 的 `llm.ts` 读这些。provider 目录（`~/.agents/models.json`）之外，常见 Key 环境变量（DEEPSEEK/OPENAI/MOONSHOT/ZHIPUAI/DASHSCOPE/GEMINI/GROQ/OPENROUTER/XAI/MISTRAL/TOGETHER 的 `*_API_KEY`，及 legacy `LLM_API_KEY`）会自动配成一个 provider，相同 base_url 的配置文件条目优先。

**局域网访问**：daemon 和 core 都监听 `0.0.0.0`，但暴露给浏览器/壳/core 页面的 URL 默认带 `127.0.0.1`（其他设备打开 iframe 会指向它们自己的回环地址）。`PUBLIC_HOST` 环境变量可覆盖（如 `PUBLIC_HOST=192.168.2.254`）；留空则 daemon 启动时自动探测本机局域网 IPv4。Windows 防火墙需放行 3800 及 core 端口（`netsh advfirewall firewall add rule ...`）。

---

## 4. 关键机制（改之前必须懂）

### 4.1 蓝绿重载（supervisor.ts）

```
reload(id):
  ① 模板拒绝（📦 不运行；普通 core 无任何守卫）
  ② busy 互斥（同 core 并发 reload 拒绝）
  ③ 门禁: bunx tsc --noEmit（失败 → 返回 error，旧进程不动）
  ⑤ spawn 新进程（freePort → Bun.spawn, 注入 env），失败自动换端口重试 3 次
  ⑥ 轮询 GET /health 最长 8s
  ⑦ swap：换血立即完成（广播 onSwap），旧进程交给 retireLater 后台退役
```

**退役死锁（最危险的历史教训，详见 §6.3）**：`swap()` 必须**同步返回**。旧进程的杀除在后台 `retireLater()` 做——轮询 `retireWait(id)`（daemon 侧 `activeRelays` 集合）直到该 core 的在途请求结束（上限 90s）再杀。**任何让 swap 等待"在途请求结束"的改动都会复活死锁。**

### 4.2 聊天链路（core 自包含，daemon 只转发）

```
UI core 应用聊天框（页面继承自模板）→ 自己的 /api/messages → 自己的 agent loop（同一进程，不经 daemon）
curl /api/chat        → daemon → 指定 core 的 /api/chat（body {message, core?, session?}，缺省当前 UI core）
```

- **core 之间互不依赖**：每个 core 自带 LLM 客户端 + agent loop + 工具（完整 harness）。聊天在各自进程内完成。
- **会话级单飞**（2026-08-15，多会话落地）：同一会话 busy → 409；不同会话可并行（流是纯 ctx 函数、记忆是会话视图，sqlite 语句级串行，会话内顺序由引用列表决定）。daemon 退役轮询的 `/api/status` busy = **任一会话**在忙（换血等所有在途任务说完）。
- 退役等待：daemon 换血后轮询**旧进程** `/api/status` 的 busy 字段，等它在途 agent 任务结束再杀（上限 90s）——聊天中 reload 不断话，自改自（元循环）能说完。
- `relayChat` 有 600s 超时。
- **流式输出**（2026-08-15，路线图第 3 项）：core 的 `/api/messages` 与 `/api/chat` 在请求带 `Accept: text/event-stream` 时返回 SSE 流——`think`（思考增量，deepseek-reasoner 实时上屏）/ `tool` / `toolResult`（工具调用与结果实时建卡）/ `delta`（最终回复逐字）/ `done`（收尾，携带完整回复）事件，流代码用 `ctx.emit` 发射（runtime 恒注入，JSON 模式是 no-op，流写不写都不影响）；不带 Accept 头 = 与原来完全一致的同步 JSON。`busy` 覆盖整个流（flow 结束才释放），流式聊天中 reload 依旧等说完再退役；客户端断开只停推送，flow 照常跑完（历史照存）。daemon 转发也透传 SSE（旧 core 不支持时包装成单条 `done` 事件）。
- **多会话**（2026-08-15，路线图第 5 项）：core 的 SQLite 记忆从"单线性表"升级为**消息池（messages，只追加，内容唯一储存）+ 会话（sessions）+ 有序引用列表（session_messages）**——共享靠引用而非结构，前缀/中间/后缀消息都能被任意会话引用，fork 会话（`POST /api/sessions {name, fork}`）只复制引用、内容零复制；删除/截断/删会话都是"删引用"，消息行留在池里（孤儿，可恢复），彻底清除留给将来的 purge。**流代码零改动**：`ctx.memory` 是会话视图（`MemoryStore` 接口不变），runtime 按请求的 `session` 参数（缺省 `default` = 无 session 请求的兼容锚点，旧 UI/curl 行为一字不变）解析；自定义纯 `MemoryStore`（如 `sqliteMemory`）则退化为单会话（无会话 API）。端点：`GET/POST /api/sessions`、`POST /api/sessions/delete`（**运行中（busy）的会话拒绝删除**——409，flow 结束时还会往它的引用列表写消息，删了留下脏状态；先 `POST /api/abort` 再删）、`GET /api/sessions/<id>/export`（JSONL，一行一条消息含 step）、`GET/POST /api/messages?session=`、`POST /api/messages/delete|truncate`（带 session）、`POST /api/abort {session}`（不带 = 停全部）。模板 UI 有**左侧会话栏**（类似壳的 cores 列表：点击切换、右键删除会话（default 也可删——它是"按需重建的锚点"：删光后无 session 请求会自动重建空 default 并回到列表）、＋新建（继承当前会话的 provider/model 设置）、可折叠成窄条，旧 core 无会话 API 时整栏隐藏）。**消息右键菜单五项**：分叉（从这条消息（含）复制引用出新会话，`POST /api/sessions {name, fork, at}`）/ 请求（以这条消息为最后一条**重新生成**回复：上下文截至它，不新增用户消息行、不依赖输入框，LLM 输入的最后一条 = 这条消息本身——`POST /api/messages {at, regen: true}`，回复插入其后、原后续消息保留；存储层中间插入重排 pos）/ 修改（copy-on-edit：新建消息行替换本会话引用，共享该消息的其他会话不受影响——`POST /api/messages/update`）/ 删除 / 截断。旧库自动迁移为 default 会话（messages 表形状不变）。
- **会话级模型记忆**（2026-08-15 引入；2026-08-16 修复"只显示不应用"）：`sessions` 表带 provider_id/model_id 列（ALTER 迁移）。`GET /api/models?session=` 该会话记过的模型优先，无记录回落 core 启动时的初始模型（`initialModel` 锚点——启动快照，不是被其他会话切换污染的"当前"）；`POST /api/models {providerId, modelId, session}` 带 session 落库、不带只切全局。**记录会应用到该会话的实际请求**（runtime 的 `llmFor(sid)`：会话有记录 → `selector.pinned(记录)` 固定构造该会话的 LLM，不污染全局、跨会话不串台、reload 后不丢；无记录/记录失效/自定义选择器无 pinned → 回落全局当前选中项——修复前 ctx.llm 是全局 selector，任意会话切模型全局串台、reload 后全体掉回目录第一个模型，实测踩过）。**新建/分叉会话继承当前会话的设置**（`POST /api/sessions {settingsFrom: <当前会话 id>}`，服务端复制 provider/model 列）——新会话与源会话用同一模型，不回落启动锚点。
- **逐步暂停 + 空消息**（2026-08-16）：输入框左侧「逐步暂停」toggle（UI 本地状态，随每条消息请求体 `pause` 字段同步到 core 的**会话级开关**——暂停中也能改，关了后面的步骤不再停）。开关开启时，agent 每完成一步（该轮思考+工具执行完、结果已进上下文）就暂停：SSE 流发 `pause` 事件并挂起（暂停期间每 30s 重发一次保活，防 Bun idleTimeout 剪长静默连接；UI 幂等处理）；UI 发送按钮变「继续 ⏵」+ 出现「停止」小按钮（暂停中 abort 立即终止，回复"（已停止）"）。用户输入消息回车/点继续 → 同一条 `/api/messages`（或 `/api/chat`）POST 唤醒暂停门（**busy 但暂停中 = 继续，不 409**；at/regen 拒绝）——文本非空则插入为一条 user 消息（落在两步之间，saveTurn 按序写库，历史与 LLM 上下文都可见），**空 = 只继续不插入**。实现：runtime 的 `pauseFor`（会话级暂停门 + abort 信号解门 + 心跳）+ `ctx.pause` 注入（agentLoop 每步收尾调用，开关没开立即返回零开销）。**空消息（同批）**：`/api/messages` 与 `/api/chat` 不再拒绝空文本——UI 发送空消息 = 一条空 user 消息（渲染「（空消息）」占位，进 LLM 上下文作"继续"轻推）；暂停中空消息 = 只继续不插入（见上）。daemon 的 `/api/chat` 转发带 `pause` 字段透传。**坑（实测）**：bun fetch 会把新 POST 复用进未完成的 SSE 连接（Bun.serve 同连接串行处理，POST 排队等流结束）——同进程内"SSE 流未结束时再 fetch 同 core"的继续请求会挂起，测试客户端因此改 node:http；浏览器/curl 每次新连接不受影响。
- **终止响应**（2026-08-15；工具可中断 2026-08-16）：UI 的发送按钮在流式进行中变"■ 停止"（复用同一元素，不新增实体），点击 → `POST /api/abort` → core 中断当前任务的 LLM 调用（`ctx.abortSignal` 注入，`llm.ts` 的 readSSE 每轮迭代检查；Bun 的 fetch 会把已缓冲 body 继续读完，必须主动检查否则 abort 形同虚设——真实踩过）→ **已生成的部分作为回复保存**（历史照常入库），流照常以 `done` 收尾，busy 随之释放。**正在执行的工具也会被终止**（2026-08-16 修复：此前工具是原子的"跑完这轮再停"——`run_cmd` 用 `Bun.spawnSync` 同步阻塞，命令执行期间整个 core 的事件循环被冻结，`/api/abort` 根本排不上队，停止按钮形同虚设）：`run_cmd` 改异步 `Bun.spawn` + 终止时杀进程树（Windows `taskkill /T /F`），daemon 类工具（reload/snapshot/fork）的 fetch 带 signal，`runTools` 在工具轮之间检查 signal 不再调度剩余工具；持久 bash 工具（dsh-minimal）的 `execute(args, signal)` 把终止信号接进轮询循环，终止时杀掉 shell 复位（Windows 上不能用 `spawnSync taskkill` 等 close 事件——MSYS bash 被杀后 close 会迟到命令自然结束，实测；用 `child.kill()` 即时触发 + 异步 taskkill 补刀进程树）。工具结果如实记录（"（已停止）命令被终止"），回复"（已停止）"。daemon 侧 `POST /api/abort/<id>` 转发。流式代码里 LLM 调用记得传 `{ signal: ctx.abortSignal }`，工具节点传 `ctx.abortSignal` 给 `runTools`。

### 4.3 节点 + 数据流（harness lib）

**三层**：资源（LLM / 记忆 / 工具 / UI / HTTP 壳——参数组合就够了，Claude/Codex 也能"加载资源"）、**节点**（层级 0，原语）、**子图**（层级 1，数据流片段）+ **标准流**（层级 2，默认组合）。

- **节点 = 普通函数**（`comrade-harness-lib/nodes.ts`）：`buildSystemPrompt`（提示词随 core 身份动态生成：standard🔒 强调不可改、fork 出的 core 强调可自改自）/ `loadHistory`（记忆：默认全量读出、不过滤不截断，显式 limit 才窗口化；step 行重建为标准 message——think → assistant 文本，tool → assistant.tool_calls + tool 角色消息对）/ `composeMessages` / `callLLM`（一次补全，失败抛出）/ `streamLLM` / `runTools`（执行 tool_calls，`done` 收尾）/ `saveHistory`。契约在 `comrade-harness-lib/types.ts`（普通 TS 接口，不是插件 API）。
- **子图 = 数据流片段**（`comrade-harness-lib/flow.ts`，2026-08-16 新增）：普通函数，用控制流把节点串成完整语义——`loadContext`（上下文子图：system + 全量历史 + 本条消息，含 regen 处理）/ `agentLoop`（LLM↔工具循环子图：SSE emit、abort「（已停止）」、步骤收集）/ `saveTurn`（记忆子图：user → step → agent 写回）。可独立使用、自由组合。
- **标准流**（`flow.ts` 的 `standardFlow`）：三个子图的默认组合，core 的 `src/index.ts` 一行 `standardFlow()` 即完整 harness——**lib 里依然没有任何隐藏的编排逻辑**，`createHarness({ flow, ...资源 })` 只是 HTTP 壳 + 资源注入。
- **自定义 = 逐层深入**（定制阶梯）：选项（换 `systemPrompt` / `load: { history: N }` 窗口）→ hooks（`loop.hooks.beforeTools` 工具拦截/审批、`loop.hooks.llmError` 吞错、`loop.llm` 换 LLM 节点）→ 整层换函数（load / loop / save 传函数）→ 手拼子图（`loadContext` 后插入节点再 `agentLoop`——如 LLM 前注入 RAG 上下文、工具结果后加反思）→ 用节点完全手写。替换点 = 旧注释「就换这行 / 就包这行」的位置。没有注册表、没有图结构、没有插件 API。
- 默认工具包（`tools.ts`）：`read_file / write_file / run_cmd / snapshot / reload / rollback / fork_core / core_info / done`；`bun`/`bunx` 前缀重写成 `process.execPath`（Windows 兼容）；提示词已写明 Windows 无 ps/ss、改完必须 tsc+reload、standard 不可更改、验证用 core_info + bun -e fetch。
- **bash 工具共享**（2026-08-15）：持久 bash（`createBashTool` / `bashPackage`，含 marker 协议/超时重置/输出裁剪）从 dsh-minimal 库上移到 lib（`bash.ts` + `terminal.ts` + `sanitize.ts`，单一定义源），dsh-minimal 与 standard 共用；`run_cmd` 内部也改走真 bash（`bash -c` + `translateWindowsPaths`）——`&&`/管道/重定向/通配符按 bash 语义，Windows 盘符路径（`C:/x`、`C:\x`）在 bash 解析前自动翻译成 `/c/x`（模型可见层零改动：描述/schema/错误格式/退出码逐字不动）。dsh-minimal 库依赖 lib（bash 部分 re-export，模型可见描述 `PRESET_DESCRIPTION` 单一定义源）。
- **工具工作区（两个根）**：读写路径以**本 core 自己的目录**（`CORE_DIR`，daemon 注入）为默认根——相对路径如 `src/index.ts` 指自己；其他 core 用 `<core id>/` 前缀（如 `standard/src/index.ts`），工具从 daemon `/api/cores` 拿 id→dir 映射，**无论该 core 在项目 cores/ 下还是 ~/.comrade-harness/cores/ 下都能读写**（2026-08-15 修复：此前工具只认项目 cores/，默认位置 fork 出的 core 的 agent 碰不到自己的代码，按提示词写 `echo/src/index.ts` 还会在项目里造出影子目录）；绝对路径限 core 目录内。`run_cmd` 在本 core 自己的目录里执行（检查自己 `bunx tsc --noEmit -p tsconfig.json`，检查项目内其他 core 用 `-p ../<id>/tsconfig.json`，项目外 fork 用绝对路径）。工具层没有任何 immutable 守卫——agent 就是开发者，改模板只靠提示词劝阻。
- **上下文注入**（路线图第 6 项；2026-08-16 默认改全量）：standard 的流默认**全量历史**进上下文——`loadHistory` 不过滤不截断（含 step 过程行，映射 assistant，见下条），每次消息不再是独立回合；想窗口化就显式传 `load: { history: N }`（最近 N 条），独立回合 `history: 0`。
- **过程步骤行**（2026-08-15 引入；2026-08-16 起全量进上下文）：standard 的流把每轮的思考片段与工具调用（名称/参数/结果）以 `role="step"` 的 JSON 行写进历史（`{type:"think"}` / `{type:"tool"}`），UI 渲染成可折叠卡片；**step 行也进 LLM 上下文**，按**标准 message 格式重建**——think 步 → assistant 文本消息；tool 步 → assistant.tool_calls（id = `step-<行id>`，arguments 原样 JSON）+ 紧随的 tool 角色消息（tool_call_id 对应，content = 工具结果）。工具痕迹以 API 标准工具消息进上下文，不是 JSON 文本（模型不会模仿 JSON 格式；旧「只作展示、不喂给 LLM」语义已废除，`loadHistory` 不再 filter/slice，默认全量读出）。删除/截断对 step 行同样有效。思考片段优先取 DeepSeek 推理模型的 `reasoning_content`（llm.ts 已适配；`LLM_MODEL=deepseek-reasoner` 时每轮都有 think 卡片），没有 reasoning 字段的模型（如 deepseek-chat）则取调用工具时返回的 content，通常为空。
- **core 静态 import `comrade-harness-lib`**（package.json 依赖，本地 `link:` 链接、发布 git 依赖）——类型检查完整，节点/流写错在 tsc 阶段就报。改了 lib 后：core 的链接自动指向新代码（link 是符号链接，重启 daemon 生效）。
- **UI 是 lib 的资源**（2026-08-15）：默认对话 UI（index.html/app.css/app.js 三件套）放在 lib 包内 `ui/` 目录（package.json 的 `files` 白名单含 `"ui"`，git 依赖安装时随包分发）。`createHarness` 的 `ui: { dir, shared }`：core 的 `dir`（约定 public/）**优先**，缺失文件回落 `shared`（缺省 = lib 自带 ui/，显式 `shared: null` 关闭回落）——模板/新 fork 的 public/ 天然是**空覆盖层**，只有变体差异才放文件（同名文件即覆盖）。UI 改一处（lib）全部 core 生效，不再跨模板手动 cp。本地 `local:on` 时改 lib 的 ui/ 刷新即生效（静态文件按请求读盘，不用重启 daemon）。

### 4.4 模板识别（搜索路径）——没有权限系统

**2026-08-15 重构：`.template` / `.immutable` 标记文件与三层守卫全部废除。** 模板 = **目录位于项目 `cores/`（搜索路径，CORES_DIR）之下的 core**（supervisor 的 `isTemplate()` 按路径前缀判定，Windows 大小写不敏感）。模板（standard / dsh-minimal）就在项目 cores/ 下；fork 出的用户 core 默认在 `~/.comrade-harness/cores/`（项目外）。**位置即语义**：fork 时若用 `dir` 参数指定到项目 cores/ 下，该 core 也会被识别为模板。

模板语义（**可运行的参考实现 + 迁移源**，2026-08-15 定案）：
1. **模板可以运行**：boot 正常 spawn（常驻）、可设为 UI、可聊天——用户 fork 后往往落后于模板版本，模板 agent 帮用户把最新代码迁移/同步到他们的 fork（agent 有读写任意 core 的工具，`<core id>/` 前缀可达）。模板被改了咋办：**改了就改了**——没有硬守卫，git 回滚兜底（rollback 放行）。
2. **禁止对模板 commit**（防"以为模板是自己的资产"）：daemon 的 `/api/snapshot` 对模板拒绝（`${id} 是模板 core，不是你的资产：禁止 commit。要修改请先 fork`）——curl / 壳按钮 / agent 工具全部生效。模板的 git 历史只由项目维护者（发布工作流）管理。
3. **模板目录有 AGENTS.md**（standard/dsh-minimal 各一份）：给 agent 看的自我定位——"你是模板，不是任何人的私有资产；不要修改自己（会被覆盖/回滚）；要修改先让用户 fork；禁止 commit"。standard 系 agent 的 system prompt 还会动态识别"我是模板"（runtime 按 CORE_DIR ⊆ CORES_DIR 判定，FlowContext.template）并明示同样的话；dsh-minimal 保持 PERSONA_TEXT 零注入，只有 AGENTS.md。
4. **模板 dirty 警告**：壳的模板卡片显示 `📦 X ⚠️`，commit 面板顶部显示"📦 这是模板（不是你的资产）· ⚠️ 有未提交改动——别 commit，可回滚；要修改先 fork"。
5. **壳交互**：模板卡片点击 = 设为 UI（使用）；右键菜单 = 重载 / fork（不提供删除——模板是项目资产）；commit 按钮对模板禁用（title 明示）。
6. **无自动兜底（2026-08-15 废除自动 fork）**：daemon 启动时若没有可用（非模板）core，驾驶舱就是空的——**不自动 fork**，core 是用户的资产，创建由用户显式决定（壳右键模板卡片 fork / curl `/api/fork`）。UI core 只在两个时机被隐式选择：启动时存储的 ui_core 无效则取第一个可用 core；删除当前 UI core 时回落到第一个可用 core（全都没有则置空）。`/api/chat` 缺省目标 = 当前 UI core（模板也可以），没有可用 core 时返回 `没有可用的 core`。

**agent 侧**：工具层没有任何 immutable 硬守卫（write/reload/rollback/delete 对模板全部放行，只有 snapshot 被 daemon 拒绝）——"agent = 开发者"信任模型的彻底版，防手滑的只剩提示词 + 模板 AGENTS.md，真正的兜底永远是 git。dsh-minimal 模板的 system prompt 是纯 PERSONA_TEXT（过拟合保护），连提示词告知都没有——只有 AGENTS.md。

**commit 面板的 dirty 显示**（2026-08-15）：`GET /api/snapshots/<id>` 返回 `{dirty, list}`；壳的 commit 记录顶部显示"● 有未提交修改"（橙）/ "✓ 工作区干净"（绿），与提交列表同一次请求保证新鲜。

### 4.5 core fork（git 意义上的复制）

`cores/standard` 是根仓库的 git submodule（gitlink 钉住版本，本身仍是完整 git 仓库）；fork 出的用户 core 才是独立 git 仓库。fork 直接就是 `git clone`：

- **新 core 拥有源的全部 git 历史**，clone 自动把源目录记为 `origin`（上游关联），此后独立演化。
- **fork 直接基于源的最新提交，不自动快照**（2026-08-15 重构：此前 fork 前自动快照源的工作树——fork 复制的是 git 内容而非工作树，未提交的改动会先落库；现在改为：源有未提交修改时**不落库**，daemon 响应带 `warning` 明说，壳在 fork 前先查源 dirty 并弹确认，agent 的 `fork_core` 工具先 snapshot 再 fork）。
- **新 core 默认放 `~/.comrade-harness/cores/<name>`**（项目外，不被项目 git 跟踪），`dir` 参数可指定任意绝对路径；daemon 重启后从 store（cores 表存 dir）恢复项目外的 core。**工具对项目外 fork 同样可达**：路径用 `<core id>/` 前缀（§4.3），工具从 `/api/cores` 拿 id→dir 映射。
- **允许 fork 任意 core，包括 📦 模板（standard / dsh-minimal）**（fork 不改源；模板没有标记，fork 出的新 core 天然不是模板——它在项目外）。**新 core 自带完整 agent harness**（提示词随 CORE_ID 自动识别自己是可改的 core）。
- **fork 继承数据流**：fork 复制 standard 的 `src/index.ts`（流 = `standardFlow()` 一行 + 资源组装）——自定义 = 逐层深入（§4.3：选项 → hooks → 整层换函数 → 手拼子图），实测：插一个"注入上下文"节点（手拼 loadContext 后 splice），reload 后行为即变。
- **tsconfig 必须自包含**：standard 的 tsconfig 不 extends 根目录（项目外的 fork 没有根目录，extends 会 TS5083——真实踩过）。
- 数据不复制：DB 在 `data/cores/<id>.db`，新 core 全新空库。
- 入口两个：壳（普通 core 右键菜单 fork；模板卡片右键菜单 fork）；agent 有 `fork_core` 工具。
- 名字规则 `[a-z0-9-]`，缺省 `<src>-fork`；成功后 daemon 广播一条 `hello`（既有消息类型，不动协议），所有壳刷新列表。
- 启动失败时目录已创建（git 历史完整），可修复后 reload，或 rollback 之前的安全 sha。

---

## 5. 架构约束（不许破坏）

1. **daemon 保持笨**：spawn/健康/中继/存储/git。所有语义（agent loop、工具、UI 生成）在 cores 里。
2. **协议最小稳定**：`shared/protocol.ts` 是唯一稳定契约，改它必须 bump `PROTOCOL_VERSION`，壳和 daemon 同步升级。
3. **不引入插件系统**：不加插件注册表、不加技能 DSL、不加能力 schema。新能力 = 新代码包 = cores/ 下新目录。
4. **模板可运行、不可 commit、不可改靠提示词**：模板（项目 cores/ 下的 standard/dsh-minimal）正常启动（参考实现/迁移源，agent 帮用户迁移 fork）；**snapshot 对模板拒绝**（唯一硬性限制，防止模板被当成用户资产）；"不可改"没有守卫——daemon/工具全部放行，只靠提示词 + 模板 AGENTS.md 劝阻（dsh-minimal 零注入只有 AGENTS.md）。真正的兜底永远是 git 快照 + 回滚。
5. **信任模型**：core 以用户权限运行，无沙箱承诺。agent = 开发者，安全网 = git 快照 + 回滚。
6. **纯 TypeScript**（core 的网页前端可以是普通 JS，那是"UI 是普通网页"的一部分）。
7. **编排显式、core 可替换，lib 不藏流程**：harness 的默认数据流是 lib `flow.ts` 的**显式子图**（loadContext / agentLoop / saveTurn / standardFlow——普通函数，逐层可替换），core 的 `src/index.ts` 一行 `standardFlow()` 即用默认，可逐层深入定制或完全自写。lib 里不允许出现"隐藏的、core 不可替换"的 agent 循环。

---

## 6. 已知问题与陷阱（血泪教训，别再踩）

1. **端口竞态（EADDRINUSE）**：`freePort()` 的探测 socket `close` 后端口不会立即释放（Windows 尤甚）。已修：close 后延迟 150ms 再返回 + spawn 失败自动换端口重试 3 次。**别再改回立即返回**。
2. **Bun.serve idleTimeout**：默认 **10 秒**，会掐死长请求（agent 循环跑几分钟；SSE 长连接在思考间隙也会被剪）！上限 **255**。daemon、brain 和 standard 都设了 `idleTimeout: 255`。新 core 若处理长请求必须设。
3. **退役死锁**：swap 等"在途请求"→ 在途请求等 reload 返回 → reload 等 swap → 环。已修：swap 同步返回 + `retireLater` 后台轮询旧进程 `/api/status` 的 busy 字段（core 无此端点/不可达 = 立即退役）。**这是本项目最隐蔽的坑，任何让 swap 等待的改动都会复活它。**
4. ~~单仓库回滚粒度~~ **已解决（2026-08-14）**：per-core 仓库后 `git reset --hard` 只回滚该 core 的工作树。注意：迁移前的单仓库 sha 已不可用，回滚只能在该 core 自己的历史里选 sha。
5. ~~快照列表是仓库级~~ **已解决**：per-core 后 `GET /api/snapshots/<id>` 返回该 core 自己的 git log。
6. **聊天并发**：**会话级单飞**（2026-08-15 多会话落地后）——同一会话 busy → 409（UI core 应用和 curl /api/chat 同时打同一会话会互相阻塞）；不同会话可并行（见 §4.2）。
7. **Windows 细节**：`bunx` 从 core 目录向上找 node_modules（能工作，别加依赖）；git 的 CRLF 警告无害；没有 `ps/ss`（提示词已写明，别教它用）。
8. **agent 会整文件重写**：write_file 是覆盖写，agent 有时会把整个文件重写（甚至产生重复行——真实发生过）。提示词里已要求"小而精准"，但防御性地看 diff 是好习惯。
9. **日志流向**：daemon 的 log sink 同时打 stdout（`[HH:MM:SS]` 前缀）和 WS 广播。壳的日志面板已删除，调试看 daemon 的 stdout。
10. **fork 复制的是 git 内容**：`git clone` 不带工作树未提交改动。已修：fork 前自动快照源。但**先改未提交 → 立刻 fork** 会先产生一个快照提交，别惊讶。
11. **改 standard 的代码要重启 daemon**：standard 是 📦 模板——**正常 spawn**（可运行，参考实现/迁移源）；改它只影响**之后** fork 出的新 core（已 fork 的 core 是独立 git 仓库，不受影响）。开发流程 = 改代码 → tsc → 重启 daemon。**改 harness 组件库也一样**（core 启动时动态 import，重启才换组件）。
12. **store 的 cores 表是 UPSERT**：`addCore` 用 `ON CONFLICT DO UPDATE`——同名 core 重新注册（如 fork 到新位置）会更新 dir。手动删 core 目录后，重启时 discover 会**清理残留记录**（2026-08-14 修复：此前运行中删目录会让 /api/health 崩——`git.head` 对不存在的 cwd ENOENT，已修：`info()` 加目录守卫 + discover 删记录）。**2026-08-15 更新：删 core 有正式入口了**——`POST /api/delete/<id>`（壳的"删除"按钮 / agent 的 `delete_core` 工具）：杀进程 + 清 store 记录 + 删目录（含 git 历史）+ 删聊天 DB，一步到位、不可恢复。旧姿势（手动删目录等重启清记录）仍可用，但列表在重启前会残留显示。**2026-08-15 补充**：discover ② 扫描项目 cores/ 时跳过已注册的 id——运行中在项目 cores/ 造出的同名影子目录不会覆盖 store 记录（这是工具工作区修复的一部分，见 §4.3）。
13. **cores/standard 是 git submodule**：根仓库 gitlink 钉住它的版本。改 standard = 在 cores/standard 里提交 → 根仓库 `git add cores/standard` 再提交（bump），否则远端/他人拿到的是旧版。**别在 cores/standard 里提交后忘了 bump**——根仓库会显示 `modified: cores/standard (new commits)`，这正是"该 bump 了"的信号。submodule 的 URL 是 GitHub 远端（https://github.com/windwhiterain/comrade-harness-standard.git），首次 clone 根仓库后需 `git submodule update --init`。
14. **模板的本地依赖覆盖（local.override.json + postinstall，2026-08-16 取代 package.local.json/skip-worktree）**：`bun run local:on` 生成 gitignored 的 local.override.json（依赖名 → 本地路径）并 install；package.json 的 postinstall 钩子（scripts/local-link.ts）把列出的依赖链成 junction——package.json/bun.lock **始终是提交版 git 依赖**，git pull / git reset 不再有静默覆盖问题，发布也不用 un-skip。`local:off` 删 marker 还原 GitHub 安装。**注意**：local-link.ts 是每次 install 都跑的钩子，fork/他人机器无 marker 时必须是 no-op（exit 0）；改它要保证零影响。
15. **控制面安全（2026-08-15）**：状态变更端点一律 POST（CSRF 防护）；`COCKPIT_TOKEN` 可选开启后 daemon 与 core 的 `/api/*`、daemon 的 `/ws` 都要求 Bearer 令牌（壳/对话 UI 自动提示输入）。改了协议/壳的令牌逻辑，两边要同步（协议 v5）。
16. **git 未配置时快照会明说**（2026-08-15）：`git.snapshot` 现在区分"无改动 / commit 失败 / 不是独立 git 仓库"——git 没配 user.name/email 时快照返回明确错误，不再静默当"无改动"；fork 前快照失败会中止 fork（宁可报错也不能 fork 出旧版）；reload 的自动快照失败只警告不阻塞。**目录必须是独立 git 仓库**（`rev-parse --show-toplevel` 校验）：项目 cores/ 下没建 git 的"裸 core"会被拒绝快照/回滚——否则 `git add`/`reset` 会作用到外层根仓库（真实踩过：从子目录 `git add -A` 把根仓库整个提交了）。目录不是独立仓库的 core 在注册时就会打 ⚠️ 日志。
17. ~~immutable 标记实时读取~~ **已废除（2026-08-15）**：`.immutable`/`.template` 权限系统整体删除，模板识别改为搜索路径（项目 cores/ 目录），见 §4.4。
18. **启动端口自愈**（2026-08-15）：新 daemon 启动时若目标端口被**本系统旧 daemon** 占用（netstat/wmic 识别命令行含 `daemon/src/main.ts`），自动 `taskkill /F /T` 终止其进程树（含 core）并接管——重复跑 `bun run dev`、终端残留进程不再撞 EADDRINUSE；被**其他程序**占用则顺延到 `PORT+1` …（最多 +9），日志明说。识别失败一律当"他人占用"顺延，**绝不误杀**（POSIX 走 lsof + SIGTERM，daemon 的 SIGTERM 处理器会先清理 core）。被接管的旧 daemon 的 WS 客户端（壳标签页）掉线后自动重连；core 由新 daemon 从 store 重新拉起。
20. **权限系统已废除（2026-08-15）**：`.template`/`.immutable` 标记与三层守卫整体删除——模板识别改为搜索路径（项目 cores/ 目录），agent 侧只有 buildSystemPrompt 准则 6 劝阻（dsh-minimal 零注入无告知）。**fork 不再自动快照**：直接基于源的最新提交，源有未提交修改时 daemon 响应带 `warning`、壳弹确认、agent 先 snapshot 再 fork——别再把"fork 前自动提交"加回去（2026-08-14 的旧行为，用户已拍板废除）。协议升到 v6：CoreInfo 删 `immutable`、加 `dirty`；`/api/snapshots` 返回 `{dirty, list}`。
19. **git 依赖必须用 commit id，不能用 tag**（2026-08-15，真实踩过）：模板 package.json 曾提交 `github:...#v0.1.0`（tag），而发布工作流是 force amend 移动 tag——**bun 只感知 package.json 的 spec 变化，不感知 tag 移动**，bun.lock 永远锁旧 sha；fork 复制提交版 bun.lock → 新 core `bun install` 拉到旧 lib（如缺 `importProviders` 导出）→ SyntaxError 起不来，日志与报错都指向代码而非依赖。已修：模板依赖改为 **commit id**（不可变，package.json 与 lock 天然一致，即使复制旧 lock，install 也按 package.json 拉正确版本；已实测验证）。**发布新版本后必须把新 commit sha 同步进模板 package.json**（§2 发布工作流），否则 fork 出的 core 锁旧 id（force push 后旧 commit 不可达，重装会 404）。
21. **bun install -g 重装 DependencyLoop**（2026-08-16，bun 上游 bug #20647/#32757，本机实测）：`bun install -g github:windwhiterain/comrade-harness` **首次安装正常**，同一包名**重装**（发布工作流 amend + force push 后用户再装）报 `has a dependency loop`——bun 的全局 manifest 会追加重复根依赖（`--force` 也躲不开）。解法：`bun remove -g comrade-harness && bun install -g github:windwhiterain/comrade-harness`。另外：**同一个包名先用 file:/git+file: 等本地源装过、再装 github: 源也会触发**（本机踩过：一次失败的 file: 尝试让后续 github: 安装全部循环报错，remove 后才恢复）。发布说明要写清楚"更新 = 先卸载再安装"。

---

## 7. 路线图（M4 候选，按价值排序）

1. **skills 即代码包**：standard 的工具集演化为"写个包放进 `cores/standard/skills/` 就多一个工具"（Prime Agent 的 importable packages 风格）——这本身就是论题的自证。
2. **对抗演示脚本**：故意写坏 → 门禁拦截 → agent 自愈 → 逃生门回滚，一条脚本讲完整个故事。
3. ~~**流式输出**~~ ✅ **已完成（2026-08-15）**：core 的 `/api/chat` 与 `/api/messages` 支持 SSE（`Accept: text/event-stream` 协商，不带则 JSON 不变），UI core 应用流式显示 agent 思考/工具/逐字回复（见 §4.2）。
4. ~~per-core git 仓库~~ ✅ **已完成（2026-08-14，随 fork 功能一并落地）**：每个 core 独立 git 仓库 + `git clone` 式 fork。
5. ~~**多会话/多 agent**~~ ✅ **已完成（2026-08-15，会话部分）**：core 内多会话（消息池 + 引用列表 + 会话栏，见 §4.2）；"选择哪个 core 跑 agent"与跨 core 会话移动（export/import）是后续工作。
6. ~~**会话上下文注入**~~ ✅ **已落地（2026-08-14，随数据流化；2026-08-16 默认改全量）**：standard 的流默认全量历史进上下文（`loadContext` 不过滤不截断，含 step 痕迹）；想窗口化 `load: { history: N }`，独立回合 `history: 0`。

---

## 8. 接手后的第一天清单

1. `cd /c/resource/comrade-harness && git submodule update --init && bun run typecheck && bun run crh web`（standard 本地开发：`cd cores/standard && bun run local:on` 切到本地 lib）
2. `curl http://127.0.0.1:3800/api/health` → 首次启动**没有可用 core**（2026-08-15 起不再自动 fork default，需手动创建）；standard 是模板（`template: true`，不运行）
3. `curl -X POST "http://127.0.0.1:3800/api/fork/standard?name=default"` → 手动创建首个 core；`curl -X POST http://127.0.0.1:3800/api/chat -d '{"message":"你好"}'` → 验证 agent 链路（缺省走当前 UI core；没有 UI core 时取第一个可用 core；standard 模板不可运行）
4. `curl -X POST "http://127.0.0.1:3800/api/fork/standard?name=echo2"` → 再验证 fork（新 core healthy、自带 /api/chat、可改可 reload）。再演示自定义：在 fork 的 `src/index.ts` 流里插一个节点（如注入上下文），reload 后行为即变
5. 让 fork 出的 core 改自己：`curl -X POST /api/chat -d '{"message":"改自己加个端点","core":"echo2"}'` → 验证元循环
6. 改完代码：根仓库 + **改动过的 core 仓库**都要提交（cores/ 根目录不是仓库；standard 有新提交记得根仓库 bump gitlink）。改 standard 后重启 daemon 才生效。

> 完成一个功能后问自己：它违背两条铁律了吗？它给协议加东西了吗？它让 daemon 变聪明了吗？它碰 standard 了吗？—— 四个都答"没有"，才算符合本项目的哲学。
