# 05 工具调用与真执行

## 工具的两种存在

**1. 模型可见的 tool 定义** — 你在中间面板的 `Tools` 区块定义的。
每条有 name / description / input_schema (JSON Schema)。
这部分会跟着请求一起发给模型，让模型知道"我可以调这些"。

**2. 服务端实际能跑的 tool** — 在 `apps/server/src/exec-tool.ts` 写死的白名单。
默认包含一组基础工具：`get_time` / `run_command` / `read_file` /
`write_file` / `list_files` / `search_code` / `fetch_url` / `web_fetch` /
`calculator`。

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

### 默认基础工具

| name | 干啥 | 安全约束 |
|---|---|---|
| `get_time` | 返回当前日期、时间、星期、时区、timestamp | 无副作用，可指定 IANA timezone |
| `run_command` | 执行本地 shell 命令，适合调试 skill 里的 bash/script | 默认 sandbox；工作目录必须在 allowlist 内；macOS 下用 `sandbox-exec` 限制写入范围并禁用网络；危险系统命令拦截；默认 60s 超时，输出截断 |
| `read_file` | 读取本地文本文件，带行号 | 只能读 allowlist 内路径；大文件需要 `offset` / `limit` |
| `write_file` | 创建或覆盖本地 UTF-8 文本文件 | 只能写 sandbox 可写根；默认不覆盖已有文件，默认不创建父目录；单次最多 512KiB |
| `list_files` | 列目录、按 glob 过滤 | 只能列 allowlist 内路径；自动跳过 `node_modules` / `.git` 等噪音目录 |
| `search_code` | 本地代码 regex / symbol 搜索 | 只能搜 allowlist 内路径；优先 `rg`，失败回退 `grep`，输出截断 |
| `fetch_url` | GET 一个 URL，返回 text/html/json | 限 http(s)，15s 超时，最大 128KB |
| `web_fetch` | `fetch_url` 的兼容别名 | 同上 |
| `calculator` | 算数学表达式 | 正则白名单字符 `[\d\s+\-*/().]+`，`new Function` 跑 |

#### `run_command` sandbox

`run_command` 默认启用本地沙箱：

- 默认允许根：当前 repo、`skills/`、 sibling `../rule_agent/skills`
- 额外允许根：设置环境变量 `LLM_IMPL_ALLOWED_ROOTS`，多个路径用系统 path delimiter 分隔
- `sandbox_mode: "workspace-write"`：允许写 `working_directory` 和临时目录
- `sandbox_mode: "read-only"`：不允许写 `working_directory`，但仍允许写临时目录，避免多数解释器启动失败
- `write_file` 在 `workspace-write` 下允许写 allowlist / writable roots / 临时目录；在 `read-only` 下只允许写 writable roots / 临时目录
- macOS sandbox 默认禁用网络访问，并拒绝命令里直接引用 allowlist 外的绝对路径
- macOS 有 `/usr/bin/sandbox-exec` 时会使用 OS sandbox；其他系统退化为路径 allowlist + 精简环境变量 + 危险命令拦截

沙箱配置有三层，后者覆盖前者：

1. server 全局默认：repo / skills / `LLM_IMPL_ALLOWED_ROOTS`
2. case JSON 的 `sandbox` 字段：当前 case 内所有内置工具执行都会继承
3. 单次内置工具 `input`：只影响这一条工具调用。`run_command` / `write_file` 支持常用 sandbox 覆盖字段

case 级示例：

```json
{
  "sandbox": {
    "label": "skill-debug-readonly",
    "mode": "read-only",
    "network": "blocked",
    "allowedRoots": [
      "/Users/bytedance/Desktop/work/desktop/llm-impl",
      "/Users/bytedance/Desktop/work/desktop/rule_agent/skills"
    ],
    "writableRoots": [
      "/tmp/llm-impl-debug-output"
    ]
  }
}
```

单次工具调用覆盖示例：

```json
{
  "type": "tool_use",
  "name": "run_command",
  "input": {
    "command": "python scripts/check.py",
    "working_directory": "/Users/bytedance/Desktop/work/desktop/rule_agent/skills/foo",
    "sandbox_mode": "workspace-write",
    "sandbox_network": "allowed",
    "sandbox_allowed_roots": ["/Users/bytedance/Desktop/work/desktop/extra-fixtures"],
    "sandbox_writable_roots": ["/tmp/llm-impl-check-output"]
  }
}
```

`write_file` 示例：

```json
{
  "type": "tool_use",
  "name": "write_file",
  "input": {
    "path": "/tmp/llm-impl-check-output/result.txt",
    "content": "ok\n",
    "create_dirs": true,
    "overwrite": false,
    "sandbox_mode": "read-only",
    "sandbox_writable_roots": ["/tmp/llm-impl-check-output"]
  }
}
```

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
