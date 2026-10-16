# Coding Agent HUD

面向 Windows 的轻量本地 Coding Agent HUD：看状态、需要介入时提示、快速回到终端。观察 Claude Code 和 Codex，不接管模型调用、任务执行或权限审批。

**状态：M3-A 与轻量第一批开发版；真实交互式 Agent、物理多屏和完整 MVP 尚未验收。** 当前范围按 2026-10-16 批准的轻量计划收敛；路线见 `docs/development-plan.md`、`docs/m3-design.md`，本轮证据见 `docs/windows-loop-verification.md`。原始 PRD 保留作历史依据。

## 开发启动

需要 Windows 10 / 11、Node.js 22.12+、Rust、Visual Studio C++ Build Tools 与 WebView2。

```bash
npm ci
npm run desktop:dev
```

HUD 默认留在系统托盘（任务栏右侧）。没有活跃会话时不显示悬浮窗。单击托盘图标始终显示 / 恢复 HUD 并进入交互模式；退出交互请用托盘右键菜单的 **退出交互模式**。按住 **Alt** 可临时关闭穿透，松开恢复。HUD 不主动获取键盘焦点。

浏览器预览：

```bash
npm run dev
```

打开 `http://127.0.0.1:1420`。浏览器模式明确标记 **DEMO**，使用合成数据验证交互，不采集真实 Agent，不验证 Windows 窗口行为。桌面模式不加载演示会话。

## 当前实现

- Rust 统一 Session Model，Activity 与 Attention 分离。
- Codex JSONL 增量尾读与已有共享 daemon 的只读状态补充；不订阅审批、不启动服务。
- 进程退出监听和会话清理，Git root / branch 按事件刷新。
- Compact / Active / Attention / Expanded、1+N Stack、手选 / Auto 和稳定的 Detail Drawer。
- 近期工具元数据保留最多 8 条，展示最近 3 组；已观察 / 已返回 / 失败不冒充当前 Running。
- Context 的未知/估算值、70% / 90% 提示；无可靠容量时不编造百分比。
- 透明非激活窗、窗口置顶开关、专用拖动柄、托盘、鼠标穿透、Alt 临时交互。
- 原生 Claude Hook helper，白名单提取并原子写入元数据；接收后删除事件文件。
- Claude 异步 transcript 遥测、请求去重、compaction 失效及精确 Hook 卸载。
- 显示器设备接口标识与逻辑相对位置保存，按当前 DPI 恢复；工作区约束、屏幕缺失诊断与托盘离屏恢复。
- 默认关闭命令和完整路径展示；不保存 Prompt、回复、文件内容、Shell 输出或凭据。

## 窗口操作

- **图钉**只切换窗口置顶；不新增会话 Pin。点其他会话可手选，点 **Auto** 恢复自动排序。
- 被 Win+D、最小化或其他窗口遮住后，单击系统托盘图标恢复；不会因此重新开启置顶。后台采集更新不主动恢复被最小化的 HUD。
- 按住左侧 **拖动窗口**柄拖动。穿透时先按住 Alt 或通过托盘恢复交互；DEMO 不移动桌面窗口。
- **HUD 设置 → 界面字号**可选 12–20 px，默认正文 15 px、辅助文字 14 px。旧设置保留隐私及外观偏好。
- 展开详情后，Activity 更新不会折叠；Waiting / Error / Ended 仍立即提示。**Ended / 本轮已结束**仅表示采集到本轮结束事件，不表示用户任务已验收；提示时长沿用原设置。
- 粒子动画从当前位置切换方向，不排队重播状态；Idle / Attention / 会话移除立即停止。应用或系统减少动态效果、键盘操作、窗口隐藏也停止动画。
- 原生位置自动保存在 `%APPDATA%/dev.tommyxst.coding-agent-hud/window-position.json`，不保存会话。屏幕移除时明确提示并恢复主屏；再次连接后需手动拖回。配置损坏时显示 **Collector 状态 → 窗口位置** 错误，保留原文件并禁用本次保存；退出后修复或删除该文件再重启。
- HUD 已连接不等于 Agent 已接入。空态区分连接失败、采集入口不可用、等待 Hook 验证和未发现可确认会话；**Collector 状态**显示各入口实际证据与支持范围，不据此猜 Hook 是否安装。

## Codex 采集

默认监听 `%USERPROFILE%/.codex/sessions`。遵循 Codex 的 `CODEX_HOME` 环境变量。

运行 HUD 后正常启动 Codex。rollout 只有确认被一个 `codex.exe` 持有时才注册。HUD 优先从该进程查询原生可执行文件路径，调用 `codex app-server proxy` 连接同一 `CODEX_HOME` 已有的共享 daemon；不会启动 daemon 或 Agent。

适配依据为 `codex-cli 0.162.1`。只读连接只握手、列出已加载会话、读取不含 turns 的元数据，并接收全局状态广播。明确的审批 / 输入等待与解除优先于 rollout；Idle 不冒充 Done。daemon 单独发现的会话不绑定其进程为终端。元数据中的 prompt preview 直接丢弃，不保存、不展示。

**覆盖有限：** embedded / `--no-daemon` 会话及不同 `CODEX_HOME` 不在共享连接内。连接失败保留 rollout 并显示 `codex-live` 诊断；仅在已验证 rollout 文件事件后重试，最短间隔 5 秒，不轮询。rollout 与全局状态仍不覆盖全部流式回复、瞬时工具或错误，不能据此声明完整实时验收。详情见 `docs/m2-event-coverage.md`。

Context 取 `last_token_usage.total_tokens`，明确标记为最近一次模型请求的**估算值**；Token 取累计用量。两者不同。compaction 后无新的可靠统计时清空 Context。

启动时最多检查最近修改的 32 个 rollout。可通过 `HUD_STARTUP_SCAN_LIMIT` 显式调整；后续新文件事件不受这个数量限制。极久未更新、未入候选集合的已运行会话，需要下一次文件事件才会发现。

## Claude Hook 集成

构建 helper：

```bash
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --bin agent-hud-hook
```

生成 `src-tauri/target/release/agent-hud-hook.exe`。参考 `docs/claude-hooks.example.json`，把占位路径替换成 helper 的绝对路径，再合并到所选 Claude 配置的 `hooks`。也可以在明确授权后使用合并脚本：

```powershell
$settingsPath = Join-Path $env:USERPROFILE '.claude/settings.json'
$helperPath = (Resolve-Path './src-tauri/target/release/agent-hud-hook.exe').Path
$backupPath = Join-Path $env:LOCALAPPDATA 'CodingAgentHUD/config-backups'
node scripts/configure-claude-hooks.cjs $settingsPath $helperPath $backupPath
```

脚本要求显式绝对路径、已有合法配置和 helper；先备份原始字节，再保留已有设置与 Hook 并合并。重复运行不重复添加；结构非法或检测到文件变化会报错。HUD 启动时不自动运行此脚本。安装后启动新 Claude 会话，Collector 诊断将从等待首个事件变为已验证接收。

卸载时使用**原先安装的 helper 绝对路径**，即使 helper 文件已删除也可执行：

```powershell
node scripts/unconfigure-claude-hooks.cjs $settingsPath $helperPath $backupPath
```

脚本只删除命令与该 helper 精确匹配的 Hook，保留其他配置和混合 Hook 组；先备份原始字节，保留 BOM / CRLF，检测到并发变化则中止，重复执行无副作用。`.hud.lock` 互斥 HUD 写入，但不是文件 compare-and-swap：执行前停止外部配置编辑 / 写入。崩溃遗留锁时，确认没有脚本在运行后才能手动删除。不要用旧备份覆盖后来新增的设置。

样例覆盖 14 个事件：SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、Notification、Stop、SessionEnd、PreCompact、PostCompact、StopFailure、Elicitation、ElicitationResult。`PreToolUse` 不等于审批；Claude `PermissionRequest` 只登记候选，明确 `permission_prompt` 才显示人工审批等待。该 Notification 有源端延迟；无 ID / 同名并行时保守保留关联候选，不能保证即时解除。compaction 不改变 Waiting。

Hook 的 `transcript_path` 触发独立异步尾读，只更新模型、Token 和 Context，不改变活动 / Attention 或复活退出会话。按请求 ID 去重流式记录；Token 是已观察请求的总量，Context 为最近一次输入及缓存之和，标记估算，不猜容量。格式并非跨版本稳定契约，缺字段仍未知。

helper 仍要求原生 `claude.exe` 祖先进程；npm / Node 包装版和 WSL 未支持。新样例不会自动升级已有用户配置；需明确授权后重新合并，或自行安装。历史 transcript 不用于猜测当前状态。

helper 失败返回普通非阻断错误，不返回权限拒绝码 2，也不输出任何审批决策。

## 本地配置

| 配置 | 用途 |
|---|---|
| `CODEX_HOME` | Codex 本身约定的数据根目录 |
| `HUD_EVENT_DIR` | HUD 与 helper 共用的元数据事件目录；默认 `%LOCALAPPDATA%/CodingAgentHUD/events` |
| `HUD_STARTUP_SCAN_LIMIT` | 启动阶段候选文件数量，默认 32 |
| `HUD_PLACEMENT_FILE` | 显式覆盖原生位置文件，必须为绝对文件路径；用于隔离测试 |

环境变量由启动进程显式传入；项目不自动加载 `.env`。UI 设置只保存本地偏好，不保存会话历史。非法配置会报告错误，不静默替换。

Return to Workspace 只唤醒绑定时唯一、可见、祖先进程链已验证的终端窗口，并复核原 HWND、PID、名称和进程创建时间。Windows Terminal / VS Code 多窗口、ConPTY 无法确认关联、父进程重挂或原窗口已关闭时拒绝跳转；不会改选同进程的其他窗口，不定位 tab。

## 检查与构建

```bash
npm run check
node --test scripts/configure-claude-hooks.node.cjs scripts/unconfigure-claude-hooks.node.cjs
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

GitHub Actions 在 Windows 执行对应检查。CI 是否通过以实际 check run 为准，配置文件不等于运行成功。

M3-A 的复现命令、截图与边界见 `docs/m3-verification.md`，分批与 WSL 方案见 `docs/m3-design.md`；M2 / M1 历史见 `docs/m2-verification.md`、`docs/verification.md`。

## 功能缺口（尚未实现）

- Codex embedded / `--no-daemon` 及全部瞬时事件覆盖；只读共享 daemon 入口不是完整 Agent 事件订阅。
- Claude npm / Node 包装版，以及 transcript 的更广版本兼容。
- WSL 本地 Collector、完整终端映射、开机启动和签名安装包。
- 保留 1+N 与手选 / Auto；不做通知收件箱、历史数据库、时间线、搜索分组、云同步或控制面。声音、系统通知、磁吸、Git diff、更多 Agent 和 tab 定位不在当前路线内。

## 已有实现但尚未完成实机验收

- 真正交互式 Claude / Codex 的状态准确性与版本兼容。
- 物理多屏 / 热插拔与混合 DPI 拖动、全局 Alt、托盘输入、实际鼠标穿透及不同终端前置；单屏 HWND / IPC 和坐标回归不能替代这些检查。
- 8 小时运行、< 1% 空闲 CPU、< 2 秒发现、< 500 ms 事件响应的测量。

原始设计资料保持不变，真实 session/transcript、凭据与构建产物不进入仓库。
