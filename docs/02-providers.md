# 02 Providers 与模型

## 配置文件

所有 provider 信息在 `config/providers.json`（gitignored）。
模板在 `config/providers.example.json`（committed）。

## Schema

```jsonc
{
  "includes": [
    "../other-project/config/models.json" // 可选，支持复用其他项目里的 providers 配置
  ],
  "providers": {
    "<provider-key>": {
      "baseUrl": "https://...",          // SDK baseURL 覆盖
      "apiKey": "sk-...",                // 该 provider 的 key
      "api": "openai-completions" | "openai-responses" | "anthropic-messages",
      "models": [
        {
          "id": "model-id-passed-to-sdk",  // 必填
          "name": "可读名字",               // 可选，UI 用
          "reasoning": true,               // 可选，UI 显示 🧠 徽标
          "input": ["text", "image"],      // 可选，UI 显示 🖼 徽标
          "contextWindow": 200000,         // 可选
          "maxTokens": 8192                // 可选
        }
      ]
    }
  }
}
```

也支持读取形如 `{ "models": { "providers": { ... } } }` 的配置文件，适合直接复用其他调试工具里的模型清单。

## API 协议

支持三种协议（涵盖常见厂商和代理）：

### `openai-completions`

走 OpenAI Chat Completions API：
```
POST {baseUrl}/chat/completions
Authorization: Bearer {apiKey}
```

适配的模型类型：GPT-4 / 5 系列、DeepSeek、Gemini（通过兼容层）、各种豆包/通义/Mistral 代理、本地 ollama / vLLM 等。

特殊处理：
- 模型 id 匹配 `^(o[0-9]|gpt-5)` 的（比如 GPT-5、o1、o3）会自动用 `max_completion_tokens` 替代 `max_tokens`，因为新模型不接受老参数
- 支持 `reasoning_content` 字段（DeepSeek-Reasoner 风格），会被抽成 thinking 块

### `openai-responses`

走 OpenAI Responses API：
```
POST {baseUrl}/responses
Authorization: Bearer {apiKey}
```

适配的：OpenAI Responses 兼容服务，例如 Ark `/api/v3/responses`。

特殊处理：
- `max_tokens` 会转成 `max_output_tokens`
- 用户图片块支持 URL 或 base64 data URL，发送时会转成 `input_image`
- 当前 streaming 会先调用一次 Responses API，再合成前端需要的 NDJSON 事件

### `anthropic-messages`

走 Anthropic Messages API：
```
POST {baseUrl}/v1/messages
x-api-key: {apiKey}
anthropic-version: 2023-06-01
```

适配的：Anthropic 官方、各种 Claude 代理（poloai / haoz / minmax-claude 等）。

支持原生的 thinking、tool_use、cache_creation/cache_read tokens。

## 添加一个新 provider

直接在 `config/providers.json` 里加一项就行，重启 server 生效。

例：加 OpenRouter：
```json
"openrouter": {
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-...",
  "api": "openai-completions",
  "models": [
    { "id": "anthropic/claude-3.5-sonnet", "name": "Claude 3.5 via OpenRouter" }
  ]
}
```

## /api/providers 端点

server 把配置剥掉 `apiKey` 后通过 `GET /api/providers` 暴露给前端：

```bash
curl http://localhost:3181/api/providers | jq .
```

前端启动时拉这个填充 provider / model 下拉。

## 连通性测试

右侧模型选择器旁的 `Test` 会调用：

```bash
curl http://localhost:3181/api/providers/test \
  -H 'content-type: application/json' \
  -d '{"provider":"ark","model":"ep-..."}'
```

server 会发起一个最小文本请求，并返回 `ok`、延迟、token 用量和一小段输出样例。

## 为什么不用 .env

`.env` 适合 1–2 个 key，但当你接 9 个 provider、22 个模型，每家有自己的 baseUrl 和别名，
把这些塞 `.env` 会很难看。

JSON 配置文件的好处：
- provider/model 关系结构化
- 多人协作时模板可以提交（example），真 key 自己填
- server 启动时一次性加载，不用到处读 `process.env`

## 安全提醒

- `config/providers.json` 含明文 key，**永远不要 commit**（`.gitignore` 已包含它）
- 如果 key 泄露，尽快去厂商控制台轮换
- 不建议在多人共用的机器上跑（任何能读你 home 目录的人都能拿到 keys）

下一篇：[03 核心调试工作流](03-workflow.md)
