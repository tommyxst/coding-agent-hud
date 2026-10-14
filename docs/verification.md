# M1 开发版验证记录

本次交付是 Windows 开发版，不是完整 V0.3 MVP 验收。原始需求和 `UI&UX` 设计资料未修改。

## 已通过

| 检查 | 结果 | 验证边界 |
|---|---|---|
| `npm run check` | 4 个文件，50 个 Vitest 测试通过；TypeScript 通过 | 排序、Pin / Auto、Done 生命周期、未知值、隐私、设置 schema、IPC 初始化/清理、组件渲染 |
| `npm run build` | 通过 | Vite 生产资源构建 |
| Browser DEMO | 50 项检查通过 | 四模式、Pin / Auto、后台 Attention、Done 超时、隐私、设置恢复、未知遥测、空状态、键盘、减少动态效果 |
| Browser 尺寸 | 372 / 320 / 280 px 下长内容无横向溢出 | 浏览器排版，不等于 Windows 多屏 / DPI 验收 |
| Native IPC 模拟 | 28 项检查通过 | 命令参数、事件顺序、尺寸变化、错误显示、临时交互策略；不是 OS 输入行为的证据 |
| `cargo fmt -- --check` | 通过 | Rust 格式 |
| `cargo clippy --all-targets -- -D warnings` | 通过 | 严格静态检查，不放宽告警 |
| `cargo test --locked` | 23 个测试通过 | JSONL 半行 / UTF-8 / 截断 / 去重、协议新旧格式、脱敏、状态、窗口策略、原生文件持有者与退出通知 |
| Windows debug 构建 | 主程序和 helper 通过 | 已修复缺失 ICO 和 PDB 文件名冲突 |
| Windows 原生启动 | 通过 | 使用隔离目录，确认空会话隐藏、Topmost、ToolWindow、NoActivate；启动前后台 HWND 不变 |
| `npm run desktop:build` | 退出码 0 | Release 构建成功，未打安装包 |
| Release 原生链路 fixture | 通过 | 内置资源加载 → 真实 Tauri IPC → 文件发现 → Thinking / Tool Running 更新 → 默认命令脱敏 → 进程退出清理；未导入 DEMO chunk |
| 暂存检查 | 通过 | 新代码 whitespace 检查；凭据前缀 / 私钥块扫描；target / dist / node_modules 排除 |

原生文件持有者测试使用当前测试程序的合成副本，命名为 `codex.exe`，持有一次性 fixture 文件。Release 端到端检查也只使用合成进程和临时目录，没有启动真实 Agent，没有模型调用，也没有修改用户 Claude / Codex 配置。

浏览器 Active 外围测得 `372 × 318`，Expanded 为 `372 × 516`。此处包含 12 px 外围 padding 和多会话堆叠，不是 PRD 的单张 Primary Card 尺寸。

## 构建输出

- `src-tauri/target/release/coding-agent-hud.exe`：9,332,224 字节。
- `src-tauri/target/release/agent-hud-hook.exe`：359,424 字节。
- 可执行文件留在本地构建目录，不上传到 Git 仓库；未发布 GitHub Release。
- 合成数据预览见 `docs/screenshots/hud-preview.png`，图中 DEMO 不代表真实采集。

## 功能缺口（尚未实现）

- Codex 审批 / 瞬时事件的官方实时补充入口，rollout-only 没有实现完整 Waiting User 检测。
- Claude Hook 自动安装 / 卸载、npm / Node 包装版支持、Transcript Token / Context 补充。
- WSL 本地 Collector、完整终端映射、多屏 / DPI 位置保存、开机启动和签名安装包。

## 尚未完成实机验收

- 真正交互式 Claude / Codex 的状态准确性与版本兼容。本次只核对版本和官方协议，合成数据不等于真实 Agent 联调。
- 全局 Alt / 托盘操作、实际鼠标穿透、多种终端前置；窗口标志与 IPC 模拟不是完整桌面交互证据。
- 8 小时运行、CPU / 内存、发现时间和事件延迟测量。

## 复现隔离原生检查

先完成 `cargo test --locked --manifest-path src-tauri/Cargo.toml` 与 `npm run desktop:build`，并确认本机安装了 WebView2。

窗口检查在新的 PowerShell 进程运行，只给子进程传入隔离目录，不修改当前 Shell 或 Agent 配置：

```powershell
powershell.exe -NoProfile -NonInteractive -File scripts/verify-window.ps1 -AppPath ./src-tauri/target/release/coding-agent-hud.exe -OutputDirectory $env:TEMP
```

端到端检查要求已有 Playwright 模块（本次使用已有 `@playwright/cli` 工具，不新增项目依赖，也不自动安装全局软件）。明确传入模块绝对路径和空闲的本机 CDP 端口：

```powershell
$module = Join-Path $env:APPDATA 'npm/node_modules/@playwright/cli/node_modules/playwright/index.js'
node scripts/verify-native.cjs $env:TEMP $module 9425
```

脚本会创建带唯一后缀的临时目录、仅连接自身 Release 实例的 WebView、启动合成文件持有进程，结束时关闭这些测试进程。CDP 只绑定本机且仅用于测试；正常应用启动不启用它。输出日志和截图留在显式指定的临时目录。

GitHub Actions 已配置。线上 CI 状态须按实际提交的 check run 判断；此记录不将配置本身写成 CI 通过。
