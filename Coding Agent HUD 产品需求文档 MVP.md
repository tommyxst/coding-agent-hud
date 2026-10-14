# Coding Agent HUD 产品需求文档

版本：V0.3 MVP  
产品定位：本地 Coding Agent 实时状态与注意力提醒悬浮窗  
首发平台：Windows 10 / 11  
MVP 支持：Claude Code、Codex  
运行环境：Windows Native，兼容 WSL2

---

# 1. 产品概述

## 1.1 产品背景

随着 Claude Code、Codex 等 Coding Agent 逐渐进入日常研发流程，开发者的工作方式正在从单窗口编码，转向同时管理多个 Agent、多个终端和多个项目。

在实际使用中，效率损耗往往并不来自模型执行速度，而来自开发者无法及时感知 Agent 的状态变化，例如：

- Agent 已完成任务，但开发者仍在其他窗口工作
- Agent 正等待权限确认或用户输入，但开发者没有及时发现
- 多个 Agent 并发工作时，不知道哪个项目当前需要关注
- 不知道当前会话的 Context 已经使用到什么程度
- 不知道 Agent 当前正在思考、调用工具还是返回结果
- 需要处理某个 Agent 时，还要重新寻找对应的 Terminal 窗口
- Windows Native 与 WSL2 中同时运行 Agent 时，状态更加分散

现有 Coding Agent 的状态主要存在于各自 Terminal 内部，缺乏一个跨 Agent、跨项目、跨终端的统一状态入口。

Coding Agent HUD 希望成为 Coding Agent 之上的本地实时观测与注意力调度层。

产品不参与 Agent 推理、模型调用和任务执行，只负责：

```text
自动发现
    ↓
状态采集
    ↓
统一建模
    ↓
注意力判断
    ↓
悬浮展示
    ↓
帮助用户快速返回工作现场
```

---

# 2. 产品定位

## 2.1 一句话定义

**自动发现本机正在运行的 Coding Agent 会话，通过全局 HUD 展示运行状态，并在需要用户介入时帮助用户快速返回对应工作现场。**

## 2.2 产品核心价值

产品重点解决两类问题。

### Activity Awareness

回答：

```text
Agent 现在在做什么？
```

包括：

- Thinking
- Tool Running
- Responding
- Idle

### Attention Awareness

回答：

```text
现在是否轮到我处理？
```

包括：

- Waiting User
- Done
- Error

相比持续展示所有运行细节，Attention Awareness 优先级更高。

---

# 3. 核心原则

## 3.1 零侵入优先

尽量通过：

- Agent 原生 Hook
- Session / Transcript 文件
- 本地 Process 状态
- Git 状态

获取信息。

MVP 不代理 LLM API，不修改用户模型调用链路。

---

## 3.2 自动发现

用户无需：

- 创建项目
- 手工注册 Session
- 手工选择 Agent
- 手工绑定 Terminal

正常执行：

```bash
claude
```

或者：

```bash
codex
```

HUD 自动开始工作。

---

## 3.3 本地优先

MVP 所有状态分析均在本机完成。

默认不上传：

- Prompt
- 模型回复
- 代码
- Shell 输出
- API Key
- Session Transcript

---

## 3.4 统一抽象

Claude Code 与 Codex 的内部实现不同，但最终统一转换成：

```text
Agent
Session
Environment
Project
Runtime
Attention
Model
Context
Usage
```

---

## 3.5 注意力优先

HUD 不追求持续播放大量动画。

状态变化根据重要程度分级：

```text
普通 Activity
Thinking
Tool Running
Responding

重要 Attention
Waiting User
Done
Error
```

Attention 事件可以主动改变 HUD 展示状态。

---

## 3.6 低打扰

HUD 必须长期存在，但不能干扰开发。

要求：

- 不抢键盘焦点
- Compact / Active 状态支持鼠标穿透
- 空闲时不持续刷新
- 动画只在状态变化时播放
- 无 Session 时自动隐藏
- 长时间 Idle 时可贴边收起

---

# 4. 产品目标

MVP 需要验证四个核心假设。

## 4.1 自动发现是否可靠

启动 Claude Code 或 Codex：

```text
Agent Start
    ↓
Session Discovery
    ↓
HUD 出现
```

整个过程无需用户额外操作。

---

## 4.2 状态是否有价值

用户无需回到 Terminal，即可知道：

```text
Claude Code
ai-experience-qa
main

Thinking
```

或者：

```text
Codex
wealth-workspace
feature/copilot

Running npm test
```

---

## 4.3 是否能及时提醒用户介入

例如：

```text
Claude Code
Project A

Waiting for approval
```

或者：

```text
Codex
Project B

Done
```

HUD 应主动提高展示优先级。

---

## 4.4 是否能快速返回工作现场

看到：

```text
Claude
Project A
WAITING USER
```

点击 Session 后：

```text
HUD
 ↓
对应 Terminal
 ↓
对应 Agent 会话
```

至少实现 Terminal 窗口级唤醒。

---

# 5. MVP 范围

## 5.1 MVP 支持

| 能力 | Claude Code | Codex |
|---|---:|---:|
| 自动发现 Session | P0 | P0 |
| Windows Native | P0 | P0 |
| WSL2 Session 识别 | P0/P1 | P0/P1 |
| 自动识别项目 | P0 | P0 |
| Git Branch | P0 | P0 |
| Agent Activity 状态 | P0 | P0 |
| Waiting User | P0 | P0 |
| Done | P0 | P0 |
| Error | P0 | P0 |
| 当前模型 | P0 | P0 |
| Input / Output Token | P0 | P0 |
| Context 使用情况 | P0 | P0 |
| Tool 执行状态 | P0 | P0 |
| 多 Session 展示 | P0 | P0 |
| Session 点击返回 Terminal | P0 | P0 |
| Compact / Active / Attention / Expanded | P0 | P0 |
| 1+N 多 Session 堆叠 | P0 | P0 |
| 全局悬浮窗 | P0 | P0 |
| 防抢焦点 | P0 | P0 |
| 鼠标穿透 | P0 | P0 |
| 屏幕边缘磁吸 | P1 | P1 |
| Dirty File Count | P1 | P1 |
| 复杂 Activity 动画 | P1 | P1 |

---

## 5.2 MVP 不做

第一版明确不包括：

- Gemini CLI
- Pi Agent
- Grok Build
- OpenCode
- Magpie Provider Routing
- Agent 消息输入
- Agent Stop / Resume
- Permission Approve
- 多 Agent 编排
- Task 编排
- Prompt 内容查看
- Session 完整回放
- 云端同步
- 团队管理
- Token 成本计费
- Adapter Marketplace

---

# 6. 核心用户场景

## 场景一：单 Agent 工作

用户执行：

```bash
cd ai-experience-qa
claude
```

HUD 自动出现。

---

## 场景二：等待用户操作

Agent 请求权限：

```text
Claude Code
      ↓
PreToolUse
      ↓
Waiting User
```

HUD 自动从 Active 切换至 Attention。

---

## 场景三：任务完成

Agent 执行完成：

```text
Codex
Project B

Done
```

HUD：

- 短暂展开
- 明确显示完成状态
- 保留若干秒
- 随后进入 Compact

---

## 场景四：多个 Agent 并行运行

用户同时运行：

```text
Claude → Project A
Codex  → Project B
Claude → Project C
```

HUD 使用 1+N 堆叠布局。

---

## 场景五：Windows 与 WSL2 同时运行

```text
Claude [WSL]   ai-experience-qa
Codex  [Win]   wealth-workspace
```

HUD 必须能够区分运行环境。

---

# 7. 状态模型

## 7.1 Activity State

描述 Agent 在做什么：

```text
STARTING
IDLE
THINKING
TOOL_RUNNING
RESPONDING
```

## 7.2 Attention State

描述用户是否需要介入：

```text
NONE
WAITING_USER
DONE
ERROR
```

Attention 独立于 Activity。

例如：

```text
runtime.state = IDLE
attention.state = WAITING_USER
```

---

# 8. UI 设计理念

## 8.1 核心视觉语言

界面核心视觉语言定义为：

**Tactical Telemetry Pill**

即：

```text
Linear / Raycast 极简工业风
+
高端游戏 HUD 的遥测感
+
Windows 桌面级低侵入悬浮体验
```

产品不追求赛博朋克、强霓虹或复杂 HUD 装饰，而强调：

- 信息密度高
- 长时间观看不疲劳
- 层次清晰
- 动画克制
- 状态可被余光感知
- 与 IDE、浏览器、Terminal 同屏时不过度抢占视觉注意力

---

# 9. 视觉系统

## 9.1 HUD 材质

默认采用深色半透明亚克力材质。

推荐视觉参数：

```text
Base             #0B0D11
Opacity          88%
Border           rgba(255,255,255,0.08)
Radius           12px ~ 16px
Shadow           Soft / low diffusion
Backdrop Blur    适度
```

HUD 在以下背景上都应保持清晰：

- 深色 VS Code
- 浅色浏览器
- Terminal
- 桌面壁纸

---

## 9.2 色彩原则

大部分界面保持：

```text
Graphite
Gray
White
Muted Blue Gray
```

品牌色仅用于：

- Agent 标识
- 状态点
- 左侧 Accent
- Activity 粒子
- Attention 提醒

推荐 Agent Accent：

```text
Claude Code
#D97757

Codex
#10A37F
```

Attention：

```text
Waiting User
Amber

Error
Coral Red

Done
Muted Green
```

避免大面积纯色背景。

---

## 9.3 字体

普通 UI：

```text
Inter
Geist
Segoe UI
```

遥测数据：

```text
JetBrains Mono
Geist Mono
```

以下内容必须使用等宽数字：

- Token
- Context
- Duration
- 百分比
- Git diff
- 分支
- Command

CSS 要求：

```css
font-variant-numeric: tabular-nums;
```

避免实时数字变化导致 Layout Jitter。

---

# 10. HUD 展示状态

HUD 主要包含四种视觉形态：

```text
Compact
Active
Attention
Expanded
```

同时支持多 Session 的 1+N Stack。

---

# 11. Compact State

## 11.1 定位

用于：

- Idle
- 低关注场景
- 用户主动收缩
- 长时间运行但无需介入

目标尺寸：

```text
Width   ~280px
Height  ~30px
```

视觉形态类似单行状态胶囊。

---

## 11.2 内容结构

示例：

```text
╭──────────────────────────────────────────────────╮
│ ● CC·WSL  ai-experience-qa  ⎇ main  +5 │ 42% ◔ │
╰──────────────────────────────────────────────────╯
```

从左到右：

1. Activity 状态点
2. Agent + Environment
3. Project
4. Git Branch
5. Dirty File Count
6. Context Percent
7. Context Mini Ring

---

## 11.3 信息裁剪

空间不足时按以下优先级隐藏：

```text
Dirty Files
    ↓
Branch
    ↓
Environment Detail
```

始终保留：

```text
Agent
Project
Status
Context %
```

---

## 11.4 默认交互

Compact 默认：

```text
Always On Top
No Focus
Mouse Click Through
```

不会抢占 IDE 点击区域。

---

# 12. Active State

## 12.1 定位

Agent 正在执行任务时的主要展示形态。

推荐尺寸：

```text
Width   320 ~ 350px
Height  110 ~ 130px
```

采用三段式结构：

```text
Header
Activity Track
Telemetry Footer
```

---

# 13. Active Header

Header 分两层。

### 第一层

```text
[Claude Code] [WSL]                  📌  ↗
```

包含：

- Agent
- Environment
- Pin
- Return to Workspace

### 第二层

```text
ai-experience-qa        feature/hud · 5
```

包含：

- Project
- Git Branch
- Dirty Files

Project 为第一视觉重点。

---

# 14. Activity Track

HUD 中央采用：

**Horizontal Pipeline Track**

示例：

```text
Claude ───────── ● ─────────► Bash
```

其中：

- 左侧为 Agent
- 中间为 Activity Node
- 右侧为当前目标

目标可能是：

```text
Model
Bash
Read
Edit
Search
MCP
Other Tool
```

下方显示 Action Summary：

```text
▸ npm run test:unit
```

隐私模式开启时降级为：

```text
▸ Running shell command...
```

---

# 15. Activity 动画

## 15.1 Thinking

```text
Claude ───────●────── Model
              ◌
```

表现：

- 中心节点轻微呼吸
- 不做持续粒子运动
- 低频动画

---

## 15.2 Tool Running

```text
Claude ───────●──────► Bash
```

表现：

- 一个粒子从左向右移动
- 工具节点短暂高亮
- 动画只在执行期间存在

---

## 15.3 Responding

```text
Claude ◄──────●────── Model
```

表现：

- 粒子从右向左
- 表示模型响应返回 Agent

---

## 15.4 Idle

无动画。

```text
0 FPS
```

---

# 16. Telemetry Footer

Active Footer 展示三类信息。

## 16.1 Context

```text
████████░░░░░░░░  ~72k / 200k  36%
```

精确值：

```text
72,431 / 200,000
```

估算值：

```text
~72k / 200k
```

---

## 16.2 Token

```text
In 72.4k · Out 6.3k
```

---

## 16.3 Duration

右对齐：

```text
01:24
```

所有数字使用 Tabular Numerals。

---

# 17. Context 水位设计

Context 使用三段视觉提示。

### Normal

```text
0% ~ 70%
```

冷灰或低饱和蓝。

### Warning

```text
70% ~ 90%
```

Amber。

### Critical

```text
90%+
```

Coral Red。

仅改变：

- Progress Bar
- Context 数字

不要让整个卡片变色。

---

# 18. Attention State

Attention 是产品中最高优先级视觉状态。

包含：

```text
WAITING_USER
DONE
ERROR
```

---

## 18.1 Waiting User

视觉要求：

- 左边框 Amber
- 微弱 Glow
- 低频呼吸
- 不使用复杂动画

示例：

```text
╭───────────────────────────────────╮
│ Claude Code · WSL                 │
│                                   │
│        WAITING FOR YOU            │
│                                   │
│ Bash permission required          │
│                                   │
│      Click to return              │
╰───────────────────────────────────╯
```

此时：

```text
Mouse Click Through = OFF
```

用户可直接点击返回 Terminal。

---

## 18.2 Done

主要显示：

```text
Task completed
```

播放一次完成动画后停止。

若用户无操作：

```text
Attention
   ↓
5~10s
   ↓
Compact
```

---

## 18.3 Error

视觉：

- Coral Red Accent
- Error Icon
- 静态提示

禁止持续闪烁。

---

# 19. Expanded State

## 19.1 交互形式

用户点击 Active Card 后，从卡片底部展开 Detail Drawer。

不打开新窗口。

---

## 19.2 数据结构

示例：

```text
Model          Claude 3.7 Sonnet
Tokens         In 72,431 · Out 6,328
Cache Hit      31,205 · 43%
Git Status     5 files · +183 / -42
Workspace      /home/user/repos/...
Duration       04:32
Environment    WSL · Ubuntu-24.04
```

---

## 19.3 Cache

展示：

```text
Cache Read
```

以及：

```text
Cache Hit %
```

例如：

```text
31,205 · 43% cached
```

若 Agent 数据源无法准确提供，则不计算。

---

## 19.4 Git

可展示：

```text
5 files changed
+183
-42
```

其中：

```text
Addition → Green
Deletion → Red
```

Git diff 属于 P1。

---

# 20. 多 Session 设计

同时运行多个 Agent 时，不展示多张完整卡片。

使用：

**1 Primary + N Secondary Stack**

---

## 20.1 Primary Session

显示完整 Active Card：

```text
Claude Code · WSL

ai-experience-qa
main

Claude ───●───► Bash

cargo test --workspace

84k / 200k
```

---

## 20.2 Secondary Session

每行建议：

```text
Height 24 ~ 30px
```

示例：

```text
CC·Win   admin-portal    Waiting     31%
CX·WSL   wealth-work..  Thinking    67%
CX·Win   docs-site      Idle        12%
```

每行包含：

```text
Agent
Environment
Project
State
Context
```

---

# 21. Primary Session 自动切换

默认：

```text
最近发生高价值 Activity
→ Primary
```

优先级：

```text
WAITING_USER
ERROR
DONE
TOOL_RUNNING
RESPONDING
THINKING
IDLE
```

但 Attention Session 不一定强制切换成 Primary。

如果后台 Session 进入 Waiting：

```text
Secondary Row
→ Amber Highlight
```

用户自行点击切换。

这样避免正在观察的 Primary Card 被频繁抢占。

---

# 22. Pin

用户可 Pin Session。

Pin 后：

```text
Primary Session
保持不变
```

其他 Session 的：

```text
WAITING
ERROR
DONE
```

仍通过 Secondary Row 高亮显示。

---

# 23. Return to Workspace

Header 右上角提供：

```text
↗
```

或 Terminal Icon。

点击后：

```text
Session
 ↓
Terminal Process
 ↓
Terminal Window
 ↓
Bring To Front
```

MVP 至少做到窗口级返回。

---

# 24. Windows 专属交互

## 24.1 No Focus Steal

HUD：

```text
Show
Expand
State Change
```

均不得抢当前输入焦点。

目标效果：

用户正在 VS Code 输入时，HUD 弹出不会打断键盘输入。

---

## 24.2 Ghost Mode

Compact / Active 默认可以开启鼠标穿透。

Ghost Mode：

```text
Opacity 60%
Click Through ON
```

用户：

```text
Alt + Hover
```

后：

```text
Opacity 100%
Click Through OFF
```

允许：

- Drag
- Pin
- Expand
- Return to Workspace

---

# 25. Edge Docking

HUD 支持屏幕边缘吸附。

当距离边缘：

```text
< 10px
```

自动吸附。

支持：

```text
Left
Right
Top
```

---

## 25.1 Edge Collapse

所有 Session Idle 超过一定时间：

```text
HUD
 ↓
Edge Collapse
```

只保留约：

```text
4px
```

的状态光条。

再次出现：

```text
Thinking
Tool Running
Waiting
Error
Done
```

时：

```text
Edge Bar
→ HUD Slide Out
```

Edge Collapse 属于 P1。

---

# 26. 响应式与多屏

HUD 需要支持：

- 多显示器
- DPI Scaling
- 125% / 150% / 200%
- Windows Display Scaling

窗口位置按：

```text
Monitor ID
+
Relative Position
```

保存。

---

# 27. UI 状态切换

建议状态机：

```text
NO_SESSION
    ↓
HIDDEN

SESSION_START
    ↓
ACTIVE

IDLE timeout
    ↓
COMPACT

TOOL / THINKING / RESPONDING
    ↓
ACTIVE

WAITING / ERROR / DONE
    ↓
ATTENTION

USER_CLICK
    ↓
EXPANDED

ALL_SESSION_END
    ↓
DELAY
    ↓
HIDDEN
```

---

# 28. 动画性能规则

界面必须遵循：

```text
Idle
→ 0 FPS

Hidden
→ 0 FPS

State unchanged
→ 不重绘

Activity Event
→ 开启动画

Activity End
→ 停止动画
```

建议：

- CSS Transform
- Opacity
- SVG
- requestAnimationFrame

避免：

- 高频 React State
- Layout Thrashing
- 大规模 DOM 重建
- 长时间 Glow Animation
- Background Animation

---

# 29. Session 自动发现

整体流程：

```text
Agent
 ↓
Agent Adapter
 ↓
Session Discovery
 ↓
Session Registry
 ↓
Activity / Attention Engine
 ↓
HUD
```

---

# 30. Claude Code Adapter

Claude Code 优先使用原生 Hook。

重点事件：

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
Stop
SessionEnd
```

转换成：

```text
SESSION_STARTED
USER_PROMPT
WORK_STARTED
TOOL_STARTED
TOOL_FINISHED
RESPONSE_FINISHED
WAITING_USER
SESSION_ENDED
```

同时读取 Session / Transcript 补充：

- Model
- Session ID
- cwd
- Token Usage
- Context
- Activity Time

---

# 31. Windows Hook

Windows 下 Hook 不依赖：

```text
PowerShell
CMD
Git Bash
```

建议调用 HUD 自带轻量 CLI：

```text
agent-hud-hook.exe
```

由其向主程序发送事件。

---

# 32. Codex Adapter

Codex 通过 Session Rollout 自动发现。

典型目录：

```text
~/.codex/sessions/
```

处理流程：

```text
rollout created
      ↓
read session_meta
      ↓
register session
      ↓
incremental tail
      ↓
AgentEvent
```

提取：

- Session ID
- cwd
- Model
- Token Count
- Tool Call
- Response
- Activity
- Error
- End State

---

# 33. Windows / WSL2 环境模型

统一 Session：

```ts
environment: {
  type: 'windows' | 'wsl'
  distro?: string
}
```

Session ID：

```text
environment
+
agent
+
nativeSessionId
```

例如：

```text
windows:claude:abc123
wsl:Ubuntu-24.04:codex:def456
```

---

# 34. WSL2 支持原则

产品层要求：

Windows Host 可以同时发现：

```text
Windows Native
+
WSL2
```

中的 Claude Code / Codex。

技术原则：

```text
数据在哪里产生
就在哪里采集
```

禁止长期跨：

```text
\\wsl.localhost\
```

进行高频文件扫描。

---

# 35. Unified Session Model

```ts
interface AgentSession {
  id: string

  environment: {
    type: 'windows' | 'wsl'
    distro?: string
  }

  agent: {
    type: 'claude' | 'codex'
    name: string
    version?: string
  }

  project: {
    cwd: string
    root?: string
    name?: string
    branch?: string
    dirtyFiles?: number
  }

  runtime: {
    state:
      | 'STARTING'
      | 'IDLE'
      | 'THINKING'
      | 'TOOL_RUNNING'
      | 'RESPONDING'

    tool?: string
    detail?: string

    startedAt: number
    updatedAt: number
  }

  attention: {
    state:
      | 'NONE'
      | 'WAITING_USER'
      | 'DONE'
      | 'ERROR'

    message?: string
  }

  model?: {
    name: string
    provider?: string
  }

  context?: {
    used: number
    limit?: number
    estimated: boolean
  }

  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cached?: number
  }

  workspace?: {
    terminalPid?: number
    terminalType?: string
  }
}
```

---

# 36. Project Observer

通过 cwd：

```text
cwd
 ↓
Git Root
 ↓
Project
 ↓
Branch
```

P0：

- Project
- Root
- Branch

P1：

- Dirty Files
- Added Lines
- Deleted Lines

Git 刷新由事件触发：

```text
SESSION_START
TOOL_FINISHED
DONE
IDLE
```

避免持续监听整个 Workspace。

---

# 37. 设置

## General

```text
Launch at startup
Always on top
Auto hide
Opacity
Theme
Reduced motion
Click through
Edge docking
```

## Agents

```text
Claude Code   ON
Codex         ON
```

## Attention

```text
Waiting User     ON
Done             ON
Error            ON
```

可配置：

```text
Show HUD
Flash once
Play sound
```

声音默认关闭。

## Privacy

```text
Show command detail       OFF
Show file names           OFF
Show repository path      OFF
```

---

# 38. 隐私与安全

默认不记录：

- Prompt 正文
- 模型回复正文
- 文件正文
- Shell 输出
- API Key
- Authentication Token

只保留：

```text
agent
session_id
environment
project
branch
model
state
attention
token statistics
timestamps
```

Session History MVP 默认仅存在内存。

---

# 39. 系统架构

```text
Tauri 2
│
├── Rust Core
│
│   ├── Session Registry
│   ├── Attention Engine
│   ├── Event Bus
│   │
│   ├── Collectors
│   │   ├── Windows Collector
│   │   └── WSL Collector
│   │
│   ├── Agent Adapters
│   │   ├── Claude Adapter
│   │   └── Codex Adapter
│   │
│   ├── Process Observer
│   ├── Git Observer
│   └── Workspace Resolver
│
└── WebView
    ├── HUD Shell
    ├── Session Stack
    ├── Activity Track
    ├── Telemetry
    ├── Attention Card
    ├── Detail Drawer
    └── Settings
```

---

# 40. 前端组件结构

建议：

```text
HudRoot
│
├── HudWindow
│
├── SessionStack
│   │
│   ├── PrimarySessionCard
│   │   ├── SessionHeader
│   │   ├── ActivityTrack
│   │   ├── ActionSummary
│   │   ├── ContextMeter
│   │   └── TelemetryFooter
│   │
│   └── SecondarySessionRow[]
│
├── AttentionView
│
├── DetailDrawer
│
└── EdgeIndicator
```

UI 只订阅统一的 Session Model。

不直接解析 Claude / Codex 数据。

---

# 41. 性能要求

| 指标 | 目标 |
|---|---:|
| 空闲 CPU | < 1% |
| Session 事件响应 | < 500ms |
| Agent 启动发现 | < 2s |
| UI Idle | 0 FPS |
| Hidden | 0 FPS |
| 动画 | 60 FPS 优先 |
| 文件处理 | Event Driven |
| JSONL | Incremental Tail |

禁止：

```text
高频轮询
持续 git status
重复全量 JSONL
监听整个大型项目目录
隐藏窗口持续动画
每个事件重建整个 Session Stack
```

---

# 42. MVP 验收标准

## 自动发现

执行：

```bash
claude
```

或：

```bash
codex
```

HUD 自动出现。

---

## UI

必须具备：

```text
Compact
Active
Attention
Expanded
1+N Stack
```

---

## Attention

能够准确区分：

```text
WAITING_USER
DONE
ERROR
```

并给予明显但克制的视觉提醒。

---

## Workspace Return

点击：

```text
↗
```

对应 Terminal Window 被唤醒。

---

## Window Behavior

HUD：

- 不抢焦点
- Compact / Active 可穿透
- Attention 可交互
- 不进入常规 Alt+Tab
- 支持托盘
- 支持多屏

---

## Session

至少能够识别：

```text
Idle
Thinking
Tool Running
Responding
Waiting User
Done
Error
Ended
```

---

## Usage

展示：

```text
Input
Output
Context Used
Context Limit
```

---

## 性能

连续运行 8 小时：

- 无持续高 CPU
- 无明显内存增长
- Session 文件增长不导致性能明显退化
- Idle 期间无持续动画

---

# 43. MVP 用户路径

```text
安装 Coding Agent HUD
        ↓
检测 Windows / WSL
        ↓
检测 Claude / Codex
        ↓
HUD 常驻托盘
        ↓
用户启动 Agent
        ↓
自动发现 Session
        ↓
Compact / Active 展示
        ↓
Agent 执行
        ↓
Activity Track 更新
        ↓
Waiting / Done / Error
        ↓
Attention 提醒
        ↓
点击 Return to Workspace
        ↓
回到 Terminal
        ↓
Session End
        ↓
Compact / Hide
```

---

# 44. 后续演进

## V0.1

```text
Claude Code
Codex
Windows Native
基础 WSL2
Compact
Active
Attention
Expanded
1+N Stack
Return to Workspace
```

## V0.2

```text
Gemini CLI
Pi
Grok Build
完整 WSL Collector
Edge Docking
Session History
更丰富 Git Telemetry
```

## V0.3

```text
OpenCode
Magpie Adapter
Usage Analytics
Session Analytics
```

长期方向：

```text
Coding Agent Observer
        ↓
Coding Agent HUD
        ↓
Developer Attention Manager
        ↓
Agent Workspace
```

但前几个版本仍坚持：

**只观察，不控制 Agent。**

---

# 45. MVP 核心判断

第一版真正需要验证：

**第一，开发者是否愿意长期保留一个低打扰、低资源消耗的全局 Coding Agent HUD。**

**第二，Claude Code 与 Codex 的本地数据能否支撑可靠的实时状态识别。**

**第三，Waiting User、Done、Error、Context 和 Token 是否足够降低用户频繁切换 Terminal 查看状态的成本。**

**第四，1+N Session Stack 是否能够支撑多个 Agent 并行工作，而不会占据过多桌面空间。**

**第五，Return to Workspace 是否能够把 HUD 从状态展示工具变成真正有价值的开发者注意力调度入口。**

如果这些假设成立，后续新增 Coding Agent 主要属于 Adapter 扩展，而产品的核心交互模型无需发生明显变化。