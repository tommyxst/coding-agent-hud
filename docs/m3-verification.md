# M3-A 使用与验证

本地日期：2026-10-16（UTC+08:00）。任务分支 `feat/m3-window-placement`，基于 `d921336cf2922764e5b134da8389ba9bca0b9d09`。本轮只交付位置 / DPI 开发版和 M3 / WSL 设计，不声明完整 M3 或 MVP 验收。

## 使用

启动 HUD 后，按住 Alt 或从托盘进入交互，用专用拖动柄移动。移动停止 250 ms 后保存，正常退出也冲刷待写位置；强制终止可能丢失最后一次移动。

默认文件：`%APPDATA%/dev.tommyxst.coding-agent-hud/window-position.json`，仅包含 `version`、`monitor`、`x`、`y`。`monitor` 是 Windows 设备接口标识，不是 DISPLAY 序号；偏移为工作区内逻辑像素。不保存尺寸、会话、Prompt、命令或 transcript。

启动按目标屏幕当前 DPI 恢复；内容增长和显式托盘恢复会约束到工作区。屏幕缺失时明确提示并回主屏，后续保存实际位置；接回原屏需手动拖回。硬件接口 / 驱动改变可能产生新设备标识，不宣称跨此类变化保持同屏绑定。

坏 JSON、未知字段 / 版本、非有限坐标、超出 4 KiB 或无法读取时，Collector 状态显示窗口位置错误，本次禁用保存且不覆盖原文件。退出后修复或删除位置文件再重启。写入失败有独立错误，不冒充成功；测试使用显式绝对路径 `HUD_PLACEMENT_FILE`，不会读写真实偏好。

## 本轮检查

| 检查 | 实际结果 |
|---|---|
| `npm run check` | TypeScript 通过；4 文件、72 项 Vitest 通过 |
| `cargo fmt -- --check` | 通过 |
| `cargo clippy --locked --all-targets -- -D warnings` | 通过，无告警豁免 |
| `cargo test --locked` | 71 项通过，包括新增 9 项位置回归 |
| `npm run desktop:build` | Release 通过，含生产前端构建 |
| `scripts/verify-placement.cjs` | 9 组真实 HWND / WebView 检查通过，0 页面错误、0 模型调用 |
| `scripts/verify-window.ps1` | 就绪、无会话隐藏、置顶、ToolWindow、NoActivate 通过；前台未改变 |
| `scripts/verify-native.cjs` | 既有 23 组隔离原生回归通过，0 页面错误、0 模型调用 |

原生脚本串行运行。测试数据、WebView profile、位置文件和事件目录均在本次 scratch，未安装依赖、修改用户配置或调用真实模型。只启用已有 `windows-sys` 的 GDI 功能，锁文件未变；本轮未暂存、提交、推送、合并或运行远程 CI。

位置原生检查覆盖：真实移动保存、最小化不污染、正常重启恢复、内容增长约束、离屏后托盘恢复、移动后立即正常退出、坏配置原字节保护、缺失显示器诊断、原子替换失败且退出不死锁。诊断名称和 Error / Warning 在真实页面及 SSR 回归中验证。

Rust 回归覆盖：负坐标工作区、100% / 125% / 150% / 200%、跨 DPI 偏移换算、分辨率 / 内容增长、窗口超大时拖动入口可达、显示器缺失 / 歧义、配置原子替换和非法输入、连续移动合并与退出冲刷、写失败传播。

## 证据与输出

本次 scratch：`C:/Users/tommy/.pi-desktop/scratch/0c47c82e-13d8-4cee-9fc3-71523e8fa884`。

- 最终位置结果与诊断截图：`native-placement-gCeQjn/result.json`、`placement-error.png`、`placement-warning.png`。
- 原生集成结果：`native-e2e-1792082049041/result.json`。
- 日志：`m3-frontend.log`、`m3-rust-full.log`、`m3-clippy.log`、`m3-release.log`、`m3-native-placement-final.log`、`m3-window-smoke.log`、`m3-native-regression.log`。
- `src-tauri/target/release/coding-agent-hud.exe`：10,052,608 字节，SHA-256 `744dd7eef337e83939539284ea3e145b116ce646ce50a3f449c370136f5b70fb`。仅本地开发产物，不是签名安装包或发布版本。

## 复现

先运行检查与 Release 构建；原生脚本需要 Windows、WebView2、已存在的 Playwright 模块和空闲 CDP 端口。不自动安装依赖。

```bash
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

```powershell
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
# 输出目录必须是明确可丢弃的绝对路径；9427 必须空闲。
node scripts/verify-placement.cjs $env:TEMP $module 9427
powershell.exe -NoProfile -NonInteractive -File scripts/verify-window.ps1 -AppPath ./src-tauri/target/release/coding-agent-hud.exe -OutputDirectory $env:TEMP
node scripts/verify-native.cjs $env:TEMP $module 9427
```

## 未验收与后续

- 本机仅一个真实显示器，150% 缩放；坐标回归不代替物理多屏混合 DPI、跨屏拖动、热插拔、系统缩放改变或镜像屏身份检查。缺屏原生用例是不存在的保存标识，不是实际拔屏。
- 诊断截图已生成，页面文案断言通过；图像插件拒绝读取 scratch 路径，本轮未做截图视觉复核。
- 原生动作与托盘通知由脚本投递，未验证物理拖动、实际托盘鼠标、全局 Alt / Win+D。非激活与置顶回归不等于全宿主前置验收。
- M2 真实 Agent、完整瞬时事件、终端返回和性能欠验收保持不变。8 小时、空闲 CPU、发现 / 响应延迟本轮未测。
- WSL2 仅列举发行版；Ubuntu、docker-desktop 均停止，未启动或写入。Linux helper、协议和安装尚未实现，下一批先做来源隔离与协议，再按明确授权接入指定发行版。
- 开机启动、签名和安装包不在本轮；分批与后续授权见 `m3-design.md`。
