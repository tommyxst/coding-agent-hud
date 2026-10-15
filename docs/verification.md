# M1 开发版验证记录

最新 2026-10-15 窗口恢复修复、托盘操作变化及构建输出见 `docs/window-recovery-verification.md`；下文保留上一轮记录。
本文保留各轮修复完成时的记录；后续提交、主干同步与 CI 状态以 Git 历史和对应提交的检查结果为准。

## 本轮验收修复：2026-10-14
分支 `fix/m1-acceptance`，基于 `50f4040adfd8b21cb14cf1e5a77cc0fd126bb1e6`。本轮未暂存、提交、推送、合并或运行远程 CI，不声明完整 V0.3 MVP 或真实 Agent 验收通过。
原始 PRD、`UI&UX`、用户 `AGENTS.md` 和 `docs/m1-acceptance.md` 未修改，依赖与锁文件未改。

## 修复与指定模型评审
| 修复项 | 评审模型 | 处理结果 |
|---|---|---|
| Claude 接入与诊断 | gpt-6-astra | 授权合并 9 个 Hook；修复窄 matcher 错误去重和显式 null 校验；原配置保留 |
| 近期工具反馈 | gpt-6-astra | 修正并行晚返回、失败保护、观察排序及最新重复组遗漏；补短批次和历史 / 实时验证 |
| 详情稳定 | gpt-6-astra | 会话级详情意图；打开时手选；切换 / 移除 / Auto 清除旧意图 |
| 字号与旧设置迁移 | grok-4.7 | 无阻塞发现；正文默认 15 px、辅助 14 px，范围 12–20 px；旧偏好保留 |
| 窗口拖动 | gpt-6-astra | 无阻塞发现；补左键单次触发、右键忽略、错误清除和 Compact 回归 |
| 窗口置顶 | gpt-6-astra | 修复相同目标失败后不能重试，以及旧请求成功 / 新请求失败时实际状态失真 |
| 动画连续性 | gpt-6-astra | 修复标签宽度导致屏幕坐标跳位、首次从 body 按 Tab 不停止动画；补回归 |

评审为只读静态检查，具体发现已由主代理修正并复测，不替代实机验收。当前状态、近期观察、动画独立；最多保留 8 条工具元数据，显示最近 3 组已观察 / 已返回 / 失败，不伪造持续 Running，启动重建不回放历史反馈。图钉控制窗口置顶，会话 Pin 延期，手选 / Auto 保留。

## 已通过的检查
| 检查 | 本轮结果 | 验证边界 |
|---|---|---|
| `npm run check` | TypeScript；4 个文件、71 个 Vitest 测试通过 | 状态、排序、详情、隐私、设置 v2 / v1 迁移、组件、IPC 初始化 |
| `node --test scripts/configure-claude-hooks.node.cjs` | 4 个测试通过 | 原始字节备份、BOM / CRLF、保留、幂等、非法结构、matcher |
| `scripts/verify-m1-ui.cjs` | Headless Edge，34 项通过，无 page error | 字号 12 / 15 / 20 × 视口 900 / 372 / 320 / 280 px；详情跨状态；动画坐标、终止 / 隐藏 / reduced-motion / 首次 Tab / 切换清理 |
| `scripts/verify-m1-native-mock.cjs` | 6 组通过，无 page error | App 受控 IPC Promise、置顶重试 / 串行、拖动事件、详情 Auto、长工具名坐标；无 OS 动作 |
| `npm run build` | 通过；最终桌面构建再次执行 | 生产前端资源 |
| `cargo fmt -- --check` | 通过 | Rust 格式 |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过 | 严格静态检查，未放宽告警 |
| `cargo test --locked` | 28 个测试通过，0 失败 | 尾读、协议、脱敏、观察、并行返回、进程与窗口策略 |
| `npm run desktop:build` | 退出码 0 | 动画评审修正后的 Windows Release；无安装包 |
| `cargo build --release --locked --bin agent-hud-hook` | 退出码 0 | 更新后的 helper，包含 `tool_use_id` |
| `scripts/verify-window.ps1` | 通过 | 隔离启动、空会话隐藏、Topmost / ToolWindow / NoActivate，前台 HWND 不变 |
| `scripts/verify-native.cjs` | Release 真实 IPC，8 组通过 | 双进程发现、历史抑制、短工具批次、Claude 返回关联、实际置顶、字号 20 / Expanded 尺寸、隐私、退出隐藏 |
| 授权 Hook 配置只读核对 | 9 个事件匹配新 Release helper，原设置和 Hook 保留 | 不输出配置内容、不再次写入 |
| 最终差异检查 | `git diff --check` 通过；暂存区为空；凭据模式扫描无匹配 | 未提交；target / dist / node_modules 被忽略 |

隔离链路使用 Rust 测试程序副本，命名为 `codex.exe` / `claude.exe`。Claude 直接写脱敏 Hook fixture，不证明真实 Claude 执行了 helper；Codex 短调用 / 返回追加后，观察为已返回，最新 runtime 为 Thinking。
图钉经 DOM 点击、真实 IPC 验证 Windows 样式：置顶 `0x8000198`，取消 `0x8000190`，再次置顶恢复，ToolWindow / NoActivate 保留。字号变化先等异步窗口尺寸更新，再断言内容适配。
测试未启动真实 Agent 或触发其模型调用。原生测试隔离 `CODEX_HOME`、`HUD_EVENT_DIR`、`WEBVIEW2_USER_DATA_FOLDER`，不用真实 session / transcript，不修改用户 HUD 偏好。

## 构建输出
最终功能构建：2026-10-14 18:40:59，UTC+08:00。之后仅更新测试脚本、文档、截图和注释，无运行行为变更。
| 文件 | 字节大小 | SHA-256 |
|---|---:|---|
| `src-tauri/target/release/coding-agent-hud.exe` | 9,485,312 | `c85e86bd16fd015bab4773bbdb5e5e9f5ba716e982c2c75d01f22961d3fd2efc` |
| `src-tauri/target/release/agent-hud-hook.exe` | 356,864 | `7210ac89f7741ac0389557d8689a597f23387e5f101ea8bbc533d80a7a1fe972` |
产物仅留本地，未上传、未发布 Release。已查看合成截图：`docs/screenshots/m1-default-font.png`、`m1-large-font.png`、`m1-native-fixture.png`，不作为真实采集或物理输入证据。

## Hook 安装与备份
本轮按明确授权将 9 个 HUD Hook 合并到用户级 Claude 配置，保留原设置和 Hook，指向本地 Release helper。
原始字节备份：`C:/Users/tommy/.pi-desktop/scratch/86707e53-477f-472f-9e23-86ef365658c1/claude-hook-backup/claude-settings-before-hud-4f96b10c-6d2a-477a-bed8-96a33186b693.json`。
备份含用户配置，不进仓库。scratch 随本会话删除而清理；长期保留前请复制到仓库外私有目录。不要用旧备份覆盖安装后新增的设置。
复验时运行新 HUD、启动新 Claude 会话。安装及选择性手工撤销见 README 的 Claude Hook 集成部分。

## 未验收项与数据源边界
- 真正交互式 Claude / Codex 的状态准确性、实际 Hook 执行及版本兼容。
- 物理拖动、全局 Alt、托盘、实际穿透、窗口遮挡和终端前置；样式 / 模拟点击不替代这些检查。
- 8 小时运行、CPU / 内存、发现时间和事件延迟测量。
- Codex 0.162.1 rollout 不保存全部审批、流式输出、工具和瞬时错误；近期观察不能补造缺失事件，实时入口仍属 M2。
- Claude helper 需原生 `claude.exe` 祖先；npm / Node / WSL、Transcript 遥测、完整卸载流程，以及多屏 / DPI、启动和安装包继续按 M2 / M3 推进。

## 复现检查
Rust 命令均显式指定项目 manifest；Hook 配置 Node 测试不属于默认 `npm run check` 或远程 CI。
```bash
npm run check
node --test scripts/configure-claude-hooks.node.cjs
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --bin agent-hud-hook
```
浏览器检查先在另一个终端运行 `npm run dev` 并等 1420 端口就绪。用已有 Playwright，不新增依赖或自动安装全局软件：
```powershell
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
node scripts/verify-m1-ui.cjs $module (Join-Path $env:TEMP 'hud-m1-ui')
node scripts/verify-m1-native-mock.cjs $module (Join-Path $env:TEMP 'hud-m1-native-mock')
```
原生检查先完成 Rust 测试和 Release 构建，确认 WebView2，并选空闲的本机 CDP 端口：
```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/verify-window.ps1 -AppPath ./src-tauri/target/release/coding-agent-hud.exe -OutputDirectory $env:TEMP
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
node scripts/verify-native.cjs $env:TEMP $module 9425
```
原生脚本创建唯一临时目录，仅连接自身 WebView，结束时关闭测试进程；日志和截图留输出目录。CDP 仅绑定本机、仅用于测试，正常启动不启用。

## 初始 M1 基线
修复前通过 50 个前端测试、23 个 Rust 测试、50 项 DEMO 和 28 项 IPC mock。这是历史基线，不代表本轮数量或完整 MVP 验收；原始 `docs/screenshots/hud-preview.png` 保留。
