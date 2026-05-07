# 06 用例与持久化

工具有两种持久化机制：**workspace（自动）** 和 **cases（手动命名保存）**。

## Workspace：自动保存当前编辑

你点开浏览器看到的"上次编辑到一半的状态"，存在 server 端的：

```
state/workspace.json
```

写入触发：前端任何 message / config / tools / system 变化 → 400ms debounce → PUT `/api/workspace`。

读取触发：浏览器加载时 GET `/api/workspace` → 应用到 store。

特点：
- 同一台 server 任何浏览器/标签打开都看到同一份（服务端文件就是 single source of truth）
- 改了立即写盘，关浏览器不丢
- **跟 cases 完全独立** —— 你可以对一个已保存的 case 做改动，workspace 跟进，但 case 文件不变

`state/` 整个目录已加 `.gitignore`。如果你想清空状态：
```bash
rm state/workspace.json
```

## Cases：命名保存调试用例

左栏的文件树。这些是**有名字、可以提交进 git** 的调试快照。

### 保存

左栏 `Save` 按钮 → 输入相对路径，比如 `auth/inject-prompt.json`：

```
cases/
├─ auth/
│  └─ inject-prompt.json
└─ example/
   └─ weather.json
```

可以用 `/` 嵌套子目录。文件不存在自动 mkdir。

### 加载

点用例名字 → 当前 workspace 被该 case 覆盖。被加载的用例在树里高亮（绿字）。

### 删除

悬停文件名 → 右边出现 ✕ → 二次确认。

### 文件结构

case 是一个 JSON：
```json
{
  "meta": {
    "name": "...",
    "tags": ["..."],
    "updatedAt": "ISO timestamp"
  },
  "config": { "provider": "...", "model": "...", "temperature": 0, ... },
  "system": "...",                  // 可选
  "tools": [ { "name": "...", "input_schema": {...} } ],   // 可选
  "messages": [ ... ],
  "lastRun": {                      // 可选，最后一次跑的元数据
    "timestamp": "...",
    "usage": {...},
    "latency_ms": 1234,
    "stop_reason": "end_turn"
  }
}
```

直接编辑这个文件也可以——server 不缓存，前端下次 load 看到改后的内容。

## Workspace vs Cases

| | workspace | case |
|---|---|---|
| 文件路径 | `state/workspace.json` | `cases/**/*.json` |
| git 跟踪 | 否（gitignored） | 是（推荐） |
| 何时写 | 前端任何变化自动 debounce 400ms | 显式点 Save |
| 何时读 | 页面加载 | 点用例名字 |
| 数量 | 全局唯一 | 任意多 |
| 用途 | 当前编辑状态 | 命名快照 / 回归库 |

## Copy / Import JSON（剪贴板）

顶栏有：
- **Copy JSON** — 当前状态序列化拷贝到剪贴板
- **Import JSON** — 弹层粘贴 JSON 加载

用途：
- 同事问"你那边怎么 prompt 这种行为？" → 你 Copy → 贴聊天软件 → 他 Import
- 不想用 cases 文件树，直接发 JSON 共享调试样本

格式跟 case 一样（`Case` schema），但**不会改 workspace 的 currentCasePath**。

## 服务端目录结构

```
项目根/
├─ cases/                  # 提交进 git，用例库
│  └─ example/weather.json
├─ state/                  # 不提交
│  └─ workspace.json       # 自动保存的当前编辑
└─ config/
   └─ providers.json       # 不提交（含 keys）
```

`CASES_DIR` 和 `STATE_DIR` 都可通过环境变量覆盖：

```bash
CASES_DIR=/tmp/my-cases STATE_DIR=/tmp/my-state bun run dev:server
```

适合多个项目共用同一份调试库的场景。

## 一些工作流建议

### 把"已知坏"的对话保存为回归用例
某个 prompt 在某个模型下总出问题 → Save 成 `regressions/foo-model-thinking-loop.json` →
提交 git → 模型升级时 Import 看修没修。

### 用 git 看 case 演化
case 是普通 JSON，跟正常代码一样 diff / blame。
"上周这个 system prompt 是怎么写的" → `git log cases/auth/login.json`。

### 跟 LLM 聊出来的对话直接调试
线上系统 log 出一条对话历史 → 把 messages 数组复制 → Import JSON 包成 case 结构 →
直接从那个上下文继续调。

下一篇：[07 多模型对比](07-compare.md)
