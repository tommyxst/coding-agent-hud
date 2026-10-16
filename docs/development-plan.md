# Coding Agent HUD 开发计划

依据：`Coding Agent HUD 产品需求文档 MVP.md` V0.3、`UI&UX/UX.html` 和 5 张界面样例。

## 顾问讨论结论

首次开发前已调用 Pi Advisor。顾问认可 Tauri 2 + Rust + WebView 路线，建议先实现真实 Windows 会话的最小闭环，再扩展完整 MVP。

- UI 只消费统一 Session Model，不直接解析 Agent 文件。
- Activity 与 Attention 独立。`PreToolUse` 表示工具调用，不表示等待审批；M2 将 Claude `PermissionRequest` 收敛为候选，明确 `permission_prompt` 才确认可见审批，不能靠前置 Hook 或超时猜人工等待。
- 不把历史 rollout 当活跃会话；必须验证文件的实际持有进程，并在进程结束时清理。
- 不从累计 token 推测 Context。缺失的模型、容量、终端绑定显示未知。
- 界面预览和真实采集严格分离。浏览器预览必须标记演示模式。
- 新仓库私有；真实 transcript、凭据、构建产物不进仓库。
- 默认不修改用户全局 Claude 配置，不控制权限批准、模型调用或 Agent 执行。M1 修复中仅按用户明确授权合并 HUD Hooks，先备份并保留已有设置。

## 阶段与验收

### M1：Windows 开发版纵切片（本次开始实现）

1. 初始化私有 GitHub 仓库、锁定依赖、建立 Windows CI。
2. Rust 统一模型、Codex rollout Adapter、JSONL 增量尾读与回归测试。
3. 使用文件事件触发采集，验证 Codex 文件持有进程，观察进程退出；不周期执行 git status。
4. 实现 Compact / Active / Attention / Expanded、1+N Stack、手选 / Auto、隐私设置、未知值呈现；按验收决定将图钉改为窗口置顶，会话 Pin 延期。
5. 透明、置顶、非激活窗口、托盘、穿透及托盘恢复交互入口。
6. 只对可确认的 Terminal 窗口提供返回；无法绑定时明确报错，不随便唤醒窗口。
7. Claude 原生 Hook helper 与配置样例：只提取白名单元数据，无正文落盘。

验收：前端类型检查、单元测试、Rust 测试/静态检查、Windows 构建、浏览器交互测试，以及真实采集入口的本地检查。不能用模拟数据通过真实自动发现验收。

### M2：Agent 集成可靠性（A / B / C）

- **M2-A 已实施**：固定 Codex 0.162.1 与 Claude Code 2.1.296 的来源核对，覆盖和排除理由见 `m2-event-coverage.md`。Codex PermissionRequest Hook 不直接等于人工等待。
- **M2-B 已实施**：Codex 已有共享 daemon 的只读全局状态叠加 rollout；不订阅审批、不启动服务。Claude 异步 transcript 白名单遥测、去重、compaction、生命周期清理，以及精确命令卸载脚本。
- **M2-C 已实施**：唯一可见祖先窗口绑定；返回前复核 HWND / PID / 名称 / 创建时间；不猜 ConPTY、标题、cwd 或 tab，关闭的原窗口不重选。
- 回归包括启动前历史抑制、resume、多会话、并行返回、文件等长替换、晚事件、实时状态竞态、断线和代理进程清理。
- 检查、Release 构建和隔离原生结果见 `m2-verification.md`。真实交互式 Agent、真实 helper / daemon、人工审批及各终端返回仍需单独授权和实测。
- 共享 daemon 不能覆盖 embedded / `--no-daemon`，且不提供全部工具 / 回复 / 瞬时错误；不得把 M2 开发版当完整实时验收。
- Context 保留缺失语义和估算标记；不用累计 Token 猜容量。Hook 升级 / 卸载不会自动修改用户配置。

### M3：WSL 与产品化

- 在 WSL 内本地采集，再传输已脱敏事件至 Windows；禁止高频扫描 `\\wsl.localhost\`。
- 基础 WSL2 仍属于 MVP，不因当前阶段仅实现 Windows 而删除。
- 多屏位置与 DPI 保存、开机启动、签名安装包。
- 8 小时内存/CPU、< 2 秒发现、< 500 ms 事件响应的测量验收。
- **M3-A 已实施**：显示器设备接口标识 + 工作区内逻辑偏移保存；重启 / DPI 换算、尺寸变化和托盘离屏恢复，坏配置保护。单屏原生与隔离回归见 `m3-verification.md`；物理多屏 / 热插拔仍未验收。
- 顺序收敛为位置 / DPI → WSL 来源隔离与协议 → 单发行版 Claude → Codex / 基础 WSL → 安装 / 开机启动 → 签名和性能验收。取舍、接口、权限与 WSL 脱敏设计见 `m3-design.md`。
- M3-A 不启动 WSL 或修改 Agent 配置；后续 WSL 安装、配置和真实模型调用分别授权。M2 欠验收保持为发布门槛，不阻塞独立切片开发。

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

## M1 验收修复顺序与边界

原始问题保留在 `docs/m1-acceptance.md`。修复分支为 `fix/m1-acceptance`，本次不提交、推送或合并。

1. 先确认 Claude 原生入口及 Hook 缺失，授权后合并配置并改进诊断。
2. 分离当前状态和近期工具观察；保留短批次中的调用 / 返回，不伪造持续 Running。启动重建不回放历史工具反馈。
3. 修复会话详情意图，补字号、拖动和置顶；图钉不再控制会话选择。
4. 最后调整装饰性动画：同节点从当前坐标转向，最新事实与 Attention 不延迟。
5. 每项使用 gpt-6-astra 或 grok-4.7 只读评审，修正具体缺陷后运行回归；再做联合检查和 Release 隔离验证。

未采用动画提案中的 FIFO、强制全程、默认 Idle 延迟或永久 rAF。流动、归中、呼吸时长是可调实现值，不作为感知研究结论。真实 Agent 缺失的事件不能靠动画或近期记录补造。

合成进程、浏览器和窗口样式验证不等于物理鼠标、Alt / 托盘或真实 Agent 复验。具体结果与剩余项见 `docs/verification.md`。
