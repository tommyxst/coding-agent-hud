# Coding Agent HUD

面向 Windows 的本地 Coding Agent 状态悬浮窗，观察 Claude Code 和 Codex，不接管模型调用、任务执行或权限审批。

**状态：M1 开发版，完整 MVP 尚未验收。** 原始需求见 `Coding Agent HUD 产品需求文档 MVP.md`；顾问结论、开发阶段和验收边界见 `docs/development-plan.md`。

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
- Codex JSONL 增量尾读；Windows 文件事件触发，历史文件需确认 `codex.exe` 持有才显示。
- 进程退出监听和会话清理，Git root / branch 按事件刷新。
- Compact / Active / Attention / Expanded、1+N Stack、手选 / Auto 和稳定的 Detail Drawer。
- 近期工具元数据保留最多 8 条，展示最近 3 组；已观察 / 已返回 / 失败不冒充当前 Running。
- Context 的未知/估算值、70% / 90% 提示；无可靠容量时不编造百分比。
- 透明非激活窗、窗口置顶开关、专用拖动柄、托盘、鼠标穿透、Alt 临时交互。
- 原生 Claude Hook helper，白名单提取并原子写入元数据；接收后删除事件文件。
- 默认关闭命令和完整路径展示；不保存 Prompt、回复、文件内容、Shell 输出或凭据。

## 窗口操作

- **图钉**只切换窗口置顶，不固定主会话；会话 Pin 功能延期。点其他会话可手选，点 **Auto** 恢复自动排序。
- 被 Win+D、最小化或其他窗口遮住后，单击系统托盘图标恢复；不会因此重新开启置顶。后台采集更新不主动恢复被最小化的 HUD。
- 按住左侧 **拖动窗口**柄拖动。穿透时先按住 Alt 或通过托盘恢复交互；DEMO 不移动桌面窗口。
- **HUD 设置 → 界面字号**可选 12–20 px，默认正文 15 px、辅助文字 14 px。旧设置保留隐私及外观偏好。
- 展开详情后，Activity 更新不会折叠；Waiting / Error / Done 仍立即提示。切换、移除会话或主动收起才清除该详情意图。
- 粒子动画从当前位置切换方向，不排队重播状态；Idle / Attention / 会话移除立即停止。应用或系统减少动态效果、键盘操作、窗口隐藏也停止动画。

## Codex 采集

默认监听 `%USERPROFILE%/.codex/sessions`。遵循 Codex 的 `CODEX_HOME` 环境变量。

运行 HUD 后正常启动 Codex。只有确认 rollout 被一个 `codex.exe` 持有时才注册会话。如果系统无法可靠确认文件持有进程，HUD 不将该文件猜成活跃会话。

本次协议适配参考 `codex-cli 0.162.1`。这个版本的 rollout **不会持久化全部审批请求、流式输出、工具开始/结束或瞬时错误**。已保存的 function call 能显示工具状态，但出现时间受 Agent 的持久化时机影响。因此仅靠 rollout 不能满足全部 Waiting User / Error 实时验收；下一阶段需要补充官方实时事件入口，不用超时猜测等待状态。

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

脚本要求显式绝对路径、已有合法配置和 helper；先备份原始字节，再保留已有设置与 Hook 并合并。重复运行不重复添加；结构非法或合并期间文件变化会报错。HUD 启动时不自动运行此脚本。安装后启动新 Claude 会话，Collector 诊断将从等待首个事件变为已验证接收。

撤销时只移除命令路径完全匹配该 helper 的 HUD Hook，保留其他 Hook。仅当安装后未再修改配置时才可恢复完整备份；否则参照备份选择性撤销，不覆盖后来的设置。备份包含用户配置，必须保留在仓库外。

Hook 覆盖 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、PostToolUseFailure、PermissionRequest、Notification、Stop 和 SessionEnd。`PreToolUse` 仅表示工具开始；PermissionRequest / permission_prompt 才表示需要审批。

当前 helper 要求父进程链中存在原生 `claude.exe`。npm / Node 包装版和 WSL 版尚不支持，不能据此声明 Claude 全版本自动发现通过。Hook 安装后才会收到新事件；不会从历史 transcript 猜测当前状态。Claude Token / Context 补充采集放在 M2。

helper 失败返回普通非阻断错误，不返回权限拒绝码 2，也不输出任何审批决策。

## 本地配置

| 配置 | 用途 |
|---|---|
| `CODEX_HOME` | Codex 本身约定的数据根目录 |
| `HUD_EVENT_DIR` | HUD 与 helper 共用的元数据事件目录；默认 `%LOCALAPPDATA%/CodingAgentHUD/events` |
| `HUD_STARTUP_SCAN_LIMIT` | 启动阶段候选文件数量，默认 32 |

环境变量由启动进程显式传入；项目不自动加载 `.env`。UI 设置只保存本地偏好，不保存会话历史。非法配置会报告错误，不静默替换。

Return to Workspace 只唤醒已确认的终端窗口。Windows Terminal、VS Code 集成终端、重挂父进程等无法可靠匹配时，界面提示未绑定，不随便切换到其他窗口。此版本不定位终端 tab。

## 检查与构建

```bash
npm run check
node --test scripts/configure-claude-hooks.node.cjs
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

GitHub Actions 在 Windows 执行对应检查。CI 是否通过以实际 check run 为准，配置文件不等于运行成功。

本次结果与隔离验证的复现命令见 `docs/verification.md`；合成预览见 `docs/screenshots/hud-preview.png`。

## 功能缺口（尚未实现）

- Codex 审批 / 瞬时事件的实时补充入口，不能据解析 fixture 宣称 Waiting User 全覆盖。
- Claude npm / Node 包装版、Transcript 遥测，以及完整 Hook 卸载流程；当前仅提供显式授权合并脚本和手工撤销说明。
- WSL 本地 Collector、完整终端映射、DPI / 多屏位置保存、开机启动和签名安装包。
- 边缘磁吸、Git dirty / diff、复杂动画属于 P1，不在首批实现范围。

## 已有实现但尚未完成实机验收

- 真正交互式 Claude / Codex 的状态准确性与版本兼容。
- 物理拖动、全局 Alt、托盘恢复、实际鼠标穿透及不同终端前置；窗口标志和 IPC 模拟不能替代这些检查。
- 8 小时运行、< 1% 空闲 CPU、< 2 秒发现、< 500 ms 事件响应的测量。

原始设计资料保持不变，真实 session/transcript、凭据与构建产物不进入仓库。
