# 07 多模型对比

## 用途

同一份对话历史，发给两个不同（provider, model）组合，并排看响应差异。

适合：
- 选模型：同一个 prompt 哪家答得更对
- 看模型升级影响：旧版 vs 新版同一份回归用例
- 发现 provider 行为差异：Claude 4.6 thinking 版 vs 不带 thinking 的会不会绕弯
- 调 prompt：改完 system 后看在多个模型上是不是都改善

## 怎么用

1. 在底部发送栏点 **⇆ Compare Case**（未保存时显示 **⇆ Compare Draft**）
2. 弹出全屏 modal，两栏 A / B
3. 每栏顶部有 provider + model 下拉（A 默认是当前主配置，B 默认选一个不同 provider）
4. 点 **▶ Run both**
5. 两边同时流式输出，可以观察哪边先吐 token、哪边 latency 低、哪边 reasoning 长

如果当前 case 已经有最后一条 assistant 输出，Compare 会自动裁掉尾部 assistant turn，再把剩余历史发给模型；也就是"重放当前 case 的下一条回答"，避免把已有答案当成 assistant prefill 发给不支持 prefill 的模型。

DeepSeek thinking 模型如果遇到历史里的 `assistant tool_use` 缺少 `reasoning_content`，Compare 会自动关闭本次重放的 thinking mode，保留标准 tool-call / tool-result 历史继续跑。这样不会伪造 reasoning，也不会把工具结果拍平成普通文本。

Model Input 的 `Copy Stream` / `Copy Non-stream` 复用了同类适配思路：同一份 case 在切换 provider/model 后，
cURL 会按目标协议重新组织 endpoint、headers、stream 字段和 replay body，而不是盲目复制旧模型的请求格式。

```
┌──────────────────────────────────────────────────┐
│ Compare two models       [▶ Run both] [Close]    │
├────────────────────┬─────────────────────────────┤
│ pane A             │ pane B                      │
│ polo / sonnet-4-6  │ openai / gpt-5.4-mini       │
│ done · 1320ms      │ done · 920ms                │
│ ────────────────   │ ────────────────            │
│ thinking ...       │ text                        │
│ "First, I should…" │ "Let me work through this…" │
│                    │                             │
│ text               │ tool_use · calculator       │
│ "The answer is…"   │ { expression: "..." }       │
└────────────────────┴─────────────────────────────┘
```

## 实现细节

- 用的同一个 `/api/run` 流式端点，前端发两个并发 fetch
- 两边的状态完全独立（`useState`），不进主 store
- **不修改主 messages 数组**——你看完 close，主对话状态还是原样
- 不能从对比结果"应用"回主线（暂未做）；想用某条结果就手抄

## 想看 thinking？

只要 B 栏选的模型 reasoning=true（UI 下拉里带 🧠 徽标），thinking 块会以灰斜体显示。
DeepSeek-Reasoner 和 Anthropic extended-thinking 都会出现。

## 局限

**目前只支持 2 栏**——加 3 栏 / 4 栏的 grid 不难，没做主要因为屏幕宽度。
要加自己改 `apps/web/src/components/Compare.tsx`：
- 把 `[left, right]` 扩成 `panes[]`
- grid `cols-2` 改成 `cols-N`
- `Promise.all` 跑 N 个

**不会自动判分** —— 这是个调试器不是 eval 平台。
要 eval 看 [promptfoo](https://github.com/promptfoo/promptfoo) 之类的。

下一篇：[08 架构与扩展](08-architecture.md)
