# 04 流式与推理思考

## 流式总开关

`POST /api/run` 看请求体里 `config.stream` 字段：
- `false`（默认）→ 等模型完整生成，返回一个 JSON
- `true` → 返回 `application/x-ndjson` 流，前端逐行解析

前端 `send()` 总是设 `stream:true`，所以你在 UI 看到的就是流式。
导出/导入 JSON 时 `stream` 字段保留但不影响行为。

## NDJSON 事件协议

每行是一个 JSON。事件类型有 7 种：

```ts
{ type: 'block_start', index: number, block: AssistantContentBlock }
{ type: 'text_delta', index: number, delta: string }
{ type: 'thinking_delta', index: number, delta: string }
{ type: 'tool_input_delta', index: number, delta: string }    // 部分 JSON 字符串
{ type: 'block_stop', index: number }
{ type: 'message_stop', stop_reason: string|null, usage?, latency_ms }
{ type: 'error', message: string }
```

`index` 是 block 在 assistant message content 数组里的下标。
`tool_input_delta.delta` 是 tool_use input JSON 的**部分文本**——前端每次累积后试一次 `JSON.parse`，
能解就更新 input，不能解就等下一段。

## 服务端如何统一事件

**Anthropic** 原生流事件几乎跟我们 1:1：
- `content_block_start` → `block_start`
- `content_block_delta`（含 text_delta / thinking_delta / input_json_delta）→ 对应 *_delta
- `content_block_stop` → `block_stop`
- `message_stop` + `await stream.finalMessage()` → 我们的 `message_stop` 事件（带完整 usage）

**OpenAI** chunk 是扁平的 `choices[0].delta`，需要状态机合成 block 边界：
1. 维护 `currentNonToolType`（'text' | 'thinking' | null）
2. 看到 `delta.reasoning_content` → 如果当前不是 thinking 就关掉旧块开新 thinking 块
3. 看到 `delta.content` → 同理切换到 text 块
4. 看到 `delta.tool_calls[i]` → 按 OpenAI 给的 `index` 维护一个独立 tool_use 块
5. 流结束时把所有未关的块 `block_stop`

代码在 `apps/server/src/run.ts` 的 `runOpenAIStream`。

## 推理（thinking）块从哪来

三种来源：

### 1. Anthropic extended thinking
右栏勾上 **extended thinking**，设个 budget（≥1024）。
请求会带 `thinking: { type: 'enabled', budget_tokens: N }`。
Anthropic 返回的 stream 会先发 `content_block_start { type: 'thinking' }`，
然后流式 `thinking_delta`。

### 2. DeepSeek-Reasoner 风格
DeepSeek 的 `deepseek-reasoner` 在每个 chunk 的 `delta.reasoning_content`
里返回思考字符串（先于 content）。我们的 OpenAI 流处理代码识别这个字段并合成 thinking 块。

### 3. 部分代理把 reasoning 放在 message.content 数组里
形如 `content: [{ type: 'reasoning', text: '...' }, { type: 'text', text: '...' }]`。
非流式响应里 `fromOpenAIMessage` 会把 `type: 'reasoning'` 的项转成 thinking 块。

## 前端如何渲染

`store.send` 里的 `for await` 循环按事件更新 store 中的 draft assistant message：

```ts
for await (const ev of stream) {
  switch (ev.type) {
    case 'block_start':       // 在 messages[draftIdx].content[ev.index] 写入新 block
    case 'text_delta':        // 找到 text block，append delta 到 .text
    case 'thinking_delta':    // 找到 thinking block，append 到 .thinking
    case 'tool_input_delta':  // 累积到 inputBuffers[ev.index]，试解析
    case 'block_stop':        // tool_use 时做最后一次 parse
    case 'message_stop':      // 记录 stop_reason / usage / latency
    case 'error':             // throw
  }
}
```

每个事件都触发一次 zustand `set()`，React 重渲染对应的 block。
你看到的就是 token 一个个流出。

## 几个边角情况

### 流被打断
现在没有 Stop 按钮，但你可以关闭浏览器标签——server 端 `for await` 会感知到客户端断开，自然结束。
draft message 留在历史里、内容停在断开那一刻，你可以编辑或删掉。

### 流式 + tool_use 同时
模型可能一条 assistant 消息里既有 text 又有 tool_use（先解释再调）。
事件流是按 block 顺序串行的：text 块完整流完 `block_stop` 后才会开始 tool_use 块。

### Usage 啥时候有
- Anthropic：`message_stop` 事件里带，来自 `stream.finalMessage()`
- OpenAI：必须设 `stream_options: { include_usage: true }`，最后一个 chunk 才会有 usage。我们已经传了
- 部分代理（特别是国内 OpenAI 兼容代理）不返回 usage——会显示 `?`

下一篇：[05 工具调用与真执行](05-tools.md)
