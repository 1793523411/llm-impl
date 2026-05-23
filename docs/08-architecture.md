# 08 架构与扩展

## 目录结构

```
llm-impl/
├─ apps/
│  ├─ server/                     # Bun + Hono
│  │  └─ src/
│  │     ├─ index.ts              # 路由入口
│  │     ├─ run.ts                # runOnce + runStream（核心 LLM 调用）
│  │     ├─ providers.ts          # 加载 config/providers.json
│  │     ├─ curl.ts               # 按 provider 生成可运行 cURL
│  │     ├─ exec-tool.ts          # 真执行白名单
│  │     ├─ workspace.ts          # state/workspace.json 读写
│  │     └─ cases.ts              # cases/ 文件树 CRUD
│  └─ web/                        # Vite + React + Zustand
│     └─ src/
│        ├─ App.tsx               # 三栏布局 + 启动序列
│        ├─ store.ts              # 唯一 zustand store + auto-save 订阅
│        ├─ api.ts                # fetch 封装（含 SSE 解析）
│        └─ components/
│           ├─ CaseTree.tsx
│           ├─ ConfigPanel.tsx
│           ├─ SystemAndTools.tsx
│           ├─ MessageList.tsx
│           ├─ MessageCard.tsx    # 单条消息 + Block 编辑器
│           ├─ Compare.tsx        # 多模型对比 modal
│           ├─ Toolbar.tsx
│           └─ SendBar.tsx
├─ packages/
│  └─ shared/                     # 前后端共享
│     └─ src/
│        ├─ schema.ts             # zod: Message / Tool / Config / StreamEvent ...
│        ├─ adapter.ts            # 内部格式 ↔ OpenAI 格式转换
│        └─ index.ts              # re-export
├─ config/
│  ├─ providers.json              # 真 keys（gitignored）
│  └─ providers.example.json      # 模板
├─ cases/                         # 调试快照（git 跟踪）
├─ state/                         # workspace.json（gitignored）
├─ scripts/
│  └─ test-all-models.ts          # 跑遍 providers.json 检查可用性
└─ docs/                          # 你正在读的
```

## 数据流

### 一次（流式）调用的全链路

```
[user clicks Send]
       ↓ store.send()
[POST /api/run, stream:true]
       ↓ Hono /api/run 路由
[runStream(req)] ← apps/server/src/run.ts
       ├─ resolveProvider(req.config.provider)  ← providers.ts
       ├─ provider.api === 'anthropic-messages'
       │      ↓ runAnthropicStream
       │      [anthropic.messages.stream({...})]
       │      ↓ 逐事件 yield 统一格式 StreamEvent
       └─ provider.api === 'openai-completions'
              ↓ runOpenAIStream
              [openai.chat.completions.create({stream:true,...})]
              ↓ 状态机合成 block 边界，yield StreamEvent
       ↓
[honoStream 写 NDJSON 行到响应体]
       ↓
[fetch ReadableStream 在前端]
       ↓
[postRunStream() async generator] ← apps/web/src/api.ts
       ↓
[store.send 的 for await 循环逐事件 set()]
       ↓
[React 重渲染 MessageCard 的对应 block]
```

### Copy cURL 的全链路

```
[user clicks Copy Stream / Copy Non-stream]
       ↓ ModelInputPreview
[POST /api/curl { provider, body, mode }]
       ↓ Hono /api/curl 路由
[buildRunnableCurl(provider, body, mode)] ← apps/server/src/curl.ts
       ├─ getProvider(provider) 读取本地 config/providers.json 的 apiKey
       ├─ 按 provider.api 选择 endpoint + auth headers
       ├─ 裁掉末尾 assistant turn，避免 replay 时变成 prefill
       ├─ DeepSeek tool history 缺 reasoning_content 时加 thinking.disabled
       └─ mode=stream / non-stream 显式增删 stream 字段
       ↓
[返回完整 curl 文本给前端]
       ↓
[navigator.clipboard.writeText(curl)]
```

`/api/providers` 仍然不会把 `apiKey` 下发给前端；只有用户主动复制 cURL 时，
本地 server 才会把当前 provider 的 key 写入剪贴板文本。这个功能适合本机调试，
不要把复制出来的命令贴到公共聊天或提交到仓库。

### 持久化层

前端任何 mutating action → store 中状态变 → 顶层 `subscribe` 回调触发 →
对比 prev/curr 关键字段（config / system / tools / messages / currentCasePath / lastUsage / lastLatency / lastStopReason）→ 不同则 debounce 400ms → PUT `/api/workspace`。

## 共享 schema 的角色

`packages/shared/src/schema.ts` 是单一事实来源，前后端都 import：

- 后端 `RunRequest.safeParse(body)` 校验请求
- 前端 `import type { Config } from '@llm-impl/shared'` 类型贯通
- `StreamEvent` discriminated union 让两端的事件解析对齐

这样改 schema 时编译器会同时报前后端的类型错误，避免 silent drift。

Bun 的 workspaces 直接用 source（`"main": "./src/index.ts"`），无需构建产物。

## 内部消息格式 vs Provider 格式

我们**内部统一用 Anthropic 风格的 content blocks**：

```ts
type Message =
  | { role: 'user', content: (TextBlock | ToolResultBlock | ImageBlock)[] }
  | { role: 'assistant', content: (TextBlock | ToolUseBlock | ThinkingBlock)[] }
```

Anthropic 调用直接发送（小调整）。OpenAI 在 `adapter.ts` 里转换：
- assistant 的 text + tool_use blocks → 一条 `{ role: 'assistant', content, tool_calls }`
- user 的 tool_result blocks → 多条 `{ role: 'tool', tool_call_id, content }`

为什么选 Anthropic 风格？因为它结构化更强（每个 block 显式标 type），
信息无损，方向可逆。OpenAI 扁平结构升级到 block 结构容易，反过来要丢字段。

## 扩展指南

### 加一个 provider（已有协议）
只改 `config/providers.json`，重启 server。**零代码改动**。

### 加一个真执行工具
在 `apps/server/src/exec-tool.ts` 的 `tools[]` 数组里 push 一项。`--hot` 自动 reload。

### 加一个 API 协议（不是 OpenAI 也不是 Anthropic）
比如 Vertex 自己的 `predict` 协议、Cohere `/chat`、火山引擎私有协议（如果它不兼容 OpenAI）：

1. `packages/shared/src/schema.ts`：`ApiProtocol` enum 加新值
2. `apps/server/src/run.ts`：`runOnce` 和 `runStream` 加 `if (provider.api === 'cohere')` 分支
3. `packages/shared/src/adapter.ts`：写 `toCohereMessages` / `fromCohereMessage`
4. SDK 安装到 `apps/server/package.json` deps

### 加一个新的 content block 类型
比如要支持 `audio` / `video`：

1. schema.ts：`AudioBlock` z 类型 + 加进 `UserContentBlock` 的 union
2. MessageCard.tsx：在 `BlockEditor` 加 case + UI
3. 决定是否要在 BlockAdder 列出选项

### 加一个不同的对话视图（比如树状）
当前 messages 是线性数组。如果想做对话分支树（看不同 fork 路径并排），
要拆分 `messages` 为节点 + 边的图，这是大改动。`fork` 现在是"截断"语义，
可以扩展成"复制成新分支"语义来实现树形。

## 安全模型

| 资产 | 风险 | 缓解 |
|---|---|---|
| `config/providers.json` 含 keys | 提交到 git 泄漏 | `.gitignore`；`example` 模板分离 |
| 任意 LLM 决定调任意工具 | RCE | 服务端白名单，模型说调啥不算数 |
| `web_fetch` 的 SSRF | 内网扫描 | 协议限 http(s)，10s 超时，10KB 截断（**没禁内网 IP，这是个已知问题**） |
| `calculator` `new Function` | 注入 | 正则白名单 `[\d\s+\-*/().]+` 约束输入字符 |
| Cases 路径遍历 | 写到工作目录外 | `safeJoin` 校验 abs path 在 ROOT 下 |
| Workspace 不限大小 | 磁盘填满 | 没限——大型 case 应该走 cases，workspace 是当前编辑 |

**这是开发工具，不是公网服务**。不要把 server 暴露到公网。
默认绑定 `localhost` 是 Bun/Hono 默认行为；如果想改 host，改 `apps/server/src/index.ts` 的 export。

## 性能粗看

- 启动：bun --hot ~ 200ms 冷启
- 单条 LLM 请求：取决于 provider，~ 500ms（小模型）到 13s（reasoner）
- 流式延迟：服务端 NDJSON 转发开销 < 1ms / 行
- 持久化：workspace.json debounce 400ms，写入 < 5ms（小 JSON）

## 已知限制

- 没有 Stop / Cancel 按钮（关 tab 即可中断）
- `tool_input_delta` 解析靠多次试 JSON.parse，理论上可以更精确（streaming JSON parser）
- `reasoning_content` 只识别 OpenAI/DeepSeek 几种已知形态，新出现的 provider 字段名可能不识别
- Compare 限两栏
- 图片输入 schema 已有，UI 没做上传按钮

要做哪个，PR 欢迎。
