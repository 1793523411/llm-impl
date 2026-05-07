# 01 快速开始

5 分钟跑起来。

## 前置

- macOS / Linux（Windows 用 WSL）
- [Bun](https://bun.sh) ≥ 1.3

如果没装 bun：
```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL  # 让 PATH 生效
```

## 1. 装依赖

```bash
cd llm-impl
bun install
```

会装大约 300 个包，10–20 秒。

## 2. 配置 provider

```bash
cp config/providers.example.json config/providers.json
```

打开 `config/providers.json`，填上至少一个 provider 的 `baseUrl` + `apiKey`。
默认模板里有 `anthropic` 和 `openai` 两个示例。

最小配置：
```json
{
  "providers": {
    "anthropic": {
      "baseUrl": "https://api.anthropic.com",
      "apiKey": "sk-ant-...",
      "api": "anthropic-messages",
      "models": [
        { "id": "claude-opus-4-7", "name": "Claude Opus 4.7" }
      ]
    }
  }
}
```

完整 schema 看 [02 Providers 与模型](02-providers.md)。

> `config/providers.json` 已加 `.gitignore`，不会被 git 跟踪。

## 3. 启动

```bash
bun run dev
```

会同时起两个服务：
- **server** → `http://localhost:3181`（Hono，调 LLM）
- **web** → `http://localhost:5181`（Vite，浏览器）

打开 http://localhost:5181

## 4. 发第一条消息

页面布局是三栏：

- **左栏 Cases**：保存的调试用例（开始是空的）
- **中间**：System prompt + Tools + Messages
- **右栏 Config**：选 provider / model / 温度 等

操作步骤：
1. 右栏选 provider（比如 `anthropic`）和 model
2. 中间下方有一条 user 消息空白，输入 `你好`
3. 点底部的 **Send ▶**

应该能看到一条 assistant 消息出现，文字一个个流式蹦出来（如果是流式）。
右栏底部会显示 latency / token 数。

## 5. 篡改它

试一下核心功能：

1. 鼠标悬停在刚才那条 assistant 消息上，**直接改文字**
2. 在中间最下方点 **+ User message**，输入新问题
3. 点 Send

模型现在以为自己上一轮说了你改后的内容，会基于这个继续。

## 端口冲突

如果 `5181` 或 `3181` 被占了，改这两个文件：
- `apps/web/vite.config.ts` → `server.port` + `proxy['/api']` target
- `apps/server/src/index.ts` → `process.env.PORT ?? 3181`

或者直接 `PORT=4000 bun run dev:server` 一次性覆盖。

下一篇：[02 Providers 与模型](02-providers.md)
