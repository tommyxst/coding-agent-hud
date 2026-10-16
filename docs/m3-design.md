# M3 分批方案与设计边界

## 目标与顺序

2026-10-16 按已批准轻量 HUD 计划修订：只负责看状态、适度提示、快速回终端。保留原 PRD，不沿用其中已被本次收敛排除的扩展项；M2 和 M3-A 历史验证不改写为新成果。

| 批次 | 最小交付 | 验收边界 |
|---|---|---|
| M3-A 已实现 | 显示器身份、位置保存、DPI 换算与可见范围恢复 | 历史结果见 `m3-verification.md`，物理多屏仍待验收 |
| 第一批，当前 | Windows 本轮结束语义、空态 / 采集诊断、真实发现 / 提示 / 返回 | 保留 1+N 和手选 / Auto；未测模式明确保留，见 `windows-loop-verification.md` |
| 第二批 | 一个主动启用的 WSL2 发行版、一个普通用户；先 Claude 后 Codex | Windows / WSL 来源隔离、源端脱敏、退出清理，真实单发行版闭环 |
| 第三批 | 现有 Collector 面板的接入 / 移除、Rust Hook 配置、当前用户 NSIS 安装 | 无需 Node / Rust，精确卸载、升级路径、单实例及默认关闭的开机启动 |
| 第四批 | 桌面 / 多屏与总体资源测量 | 8 小时、空闲 CPU < 1%、发现 < 2 秒、入口收到事件后响应 < 500 ms；源端延迟单列 |

不新增会话 Pin、通知收件箱、历史存储、时间线、搜索分组、控制面、云同步或插件平台。声音、系统通知、磁吸、Git diff、更多 Agent 与 tab 定位不属必做。当前只实施第一批，不并行铺开后续功能。

## M3-A 位置模型

- Rust `placement.rs` 管理原生位置，前端只负责内容尺寸；不保存窗口尺寸、会话或 transcript。
- 保存版本号、Windows 显示器设备接口标识、相对工作区左上角的逻辑像素偏移。接口标识来自 `EnumDisplayDevicesW` 的设备接口路径，不使用重排的 DISPLAY 编号；换接口 / 驱动后标识变化按屏幕缺失处理，不承诺跨硬件重装不变。
- 按目标显示器当前 scale 换算物理坐标，工作区不含任务栏。负坐标副屏与 125% / 150% / 200% 纳入纯测试。
- 启动、内容尺寸变化、DPI 事件及显式托盘恢复时校正可见范围；窗口大于工作区时至少保证左上拖动入口可达。不改变置顶或获取焦点。
- 屏幕缺失时明确诊断并恢复至主屏；新的实际位置在后续移动事件中成为保存位置。采用实际位置而非额外保留虚拟锚点，避免维护第二套位置意图；重新连接屏幕后需手动拖回。
- 移动停止 250 ms 后合并写入，同一位置不重复写；先写同目录临时文件，再原子替换。正常退出冲刷待写位置；强制终止可能丢失最后一次尚未写入的移动。
- 最小化不保存系统的特殊坐标，也不因后台变化恢复窗口。移动过程中不约束坐标，避免阻止跨屏拖动。
- 默认文件 `%APPDATA%/dev.tommyxst.coding-agent-hud/window-position.json`。`HUD_PLACEMENT_FILE` 可指定绝对文件路径，用于明确隔离的验证环境。
- 文件限 4 KiB，未知字段 / 版本、非法数值、坏 JSON 均报 `window-placement` 错误，本次禁用保存且保留原文件。退出后修复或删除该文件，再重启恢复；写失败也进入诊断，不冒充保存成功。
- 屏幕身份缺失或歧义时拒绝猜选，不升级到显示名称或序号匹配。实际多屏 / 热插拔 / 混合 DPI 不能由坐标测试替代。

## WSL：来源和传输

推荐 Windows 以参数数组启动明确配置的 `wsl.exe --distribution <distro> --user <user> --exec <绝对 helper 路径>`，使用专用 stdin / stdout；不执行登录 shell、不监听 TCP、不搬运原始日志、不高频扫描 `\\wsl.localhost\`。

- Windows 为受控连接分配 `sourceId`，绑定 distro / UID / helper 版本；wire 消息无权伪装 Windows 或其他来源。
- 首版限长 UTF-8 JSONL 只做版本握手、状态变化时的完整来源快照与必要诊断。连续变化合并；每份快照只替换绑定来源，旧连接回调失效。协议错误明确断开，不先做增量事件总线、ACK / 重放或持久化队列。
- 原始 Hook、transcript、Git 与完整路径处理都在 Linux。跨界只传白名单：会话标识、项目显示名 / branch、状态枚举、工具名、模型、数值遥测与时间。
- 首批不传 cwd / 完整路径 / 命令；不得把现有 `Session` 或 `HookEvent` 直接序列化成 wire DTO。前端缺字段显示未知，不能以空字符串冒充已知路径。
- Prompt、回复、工具参数 / 输出、凭据和 transcript path 不进入协议、stderr 或错误回显。来源边界不声称能抵御同 UID 恶意进程或发行版 root。
- Windows 终端绑定留空；Linux PID 永不进入 Windows Return to Workspace，首批不推测 Terminal tab。

## WSL：采集和生命周期

- 建议仅提取必要的纯解析核心至 `crates/hud-core/`，Linux 无 GUI helper 独立构建于 `crates/hud-wsl/`，不依赖 Tauri / Win32；不建设通用插件平台。
- Linux 本地 `notify` 与增量尾读；有限启动重建，不定时扫描全文或运行 Git。文件身份使用 device / inode，保留半行、截断和等长替换回归。
- Claude helper 校验 `/proc` UID、原生可执行文件、祖先链和 starttime；不能只信 Hook payload 的 PID。退出观察方案须核实目标内核与现有依赖，不能静默改为高频进程扫描。
- 事件目录限定目标用户，拒绝非预期所有者 / 符号链接；原子发布、消费后删除，并明确离线容量与过期规则。
- End、异常退出、PID 复用、显式 resume 分开处理；历史 transcript 不注册活跃会话。
- 控制管道 EOF 后 helper 自行退出，不安装常驻服务。若需要连接存活检查，仅用于诊断不可用，不推断 Agent Done / Error；不假定 Windows Job 必然回收 Linux 子进程。
- EOF、协议错误、崩溃或发行版关闭时清除本来源会话、保留离线诊断；Windows 会话不受影响。首批显式重连 / 下次 HUD 启动连接，不反复唤起用户主动关闭的发行版。
- 重连重新核验进程并发送当前完整快照，不回放历史 Attention；帧 / 队列设置上限，溢出明确断开，不静默漏掉状态。

## WSL 接入前必须改的现有边界

| 现有入口 | 问题与后续改动 |
|---|---|
| `model.rs::Session::new`、`codex.rs` | 固定 Windows ID；增加来源 / distro，并保证跨环境会话唯一 |
| `collector.rs::sync_codex` | 按 Agent 类型全量清理；必须改为来源内清理，避免误删 WSL |
| `collector.rs` 进程退出清理 | Windows PID 只能清理 Windows 来源，Linux 身份必须附带 starttime / 来源 |
| `collector.rs`、`Panels.tsx` 诊断 | 目前偏向 agent 键 / 标签；为 bridge 和多发行版定义独立来源标识 |
| `lib.rs`、`native.rs`、`tail.rs`、`build.rs` | 无条件 Windows / Tauri 依赖；仅共享纯逻辑，平台操作保留各端 |
| `model.rs`、`src/model.ts`、`Hud.tsx` | Rust 缺 distro，cwd 必填；契约改为真实缺失语义并回归展示 |

## 简单接入与交付

- 只在现有 Collector 面板提供检查、接入 / 移除；明确用户确认后才写所选配置。Rust 实现沿用原字节备份、合并、幂等、精确卸载和并发变更拒绝，不要求终端用户安装 Node。
- NSIS 当前用户安装包包含 HUD 和 helper，稳定路径、升级 / 卸载、单实例、可选开机启动分别验证。首版手动下载安装包更新，不加后台更新服务。
- 没有签名条件时只能标为未签名测试包；正式签名和分发另行授权。核心闭环、交付、桌面与性能达标后停止扩张。

## 后续授权与验收

WSL 开始前确认目标发行版 / 用户、helper 安装与精确 Hook 合并范围；真实模型调用单独授权。本轮只读确认 Ubuntu 和 docker-desktop 为停止的 WSL2，未启动或探测内部版本；不能据此声称 Linux Agent 可用。

性能统计覆盖 Windows HUD、proxy 与 Linux helper 总体；区分 Agent 源端延迟与 HUD 处理延迟。Linux CI 不能代替真实 WSL 管道。签名、开机注册和发布须另行授权。

方案依据：PRD 第 26、33、34 节；`docs/development-plan.md`；当前 Tauri 2.12.3 与 windows-sys 0.61.2 锁定源码。M3-A 使用与复现见 `m3-verification.md`；M2 的剩余验收见 `m2-verification.md`。
