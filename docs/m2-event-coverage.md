# M2-A：事件来源与覆盖边界

核对日期：2026-10-15。本机 Codex CLI 0.162.1、Claude Code 2.1.296。以下区分固定版本源码、合成回归和真实交互证据，不承诺未来版本兼容。

## 采用与排除

| 入口 | 决定 | 原因 |
|---|---|---|
| Codex rollout JSONL | 保留 | 用量、已保存工具观察、明确完成等；历史文件须验证持有进程 |
| Codex 已有 daemon 全局状态 | 采用，只读 | 提供 active / idle / systemError 及明确的等待标记，无需成为会话订阅者 |
| Codex `thread/read` | 仅元数据 | `includeTurns:false` 不加载历史、不订阅会话；preview 等非白名单字段直接丢弃 |
| Codex resume / start / fork / turn / 审批响应 | 禁止 | 会修改执行状态或进入会话订阅 / 审批角色 |
| Codex PermissionRequest Hook 直接映射 Waiting | 排除 | 0.162.1 调用点早于 guardian / 自动处理或人工界面，不等同于人工等待 |
| Claude 14 个 Hook | 采用 | 生命周期、工具与 Attention；helper 不输出决策 |
| Claude transcript | 仅补遥测 | 写入异步；只读取已注册会话的白名单模型 / usage，不能推断实时状态 |
| 超时、累计 Token、标题 / cwd 猜终端 | 禁止 | 不能证明等待、Context 容量或窗口关联 |

## Codex 覆盖矩阵

| 能力 | 可靠来源 | 限制 |
|---|---|---|
| 已加载会话发现 / 恢复 | loaded/list 分页、thread/started、已加载 status/changed | notLoaded / closed 后可由新状态恢复，不要求 thread/started；仅同一 CODEX_HOME 共享 daemon，embedded / --no-daemon 不覆盖 |
| Waiting User | activeFlags.waitingOnApproval / waitingOnUserInput | 不读取待批准内容；不响应审批 |
| 等待解除 | status/changed 清除标记 | 不等 rollout；元数据只初始化未观察的状态；恢复时旧读取失败后补读，不覆盖已收到的实时状态 |
| 工作 / 空闲 | active / idle | active 暂归 Thinking，不能证明当前具体工具或正在输出；idle 不能区分完成与中断 |
| Done | rollout 明确完成事实 | 不由 daemon idle 推造；新一轮 active 不恢复上一轮 Done |
| Error | daemon systemError、已保存明确错误 | 不保证所有瞬时工具 / 模型错误 |
| 工具与回复 | rollout 中已保存记录 | 缺失或延迟的开始 / 返回 / 流式片段仍是缺口 |
| 模型 / Token / Context | rollout 已有解析 | Context 为最近请求估算，非累计；compaction 后待新统计 |
| 卸载 / 断线 | thread/closed、notLoaded、管道 EOF | 清除实时层和 daemon-only 会话；文件会话恢复 rollout-only |
| 返回终端 | 文件持有进程和已验证窗口链 | daemon-only 会话不继承 daemon 终端；不定位 tab |

HUD 只调用 `codex app-server proxy` 连接已有控制 socket，不调用 daemon 启动 / bootstrap。只发送 initialize、initialized、thread/loaded/list、thread/read。意外服务端请求导致断开，绝不发送 result / error / 审批响应。

代理通过 Windows Job 的 kill-on-close 随 HUD 清理，读帧上限 1 MiB。无周期性轮询；连接失败后仅在已验证 rollout 文件事件时重试，最短间隔 5 秒。协议不兼容时明确诊断，不伪装成功。握手不提供可靠 daemon 版本，不能把 CLI 版本当服务版本。

## Claude 覆盖矩阵

| 能力 | 来源与实现 | 限制 |
|---|---|---|
| 生命周期 | SessionStart、UserPromptSubmit、SessionEnd | SessionEnd 后晚到事件不能复活；仅更新的显式 SessionStart 可重开 |
| 工具 | PreToolUse、PostToolUse、PostToolUseFailure | 按 tool_use_id 跟踪并行；启动回放保留内部在途关联但清除近期展示；晚返回解除已解决的等待，不倒退时间戳 |
| Attention | 明确 Notification、Stop、StopFailure、Elicitation / Result | 晚返回不清除其他输入等待或覆盖较新 Done / Error；PermissionRequest 仅候选，源端延迟及无 ID / 同名关联限制仍保留 |
| compaction | PreCompact / PostCompact、transcript 标记 | 只使 Context 失效，等待新请求统计，不解除 Waiting |
| 模型 | Hook 优先；transcript 按记录时间补充 | 旧 transcript 不覆盖较新 Hook 模型 |
| Token | 已观察消息 / 请求 ID 去重，累计计数取最大值 | 不等于账号账单；未知字段不补零 |
| Context | 最近 input + cache creation + cache read | 标记估算，不把 output / 累计量当 Context，不猜容量或百分比 |
| 异步写入 / 替换 | 独立文件事件、文件身份和截断检测 | 不能注册会话；尾读错误不包含正文 |
| 安全卸载 | 精确命令匹配、备份、原子替换、HUD 写入互斥及变更检测 | 指定原 helper 绝对路径；不自动写用户配置；锁不约束外部编辑器，执行前停止其他配置写入 |

当前 helper 只支持原生 claude.exe 祖先。npm / Node 包装版、WSL、transcript 跨版本稳定性均不宣称通过。新增 Hook 需要重新合并配置，不会随构建自动安装。

Claude PermissionRequest 官方输入无 tool_use_id，且也可能发生于不能弹窗的自动拒绝场景；只保存候选工具。Notification.permission_prompt 才确认可见审批，源端约 6 秒未输入才触发，不能据 Hook 覆盖宣称 < 500 ms 人工等待发现。缺少唯一关联时，保留所有同名在途候选；完全不能关联时等新的 prompt / Stop / 生命周期事实清除，不猜解除。

## 固定版本证据位置

Codex 来源根路径：`https://github.com/openai/codex/tree/rust-v0.162.1/codex-rs`。

- `rollout/src/policy.rs`：审批和部分瞬时事件不持久化。
- `cli/src/main.rs` 的 AppServerCommand::Proxy：仅 stdio-to-uds 连接已有 socket。
- `app-server-daemon/README.md`：共享 daemon、Windows AF_UNIX 路径约束及 embedded 回退。
- `app-server-protocol/src/protocol/v1.rs`：initialize；不声明必有 daemon 版本或 PID。
- `app-server-protocol/src/protocol/v2/thread.rs`：loaded/list、read、ThreadStatus、全局通知。
- `app-server-protocol/src/protocol/v2/thread_data.rs`：Thread 的白名单字段及须丢弃的 preview。
- `app-server/src/request_processors/thread_processor.rs`：metadata-only thread_read 不注册会话监听。
- `app-server/src/thread_status.rs`、`outgoing_message.rs`：等待计数与全局广播。
- `app-server/src/thread_state.rs`、`request_processors/thread_lifecycle.rs`：订阅者和审批路由边界。

Claude 官方文档：`https://code.claude.com/docs/en/hooks`、`https://code.claude.com/docs/en/statusline`，于上述日期核对；包含 transcript 异步写入和当前请求 usage 语义。transcript 内部格式不是稳定公共协议，测试仅证明受支持字段和样本行为。

## 证据等级与结论

1. **源码 / 文档确认**：上述入口和禁止操作的调用边界；非真实服务互通证明。
2. **合成回归通过**：Rust 协议 / 生命周期 / HWND 测试、Hook 脚本、Release WebView 与模拟代理，详见 `m2-verification.md`。
3. **真实交互未验收**：真实 Claude helper 执行、真实 daemon 互通、审批 / 输入交互、模型遥测、不同终端返回及性能测量。

**结论：允许交付 M2 开发版，不允许宣称完整实时事件覆盖或整个 MVP 已验收。** 真实模型调用、用户配置变更仍需单独授权；源码和夹具结果不能替代该验收。

## 2026-10-16 轻量第一批补充

以上 M2 的固定版本与历史结论保持不变。当前 CLI 只读探测为 Claude Code 2.1.296、Codex 0.163.0；0.163.0 不自动继承 0.162.1 的协议验收。

Claude Stop 与 Codex task_complete / turn_complete 对内仍映射 DONE，对外改为本轮已结束 / Ended，不能证明任务验收。Claude 首个已验证 Hook 前明确为 waiting，Codex proxy 握手前为 connecting；HUD 连接成功与 Agent 接入分开。

本轮实际自动与真实 CLI 证据见 `windows-loop-verification.md`：已观察原生 Claude Hook、Codex 0.163.0 rollout、双 Agent 并行与 Claude 显式 resume。非交互 print / exec 不能证明人工审批 / 解除或真实共享 daemon；专用终端返回被 Windows 前台权限拒绝，成功前置仍待实测。
