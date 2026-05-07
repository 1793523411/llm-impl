# 05 工具调用与真执行

## 工具的两种存在

**1. 模型可见的 tool 定义** — 你在中间面板的 `Tools` 区块定义的。
每条有 name / description / input_schema (JSON Schema)。
这部分会跟着请求一起发给模型，让模型知道"我可以调这些"。

**2. 服务端实际能跑的 tool** — 在 `apps/server/src/exec-tool.ts` 写死的白名单。
默认有 3 个：`get_time` / `web_fetch` / `calculator`。

两者**通过 name 字段对应**：你定义一个 `calculator` 工具给模型，模型决定调它，
如果服务端白名单里也有同名 `calculator`，前端就显示 ▶ run 按钮可一键真执行。

## 定义一个工具（给模型看）

中间面板展开 `Tools` → `+ Add tool`：

- **name**：`calculator`
- **description**：`Evaluate a math expression`
- **input_schema** (JSON Schema)：
```json
{
  "type": "object",
  "properties": {
    "expression": { "type": "string", "description": "A math expression" }
  },
  "required": ["expression"]
}
```

## 模型调用流程

1. 你写 user：`What is (15 * 23) + 7?`
2. Send
3. 模型可能返回：
   ```
   assistant message:
     - text "Let me calculate that"
     - tool_use { name: "calculator", input: { expression: "(15*23)+7" }, id: "toolu_xxx" }
   ```
4. 前端**自动 stub** 一条 user 消息：
   ```
   user message:
     - tool_result { tool_use_id: "toolu_xxx", content: "" }   ← 空，待填
   ```
5. **手填模式**（默认）：你在 content 里随便写点啥，比如 `352`，再点 Send
   **或** **真执行模式**：tool_result 卡片右上角有个 **▶ run calculator** 按钮（因为白名单里有），
   点一下 → POST `/api/exec-tool` → server 执行 → content 自动填好
6. Send 让模型基于 result 继续

## 真执行白名单

`apps/server/src/exec-tool.ts` 里定义。每条结构：

```ts
{
  name: string                    // 必须跟模型可见的 tool name 完全一致
  description: string
  input_schema: object            // JSON Schema 用于 /api/exec-tools 列表
  handler: async (input) => ({ content: string, is_error?: boolean })
}
```

### 默认 3 个

| name | 干啥 | 安全约束 |
|---|---|---|
| `get_time` | 返回当前 ISO timestamp | 无副作用 |
| `web_fetch` | GET 一个 URL，返回 text | 限 http(s)，10s 超时，10KB 截断 |
| `calculator` | 算数学表达式 | 正则白名单字符 `[\d\s+\-*/().]+`，`new Function` 跑 |

### 增加一个工具

在 `tools[]` 数组里 push 一项。比如让模型可以查 IP：

```ts
{
  name: 'whois_ip',
  description: 'Lookup geolocation for an IP address',
  input_schema: {
    type: 'object',
    properties: {
      ip: { type: 'string', description: 'IPv4 address' },
    },
    required: ['ip'],
    additionalProperties: false,
  },
  handler: async (input) => {
    const ip = String(input.ip ?? '')
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return { content: 'invalid ipv4', is_error: true }
    }
    const res = await fetch(`https://ipapi.co/${ip}/json/`)
    return { content: await res.text(), is_error: !res.ok }
  },
},
```

server 自动 reload（`--hot` 模式）。前端 `refreshExecTools` 刷新后，
新 tool 会进可执行白名单。模型看到的工具定义还是要你在前端 Tools 面板手加。

### 为什么是白名单

任何"模型说调什么 server 就跑什么"的设计都是 RCE。
我们要求工具**显式注册在服务端代码**里——你审过它的实现才会编译进去。
模型说调 `rm -rf /` 也没用，因为白名单里没这个。

## /api/exec-tools 端点

server 暴露注册了哪些工具：

```bash
curl http://localhost:3181/api/exec-tools | jq .
```

前端启动时拉这个。某条 tool_result 上是否显示 ▶ run，
取决于 `<tool_use 的 name> ∈ <这个列表的 name 集合>`。

## /api/exec-tool 端点

实际执行：

```bash
curl -X POST http://localhost:3181/api/exec-tool \
  -H "content-type: application/json" \
  -d '{"name":"calculator","input":{"expression":"7*8+1"}}'
# → {"content":"57"}
```

返回 `{ content: string, is_error?: boolean }`。前端把 content 灌进 tool_result 块。

## 几个用法场景

### 1. 调试模型用工具的姿势
定义 tool → 让模型用 → 看它生成的 input 对不对 → 改 input 看模型怎么解读 result。

### 2. 模拟边界 case
真执行模式下，让 calculator 算 `1/0` —— 看模型如何处理 `is_error: true` 的 result。
或者改 result 里加上诡异内容（含 prompt injection），看模型会不会被骗。

### 3. 不调真工具也能调试 agent
完全用手填模式：定义 tool → 模型决定调 → 你手写 result 当 stub →
看模型在不同 result 下分支走哪边。**根本不用真实现工具**就能测 agent 逻辑。

下一篇：[06 用例与持久化](06-cases-and-state.md)
