# Coding Agent HUD

面向 Windows 的本地 Coding Agent 状态悬浮窗，观察 Claude Code 和 Codex，不接管模型调用、任务执行或权限审批。

**状态：M1 开发版，完整 MVP 尚未验收。** 原始需求见 `Coding Agent HUD 产品需求文档 MVP.md`；顾问结论、开发阶段和验收边界见 `docs/development-plan.md`。

## 开发启动

需要 Windows 10 / 11、Node.js 22.12+、Rust、Visual Studio C++ Build Tools 与 WebView2。

```bash
npm ci
npm run desktop:dev
```

HUD 默认留在托盘。没有活跃会话时不显示悬浮窗。点击托盘图标进入交互模式，查看采集状态；再次点击退出交互模式。按住 **Alt** 可临时关闭穿透并操作 HUD，松开恢复。HUD 不主动获取键盘焦点。

浏览器预览：

```bash
npm run dev
```

打开 `http://127.0.0.1:1420`。浏览器模式明确标记 **DEMO**，使用合成数据验证交互，不采集真实 Agent，不验证 Windows 窗口行为。桌面模式不加载演示会话。

## 当前实现

- Rust 统一 Session Model，Activity 与 Attention 分离。
- Codex JSONL 增量尾读；Windows 文件事件触发，历史文件需确认 `codex.exe` 持有才显示。
- 进程退出监听和会话清理，Git root / branch 按事件刷新。
- Compact / Active / Attention / Expanded、1+N Stack、Pin 和 Detail Drawer。
- Context 的未知/估算值、70% / 90% 提示；无可靠容量时不编造百分比。
- 透明置顶窗、托盘、鼠标穿透、Alt 临时交互。
- 原生 Claude Hook helper，白名单提取并原子写入元数据；接收后删除事件文件。
- 默认关闭命令和完整路径展示；不保存 Prompt、回复、文件内容、Shell 输出或凭据。

## Codex 采集

默认监听 `%USERPROFILE%/.codex/sessions`。遵循 Codex 的 `CODEX_HOME` 环境变量。

运行 HUD 后正常启动 Codex。只有确认 rollout 被一个 `codex.exe` 持有时才注册会话。如果系统无法可靠确认文件持有进程，HUD 不将该文件猜成活跃会话。

本次协议适配参考 `codex-cli 0.162.1`。这个版本的 rollout **不会持久化全部审批请求、流式输出、工具开始/结束或瞬时错误**。已保存的 function call 能显示工具状态，但出现时间受 Agent 的持久化时机影响。因此仅靠 rollout 不能满足全部 Waiting User / Error 实时验收；下一阶段需要补充官方实时事件入口，不用超时猜测等待状态。

Context 取 `last_token_usage.total_tokens`，明确标记为最近一次模型请求的**估算值**；Token 取累计用量。两者不同。compaction 后无新的可靠统计时清空 Context。

启动时最多检查最近修改的 32 个 rollout。可通过 `HUD_STARTUP_SCAN_LIMIT` 显式调整；后续新文件事件不受这个数量限制。极久未更新、未入候选集合的已运行会话，需要下一次文件事件才会发现。

## Claude Hook 集成

构建 helper：

```bash
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin agent-hud-hook
```

生成 `src-tauri/target/debug/agent-hud-hook.exe`。参考 `docs/claude-hooks.example.json`，把占位路径替换成 helper 的绝对路径，再**合并**到项目级 `.claude/settings.local.json` 的 `hooks`。不要覆盖已有配置；本项目不会自动改写用户配置。

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
- Claude Transcript 遥测、Hook 自动安装 / 卸载，以及 npm / Node 包装版支持。
- WSL 本地 Collector、完整终端映射、DPI / 多屏位置保存、开机启动和签名安装包。
- 边缘磁吸、Git dirty / diff、复杂动画属于 P1，不在首批实现范围。

## 已有实现但尚未完成实机验收

- 真正交互式 Claude / Codex 的状态准确性与版本兼容。
- 全局 Alt、托盘恢复、实际鼠标穿透及不同终端前置；窗口标志和 IPC 模拟不能替代这些检查。
- 8 小时运行、< 1% 空闲 CPU、< 2 秒发现、< 500 ms 事件响应的测量。

原始设计资料保持不变，真实 session/transcript、凭据与构建产物不进入仓库。
