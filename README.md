# llm-impl

一个用于**调试 LLM 对话流**的本地工具：让你可以介入 agent loop 的每一步——
篡改任意一条 assistant 消息、改 tool_use 的参数、手填 tool_result，
然后让模型基于"你改后的历史"继续。

支持 9 个上游 provider、24 个模型（OpenAI / Anthropic 协议），
NDJSON 流式输出，reasoning 思考块抽取，工具白名单真执行，
多模型并排对比。

## 文档

按顺序读：

| # | 文档 | 内容 |
|---|---|---|
| 00 | [介绍](docs/00-intro.md) | 它是什么、解决什么问题、与 Playground 的区别 |
| 01 | [快速开始](docs/01-quickstart.md) | 装 Bun、配置 keys、起服务、发第一条消息 |
| 02 | [Providers 与模型](docs/02-providers.md) | `config/providers.json` 结构，添加自定义 provider |
| 03 | [核心调试工作流](docs/03-workflow.md) | 三栏布局，消息/Block 编辑，Send / Fork / Continue |
| 04 | [流式与推理思考](docs/04-streaming-reasoning.md) | 流式事件协议，thinking 块如何流出 |
| 05 | [工具调用与真执行](docs/05-tools.md) | 定义 tools schema，手填 vs ▶ run 真跑 |
| 06 | [用例与持久化](docs/06-cases-and-state.md) | Cases 文件树，workspace 自动保存，Copy/Import JSON |
| 07 | [多模型对比](docs/07-compare.md) | Compare modal 用法，并排 diff |
| 08 | [架构与扩展](docs/08-architecture.md) | 目录结构、协议适配器、扩展工具/provider/协议 |

## 启动一句话

```bash
cp config/providers.example.json config/providers.json
# 编辑 providers.json 填上你的 baseUrl + apiKey
bun install
bun run dev
# → http://localhost:5181
```
