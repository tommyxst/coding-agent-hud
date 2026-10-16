# M3 分批方案与设计边界

## 目标与顺序

M3 补齐基础 WSL2 与 Windows 产品化，不把 M2 隔离验证当真实 Agent 验收。先交付不依赖用户系统配置的窗口位置，再接入 WSL；M2 的真实 Agent、物理交互与性能欠验收继续保留。

| 批次 | 交付 | 前置与验收 |
|---|---|---|
| M3-A，本轮 | 显示器身份、位置持久化、DPI 换算与可见范围恢复 | 坐标与配置回归、Windows 重启 / 托盘 / 非激活检查；物理混合 DPI 单独验收 |
| M3-B1 | 纯 Rust 解析核心、版本化来源协议、Windows 来源隔离 | 同 ID / PID 不冲突，断线只清本来源；坏帧、越权来源、隐私回归 |
| M3-B2 | 一个明确启用的 WSL2 发行版 / 非 root 用户的 Claude 闭环 | 安装与 Hook 授权；真实发现、等待 / 解除、退出 / resume、断线与卸载 |
| M3-C | WSL Codex 与遥测，Windows / WSL 并行 | Linux 持有者验证；只连已有 daemon；Context 未知不猜；真实 WSL 回归 |
| M3-D | 当前用户安装 / 卸载与可选开机启动 | 稳定 exe 路径、显式启用 / 禁用、防重复实例；另行授权系统注册 |
| M3-E | 签名与发布验收、性能结项 | M2 / M3 真实验收、签名授权；8 小时、空闲 CPU < 1%、发现 < 2 秒、响应 < 500 ms |

本轮不启动发行版、修改 Agent 配置、调用真实模型、添加依赖或发布制品。WSL 仍是 MVP 必达项，不因分批而删除。

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
- 版本化、限长 UTF-8 JSONL：握手、完整快照、upsert、remove、诊断与连接存活；包含连接 generation 和单调 sequence。完整快照提交后才开放来源；重复丢弃、缺口重同步、旧连接拒绝。
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
- 管道 EOF 后 helper 自行退出，连接 lease 仅诊断不可用，不能推断 Agent Done / Error。不能假定 Windows Job 一定回收 Linux 子进程。
- EOF、协议错误、崩溃或发行版关闭时清除本来源会话、保留离线诊断；Windows 会话不受影响。首批显式重连 / 下次 HUD 启动连接，不反复唤起用户主动关闭的发行版。
- 重连重新核验进程并交付完整快照，不回放历史 Attention；队列溢出中止增量并重新同步，不静默丢状态。

## WSL 接入前必须改的现有边界

| 现有入口 | 问题与后续改动 |
|---|---|
| `model.rs::Session::new`、`codex.rs` | 固定 Windows ID；增加来源 / distro，并保证跨环境会话唯一 |
| `collector.rs::sync_codex` | 按 Agent 类型全量清理；必须改为来源内清理，避免误删 WSL |
| `collector.rs` 进程退出清理 | Windows PID 只能清理 Windows 来源，Linux 身份必须附带 starttime / 来源 |
| `collector.rs`、`Panels.tsx` 诊断 | 目前偏向 agent 键 / 标签；为 bridge 和多发行版定义独立来源标识 |
| `lib.rs`、`native.rs`、`tail.rs`、`build.rs` | 无条件 Windows / Tauri 依赖；仅共享纯逻辑，平台操作保留各端 |
| `model.rs`、`src/model.ts`、`Hud.tsx` | Rust 缺 distro，cwd 必填；契约改为真实缺失语义并回归展示 |

## 后续授权与验收

WSL 开始前确认目标发行版 / 用户、helper 安装与精确 Hook 合并范围；真实模型调用单独授权。本轮只读确认 Ubuntu 和 docker-desktop 为停止的 WSL2，未启动或探测内部版本；不能据此声称 Linux Agent 可用。

性能统计覆盖 Windows HUD、proxy 与 Linux helper 总体；区分 Agent 源端延迟与 HUD 处理延迟。Linux CI 不能代替真实 WSL 管道。签名、开机注册和发布须另行授权。

方案依据：PRD 第 26、33、34 节；`docs/development-plan.md`；当前 Tauri 2.12.3 与 windows-sys 0.61.2 锁定源码。M3-A 使用与复现见 `m3-verification.md`；M2 的剩余验收见 `m2-verification.md`。
