# Engine 07 — Todos（小颗粒待办背景）

读取用户 vault 中的 todos 文件，作为**背景信息**参与 weekly review，但不替代 OKR 分析。

> **仅在 `vault.enabled = true` 且 `vault.todos` 已配置时执行**。

## 设计原则

1. **只读不写**：skill 永远不修改 todos.md。完成项的归档由用户手动做
2. **背景而非主线**：todos 不进入 KR 完成率统计、不抢 MIT 槽位、不挤压 OKR 要务
3. **建议入选不强制**：urgent / overdue 的 todo 写入"如有余力"区块，由用户决定是否真做
4. **与 OKR 解耦**：不做关键词重合检测（保守起见，避免误判）

## 何时执行

在标准流程中作为 **Step 2.7**——metadata 补全（Step 2.5）之后、watch-list 扫描（Step 3.5）之前。

理由：
- 分析（Step 3）需要 todos 的逾期信息作为状态信号
- 计划生成（Step 4）需要 todos 候选作为"如有余力"输入

## 文件位置

```
{vault.path}/{vault.todos}
```

默认 `99_Meta/todos.md`。可在 `config.yaml` 修改。

## 文件格式

```markdown
---
用途: 小颗粒待办事项；非 OKR 推进项
最后更新: YYYY-MM-DD
---

# Todos

## 🔴 Open

- [ ] 续车保 [DDL: 2026-05-10] [urgent]
- [ ] 买羽毛球鞋 [DDL: 2026-05-15]
- [ ] follow up Benoit Q3 funding
- [ ] 读那篇 agentic AI patterns 文章
- [ ] 给老妈寄药 [blocked: 等地址确认]

## ✅ Done (last 7 days)

- [x] 给 TA 发邮件问 office hour [done: 2026-05-02]
- [x] 交报税材料 [done: 2026-05-03]

## 🅿️ Parked

- [ ] 调研 Notion → Obsidian 迁移 [parked]
```

## 段落识别规则

| 段落标题 | 处理 |
|---|---|
| `## Open` 或包含"Open" / "🔴" | open 池 |
| `## Done` 或包含"Done" / "✅" | done 池（最近 N 天的进入"上周完成"） |
| `## Parked` 或包含"Parked" / "🅿️" | parked 池（隐藏在末尾） |

任何未识别的段落 → 当作 open（最宽松匹配）。

## 标签解析

| 标签 | 正则 | 含义 |
|---|---|---|
| `[DDL: YYYY-MM-DD]` | `\[DDL:\s*(\d{4}-\d{2}-\d{2})\]` | 截止日 |
| `[urgent]` | `\[urgent\]` | 用户主动标紧急 |
| `[blocked: <reason>]` | `\[blocked:\s*([^\]]+)\]` | 卡住原因 |
| `[parked]` | `\[parked\]` | 主动延后 |
| `[done: YYYY-MM-DD]` | `\[done:\s*(\d{4}-\d{2}-\d{2})\]` | 完成日期 |

## 执行步骤

### Step 2.7.1：加载文件

```bash
cat "{vault.path}/{vault.todos}"
```

文件不存在：
- 第一次：询问用户是否创建空模板（y/n/skip，默认 skip）
- 用户选 `n` 或 `skip` → 关闭本次 todos 功能，正常继续

### Step 2.7.2：解析

按段落分类，每个 todo 项提取：

```python
{
    'text': str,                   # 去掉所有标签后的纯文本
    'raw': str,                    # 原始文本（含标签）
    'section': 'open' | 'done' | 'parked',
    'deadline': 'YYYY-MM-DD' | None,
    'urgent': bool,
    'blocked': str | None,         # 卡住原因，None 表示未阻塞
    'done_date': 'YYYY-MM-DD' | None,
    'urgency': 'overdue' | 'this_week' | 'next_two_weeks' | 'no_ddl' | 'blocked' | 'parked'
}
```

派生 `urgency` 的逻辑：

```python
def derive_urgency(todo, today):
    if todo['blocked']: return 'blocked'
    if todo['section'] == 'parked': return 'parked'
    if todo['urgent']: return 'this_week'   # 用户标 urgent 强制本周
    d = todo['deadline']
    if not d: return 'no_ddl'
    days = (d - today).days
    if days < 0: return 'overdue'
    if days <= 7: return 'this_week'
    if days <= 14: return 'next_two_weeks'
    return 'comfortable'
```

### Step 2.7.3：传给分析和计划

输出结构（被 `engine/02-analyze.md` 消费）：

```python
{
    'todos': {
        'open': [...],          # all open todos
        'done_recent': [...],   # last 7 days done
        'parked': [...]
    },
    'todos_by_urgency': {
        'overdue': [...],
        'this_week': [...],
        'next_two_weeks': [...],
        'no_ddl': [...],
        'blocked': [...],
        'parked': [...]
    },
    'todos_summary': {
        'open_count': int,
        'overdue_count': int,
        'this_week_count': int,
        'blocked_count': int
    }
}
```

## 错误处理

| 情况 | 处理 |
|---|---|
| 文件不存在 | 询问是否创建（y/n/skip） |
| 文件存在但格式怪异（无 `## Open` / `## Done` 段） | 当成纯 open 池处理，整个文件的 `- [ ]` 都是 open |
| 标签格式错误（如 `[DDL: 不是日期]`）| 忽略该标签，todo 视为无 DDL |
| YAML frontmatter 损坏 | 跳过 frontmatter，正常解析正文 |

## 隐私与边界

- 文件全程**只读**，skill 不写、不删、不归档
- 不做 OKR 关键词重合检测（避免误判，保守）
- 不扫描 daily 笔记的 `- [ ]`（避免和这里的 todos 冲突；用户想用 daily 列待办应自己合并到 todos.md）
- 不持久化任何状态（每次运行都重新读取）
