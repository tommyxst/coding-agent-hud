# 窗口恢复修复验证：2026-10-15

本文保留修复完成时的验证记录；后续分支、提交与主干同步状态以 Git 历史为准。

## 使用方式
- 单击系统托盘图标始终显示 / 恢复 HUD，并进入交互模式，重复点击不再切换关闭。
- 退出交互使用托盘右键菜单的退出交互模式；有会话仍显示 HUD，无会话则隐藏。
- Alt 临时交互、穿透策略和图钉的置顶偏好不变；恢复未置顶窗口不把它改为置顶，不主动抢键盘焦点。
- 使用新程序前退出旧 HUD；本轮未自动结束或替换用户正在运行的 HUD 实例。

## 修复与回归
旧实现只调用 `show()`，窗口仍可处于最小化或低层级；内部交互标记又独立于系统状态，托盘切换可能退出而非恢复。
现在用明确的 Reveal / Exit / Alt 动作。显式 Reveal 采用 `SW_SHOWNOACTIVATE` 恢复，再以 `HWND_TOP` 和 `SWP_NOACTIVATE` 提升当前窗口组内层级；不强制 Topmost。后台 publish 不走恢复分支。

新增恢复测试先运行旧 Release，确定失败于 `Timeout: tray restores Minimize`；修复后使用相同路径通过。
`gpt-6-astra` 只读评审未发现生产实现的阻塞缺陷。两项测试发现已处理：后台更新加入真实 fixture 快照变化；会话退出时按显式交互意图保留诊断视图，不再错误断言隐藏。独立 Exit 状态转换另有 Rust 回归。

| 检查 | 结果 |
|---|---|
| Rust 格式、严格 Clippy | 通过，未放宽告警 |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 30 个测试通过，包括重复 Reveal、Exit、Alt 覆盖与空会话策略 |
| `npm run desktop:build` | 退出码 0，包含前端 TypeScript 和生产构建 |
| `scripts/verify-native.cjs` | Release 真实 IPC，13 组通过，无 page error |
| `scripts/verify-window.ps1` | 空会话隐藏，Topmost / ToolWindow / NoActivate；最终运行前台 HWND 不变，HUD 不拥有前台 |
| `git diff --check` | 通过；保留之前未提交改动，未暂存、提交、推送或合并 |

13 组检查包含最小化、隐藏、压低层级后的重复托盘恢复，无会话诊断窗口恢复；恢复前后前台 HWND 相同、未置顶状态保留。后台快照变化不解除最小化，原有采集、隐私、字号和进程退出检查保留。
启动 smoke 不再只在 HWND 出现后固定等 500 ms，而是有界等待初始化及要求的样式；保留前台 HWND 对比，同时以 HUD 是否拥有前台区分自身激活与其他应用焦点变化。

## 构建输出
`src-tauri/target/release/coding-agent-hud.exe`：9,353,728 字节。
构建时间：2026-10-15 12:12:38，UTC+08:00。
SHA-256：`43eec736c1cfbd3039f3e6f83a2981e2e20e46017d0cc9c795e9a5cb32589da0`。
源码保留在 `fix/m1-acceptance`；未打安装包、未发布 Release，未改依赖或 Claude / Codex 配置。

## 复现与边界
按 `docs/verification.md` 的 Rust、Release 与隔离原生命令运行。`scripts/window-fixture-action.ps1` 只操作明确指定的 fixture PID，托盘通知使用锁定的 tray-icon 0.25.1 回调协议。
测试隔离数据目录和 WebView profile，使用合成进程与事件，未启动真实 Agent 或触发其模型调用。
未向整个桌面发送 Win+D，也未物理点击托盘 / 退出菜单；已覆盖相应最小化、隐藏、低层级与托盘处理路径，不将通知注入冒充实际按键验收。
前端未改；本轮未重复浏览器 DEMO 全套和前端单元测试。真实 Agent、物理拖动及长期运行等原有边界仍见上一轮记录。
