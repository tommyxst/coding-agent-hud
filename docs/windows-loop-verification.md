# 轻量第一批：Windows 核心闭环验证

日期：2026-10-16。任务分支 `fix/lightweight-windows-loop`，基于 `3348a42462a65e2c181bc1d8e50be3d22a2f313d`。仅执行批准计划第一批；不实现 WSL、安装、通知收件箱或新管理页面。

## 行为与用法

- 内部 `DONE` 状态与原本的提示时长设置保持兼容，界面改为 `Ended / TURN ENDED / 本轮已结束`；只说明收到本轮结束事件，结果仍需回工作区确认。Claude Stop、Codex task_complete / turn_complete 和 DEMO 同步使用该语义。
- 本轮结束摘要优先于遗留工具命令，避免在已结束的会话上继续显示旧命令。
- 空态区分 HUD 连接中 / 失败、尚无采集状态、入口不可用、等待 Hook 验证、连接采集入口和未发现可确认会话。窗口位置错误不归类为 Agent 采集故障。
- Claude 入口首个已验证事件前为 `waiting`，Codex proxy 握手前为 `connecting`；不通过匹配诊断字符串推断状态。连接 HUD 不等于 Agent 已接入，也不能据无会话判断 Hook 未安装。
- Collector 面板列明原生 Claude、rollout 与共享 daemon 的能力限制，不断言用户当前运行了某个不支持模式。
- 保留 1+N、手选 / Auto、详情意图、退出立即清理与拒绝误唤醒；未新增 Pin、历史存储或设置。

## 自动检查

| 检查 | 本轮结果 |
|---|---|
| 新增测试先于实现 | 前端定向测试先复现 11 项失败，46 项通过；日志 `lightweight-red.log` |
| `npm run check` | TypeScript 通过，4 文件 / 84 项通过 |
| `cargo fmt -- --check` | 通过 |
| 严格 Clippy | all-targets、`-D warnings` 通过 |
| `cargo test --locked` | 73 项通过，含新增旧 Stop / turn_complete 和重复完成回归 |
| `npm run desktop:build` | Release 通过，含生产前端构建 |
| `scripts/verify-native.cjs` | 最终 25 组通过，0 页面错误、0 模型调用 |
| `scripts/verify-window.ps1` | 无会话隐藏、置顶、ToolWindow、NoActivate、前台不变通过 |

原生检查首次在既有托盘前台一致性断言失败（两个 HWND 不同）；未改断言或产品窗口逻辑，单独复跑通过。第一次不算通过，不能从一次重跑推断所有焦点竞争已解决。

新增原生用例验证真实 WebView 的入口限制、本轮结束文案、后台结束不抢手选以及空态故障提示。退出、晚事件、resume、审批层与窗口身份等其余覆盖来自受控 fixture，不冒充真实 Agent 行为。

## 真实入口与授权

- 本机实际版本：Claude Code `2.1.296`；Codex CLI `0.163.0`，由 npm 包装入口定位原生 exe。Codex 的历史 `0.162.1` 来源记录不能当作本轮版本验收。
- 用户授权仅限 scratch 可丢弃项目、新建专用终端、每个 Agent 最多 6 轮；不自动批准操作、不改个人全局配置、不操作已有会话或 daemon。
- 最初将 CLI 配置根指向空目录，导致无法找到认证；这是测试隔离方式问题，不是用户未配置或产品故障。随后只读复用既有服务配置，将认证传入子进程环境，不复制凭据文件、不在结果中记录秘密。
- CLI `login status` 不能判定自定义服务配置的可用性。本轮以真实调用结果为准，不要求重新登录。
- 模型测试的项目、Hook 设置、事件、会话和 WebView profile 均在 scratch。真实日志仅记录事件类型、数值遥测与预期标记是否出现，不进入仓库。

| 真实入口 | 结果与边界 |
|---|---|
| Claude 2.1.296 `--print` + stream-json + 临时 Hook 设置 | 1 轮，Read 返回、预期标记到达、exit 0。HUD 观察到 Idle → Thinking → Tool Running → Thinking → Idle / DONE，遥测更新，随后会话移除 |
| Codex 0.163.0 `exec --json` 第一次 | 1 次尝试；启动器保留 stdin PIPE，180 秒内无事件，未完成。不是产品成功或模型兼容性结论 |
| Codex 同版本定向重试 | stdin 改为 DEVNULL，仅重试 Codex 1 轮。exit 0；HUD 观察到 Thinking / Responding / Tool Running / Idle-DONE、exec 的 OBSERVED / RETURNED、遥测及退出清理。预期标记未出现，测试任务不通过 |
| 专用 Windows Terminal + PowerShell 补测 | Claude 增加 1 轮 `--resume`，恢复同一测试 session ID、Read 与标记通过；Codex 增加 1 轮无工具标记请求通过。两个 Agent 曾同时显示，最终清理；两次返回 IPC 均被 Windows 拒绝前台切换 |

Codex 的本次工具输出含命令被拒绝 / 错误文本，但未提供可直接映射的结构化失败状态；`RETURNED / 已返回`只表示收到返回，不代表命令成功。结束事件无结构化 error，仍表示本轮结束，不据文本推造新状态。本轮未改采集解析以迎合单个测试结果。

最初两个 CLI 没有 Terminal 绑定；补测在新建 Windows Terminal 中运行，HUD 分别绑定唯一 PowerShell 祖先窗口。各调用一次返回 IPC，得到 Windows 拒绝切换前台窗口，不重选其他窗口。受 Windows 前台权限限制，仍需用户实际点击验证成功前置；本轮不强制抢焦点。

本轮总计 Claude 2 次、Codex 3 次尝试。原 CLI 测试 runner / Agent / HUD 已退出；专用终端测试结果和清理见 `real-terminals/`。前期两个后台 shell 启动在 Agent 启动前被宿主回收，不计模型轮次。关闭 Codex stdin 后有成功事件，仅视为复测条件，不声称严格证明首个超时的唯一根因。

真实交互式 Waiting / 人工审批与解除、共享 daemon 互通、VS Code 返回和成功前置尚未通过：当前有证据的测试入口为 print / exec，不能产生可供人工操作的完整 TUI 审批流程；未自动批准任何操作。模拟 fixture 覆盖不能替代这些项目。第一批保留待交互验收，不进入第二批。

## 复现自动检查

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

```powershell
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
# 串行执行，9431 必须空闲；输出目录为可丢弃绝对路径。
node scripts/verify-native.cjs $env:TEMP $module 9431
powershell.exe -NoProfile -NonInteractive -File scripts/verify-window.ps1 -AppPath ./src-tauri/target/release/coding-agent-hud.exe -OutputDirectory $env:TEMP
```

## 证据位置与剩余边界

本次 scratch：`C:/Users/tommy/.pi-desktop/scratch/0c47c82e-13d8-4cee-9fc3-71523e8fa884`。

- 自动日志：`lightweight-frontend.log`、`lightweight-rust.log`、`lightweight-clippy.log`、`lightweight-build.log`、`lightweight-native-final.log`、`lightweight-window.log`。
- 原生结果与截图：`native-e2e-1792132815727/result.json`、`collector-limits.png`、`turn-ended.png`。截图已生成，页面文案与行为以 DOM / IPC 断言验证。
- 真实 CLI 脱敏证据：`real-windows/{observation,claude-result,codex-result}.json`、`real-codex-2/{observation,codex-result}.json`、`real-terminals/{observation,claude-result,codex-result}.json`；首个 observation 明确 `timeout: true`，不能看脚本 exit 0 就认定业务通过。
  这些文件和 Agent 自身产生的测试 transcript 留在 scratch，不提交；没有读取或输出其他会话内容。
- Release exe SHA-256：`d1e9e7d16ce38329593a444f6620e7096b23d0010182829a97924ee56df11880`。
- 无新增依赖、锁文件变更、提交 / 推送 / 合并。宿主 `.pi/plan/` 文件原样保留。
- 不以非交互 print / exec 证明人工审批或终端返回；物理多屏、全局 Alt / 托盘鼠标、8 小时与性能仍属未验收。
