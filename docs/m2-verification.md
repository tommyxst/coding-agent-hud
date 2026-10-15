# M2 A / B / C 验证记录

日期：2026-10-15，Windows。任务分支 `feat/m2-agent-reliability`，基于 `ae219423bdbc39982fc4ee4cce0ee92fadc8f8e0`。

M2 实现与开发版隔离验证完成；不声明真实 Agent、完整实时覆盖或整个 MVP 验收通过。本轮未暂存、提交、推送、合并或运行远程 CI；未写用户配置，未调用真实模型。原始 PRD、`UI&UX/`、`AGENTS.md` 和锁文件不变。仅启用已存在的 windows-sys 功能，无新增生产依赖。

## 检查结果

| 检查 | 结果 | 范围 |
|---|---|---|
| `npm run check` | 上轮 4 文件 / 71 测试通过；本轮未重跑 Vitest | 本轮未改前端；桌面构建中的 TypeScript 检查通过 |
| Hook 安装 / 卸载 Node 测试 | 上轮 9 测试通过；本轮未重跑 | 本轮未改配置脚本 |
| `cargo fmt -- --check` | 通过 | Rust 格式；额外检查代理 fixture 格式 |
| 严格 Clippy | 通过 | all-targets、-D warnings，无告警豁免 |
| `cargo test --locked` | 62 测试通过 | 新增恢复、旧元数据、乱序返回及较新终态保护回归 |
| `npm run desktop:build` | Release 通过 | 包括 TypeScript、生产前端和 Windows 可执行文件 |
| Release Hook helper | 随本轮桌面构建更新产物 | 未单独执行 helper 构建命令；入口未改 |
| `scripts/verify-native.cjs` | 23 组通过，0 page error，0 model calls | 新增启动审批回放和 Codex 状态恢复；实际 Release WebView / IPC、模拟 Agent / 代理 |
| `scripts/verify-window.ps1` | 上轮通过；本轮未重跑 | 窗口实现未改；原生链路仍验证托盘 / 置顶 / 焦点 |
| 最终 Git 差异检查 | `git diff --check` 通过，暂存区为空 | 未提交或更改 Git 历史 |

## 关键回归

- Codex 代理的真实子进程管道完成握手、loaded/list、metadata-only read；请求日志仅包含四种白名单方法。
- 审批等待、输入等待、解除、systemError 与 idle；旧 rollout 不清除实时 Waiting，idle 不伪造 Done。
- daemon-only 会话不继承终端 PID；文件会话保留已验证关联；关闭和断线清除实时层。
- 意外审批服务端请求使观察器断开并回收代理，无 result / error / 决策响应；Windows Job 关闭终止受控测试子进程。
- 元数据中的 preview、transcript 正文、工具参数及输出不进入 Snapshot 或诊断。
- Claude 异步 transcript、流式去重、并行工具晚返回、compaction、等长替换、SessionEnd 与显式 resume。
- 真实受控 HWND 验证唯一窗口选择、身份复核、关闭后拒绝重选；不操作用户终端窗口。
- 单次只读复核后修复并行返回误清 Waiting、ElicitationResult 丢失 Running；PermissionRequest 改为候选，明确 permission_prompt 才显示审批等待。无 ID 的关联与源端延迟边界见覆盖表。
- HUD 安装 / 卸载脚本互斥比较到替换区间；不宣称对外部编辑器提供文件 CAS，执行前必须停止其他配置写入。
- 保留托盘恢复、后台采集不恢复最小化 HUD、置顶和字号 / Expanded 尺寸的既有回归。

最终 Release IPC 结果位于本次 scratch 的 `native-e2e-1792059167564/result.json`。日志、合成截图及测试数据在隔离输出目录，不进入仓库。测试将模拟程序命名为 codex.exe / claude.exe；不证明真实 Agent 调用了 helper 或真实 daemon 协议互通。物理鼠标、真实托盘输入和全局 Win+D 未由该脚本验证。

## 三项评审修复复验

- Codex 在 notLoaded / closed 后由新的已加载状态重新开放，不要求 thread/started；旧元数据成功 / 失败跨越恢复的回归均通过。只在有更新状态时补读，不轮询。
- Claude 晚返回移除最后一个等待关联后，按当前 runtime 时间戳同步 Attention；其他输入等待与较新 Done / Error 保持不变。
- 启动回放只清 recent_tools，保留内部在途记录；正式无 tool_use_id 的审批可由后续正确 ID 返回解除。
- 修复前新增 Rust 回归为 59 通过 / 3 失败；旧 Release 原生夹具在实时返回后仍 Waiting 并超时。修复后为 62 项 Rust、23 组原生回归全部通过。
- 日志保存在本次 scratch：`m2-review-red-rust.log`、`m2-review-red-native.log`、`m2-review-green-rust.log`、`m2-review-green-native-ready.log`。原生夹具显式等待启动回放完成，避免把中间快照当最终状态。

## 构建输出

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `src-tauri/target/release/coding-agent-hud.exe` | 9,943,552 | `0c2d83c7cc5fe39f55c5ffd4e5669b7210af3d3390d19d168ee28b075a4c63a2` |
| `src-tauri/target/release/agent-hud-hook.exe` | 359,936 | `5c37535e30e26a793ba7dfcab7119e87b4127bdceb9abe57f1e93d39cf4b8c65` |

两项产物的构建时间均为 2026-10-15 18:09:35（UTC+08:00）；仅本地保留，不是安装包或已发布 Release。

上一轮组合检查曾超时，拆分重跑通过；窗口 smoke 与 IPC 并行时曾有焦点断言失败，串行并保持原断言后通过。复现时不要并行运行桌面窗口检查。

## 复现

```bash
npm run check
node --test scripts/configure-claude-hooks.node.cjs scripts/unconfigure-claude-hooks.node.cjs
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
rustfmt --edition 2021 --check scripts/codex-proxy-fixture.rs
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
cargo build --release --locked --manifest-path src-tauri/Cargo.toml --bin agent-hud-hook
```

原生检查需要 WebView2、现有 Playwright 模块，以及空闲本机 CDP 端口。先执行上述测试与构建，不自动安装依赖：

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/verify-window.ps1 -AppPath ./src-tauri/target/release/coding-agent-hud.exe -OutputDirectory $env:TEMP
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
# 9425 必须未被占用；也可显式传入其他空闲端口。
node scripts/verify-native.cjs $env:TEMP $module 9425
```

脚本使用 rustc 在唯一输出目录编译 `scripts/codex-proxy-fixture.rs`，隔离 CODEX_HOME、HUD_EVENT_DIR、WebView profile 和代理控制文件。只连接自身 WebView，结束时关闭自身进程。代理 fixture 的轮询仅用于测试，不是生产 Collector 行为。

## 尚未验收与后续授权

- 新增 5 个 Claude Hook 尚未安装进用户配置；14 事件安装 / 精确卸载命令见 README，不会随启动自动执行。
- 真实 Claude helper 执行、异步 usage 字段、审批 / 拒绝 / 输入等状态，需要真实交互验证。
- 真实 Codex daemon 互通及等待标记、embedded 回退、多会话与断线重连，需要真实交互验证；握手不能证明 daemon 的版本。
- Windows Terminal / VS Code 各种宿主与多窗口、真实返回前置、物理拖动 / Alt / 托盘 / 穿透仍需手动检查。不能确认时只验证拒绝误唤醒，不宣称全宿主映射。
- 8 小时运行、CPU / 内存、发现和响应延迟未测量；WSL 和产品化仍属 M3。

真实模型调用、用户配置升级 / 卸载需另行明确授权。来源能力及无法覆盖的事件见 `m2-event-coverage.md`；不靠延迟、估算百分比或合成成功掩盖缺口。
