# Coding Agent HUD 开发计划

依据：`Coding Agent HUD 产品需求文档 MVP.md` V0.3、`UI&UX/UX.html` 和 5 张界面样例。

## 顾问讨论结论

首次开发前已调用 Pi Advisor。顾问认可 Tauri 2 + Rust + WebView 路线，建议先实现真实 Windows 会话的最小闭环，再扩展完整 MVP。

- UI 只消费统一 Session Model，不直接解析 Agent 文件。
- Activity 与 Attention 独立。`PreToolUse` 表示工具调用，不表示等待审批；Claude 使用 `PermissionRequest` 或明确的 Notification。
- 不把历史 rollout 当活跃会话；必须验证文件的实际持有进程，并在进程结束时清理。
- 不从累计 token 推测 Context。缺失的模型、容量、终端绑定显示未知。
- 界面预览和真实采集严格分离。浏览器预览必须标记演示模式。
- 新仓库私有；真实 transcript、凭据、构建产物不进仓库。
- 不修改用户全局 Claude 配置，不控制权限批准、模型调用或 Agent 执行。

## 阶段与验收

### M1：Windows 开发版纵切片（本次开始实现）

1. 初始化私有 GitHub 仓库、锁定依赖、建立 Windows CI。
2. Rust 统一模型、Codex rollout Adapter、JSONL 增量尾读与回归测试。
3. 使用文件事件触发采集，验证 Codex 文件持有进程，观察进程退出；不周期执行 git status。
4. 实现 Compact / Active / Attention / Expanded、1+N Stack、Pin、隐私设置、未知值呈现。
5. 透明、置顶、非激活窗口、托盘、穿透及托盘恢复交互入口。
6. 只对可确认的 Terminal 窗口提供返回；无法绑定时明确报错，不随便唤醒窗口。
7. Claude 原生 Hook helper 与配置样例：只提取白名单元数据，无正文落盘。

验收：前端类型检查、单元测试、Rust 测试/静态检查、Windows 构建、浏览器交互测试，以及真实采集入口的本地检查。不能用模拟数据通过真实自动发现验收。

### M2：Agent 集成可靠性

- 在真实交互式 Claude / Codex 会话验证所有状态和工具事件。
- Claude Transcript 只读遥测补充，模型、输入/输出 token、Context 只取真实可用字段。

- 已核对 Codex 0.162.1 的 `codex-rs/rollout/src/policy.rs`：审批请求和部分瞬时工具/错误事件不写入 rollout。rollout-only 不能通过 Waiting User 的完整验收；M2 必须确定官方实时事件补充入口，不靠超时推测。
- Codex Context 使用最近一次模型请求用量并显式标记估算，不使用累计 Token；compaction 后等待新统计。
- Claude Hook 安装/卸载的显式授权流程，保留已有用户配置。
- 改进 Windows Terminal / VS Code 集成终端映射；仍只保证窗口级返回，不承诺 tab 精确定位。
- 验证 HUD 启动前已经运行的会话、resume、多个会话、并行工具调用和退出清理。

### M3：WSL 与产品化

- 在 WSL 内本地采集，再传输已脱敏事件至 Windows；禁止高频扫描 `\\wsl.localhost\`。
- 基础 WSL2 仍属于 MVP，不因当前阶段仅实现 Windows 而删除。
- 多屏位置与 DPI 保存、开机启动、签名安装包。
- 8 小时内存/CPU、< 2 秒发现、< 500 ms 事件响应的测量验收。

### P1

边缘磁吸/收起、dirty count / diff、复杂动画。按文档优先级推进，不加入消息输入、审批、Stop/Resume、云同步或 Agent 编排。

## 实现边界

- 本次交付标为开发版，不宣称整个 V0.3 MVP 完成。
- 窗口行为必须分别检查配置和实际桌面效果；编译成功不等同于不抢焦点验收。
- 默认 command detail、文件名、完整仓库路径关闭；session history 只留内存。
- 性能参数、发现路径和 Done 展示时长使用有名称的配置，不散落魔法值。

## 适配依据

- Claude Code 官方 Hooks reference：`https://code.claude.com/docs/en/hooks`
- Codex `rust-v0.162.1` protocol：`https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs/protocol`
- Tauri 2 window/config/tray 官方文档：`https://v2.tauri.app/`

本机初始检查：Node 22.21.1、Rust 1.92.0、Visual Studio 2022 C++ toolchain、Claude Code 2.1.296、Codex CLI 0.162.1。这些是本次核对结果，不构成未来版本兼容保证。

## 本次开发启动交付

收尾顾问复核要求严格区分功能缺口与尚未验收的行为，保存可复现的隔离原生脚本，并完成首批代码交付。他认为已有验证足以支持文档中的 M1 开发版声明，不足以证明完整 MVP 验收。

本次对应原始请求的开发启动与仓库建立，不把阶段划分当作删除 P0。具体验证、构建输出和剩余缺口见 `docs/verification.md`；桌面交互、真实 Agent 全状态与 WSL 继续按 M2 / M3 推进。
