# Engine 02 — 分析：对比计划与执行

读取文档数据后，按以下步骤对比计划与执行，识别偏移点。

## 输入

- OKR 定义（从 Weekly 文档的 OKR 章节提取）
- 最近 N 周执行数据（Weekly 表格中的要务列 + retro 列）
- 用户当次输入的 retro 和感受
- 分析框架（从 `frameworks/{framework}.md` 加载）

## 分析步骤

### Step 1：建立 OKR 对照表

从读取的内容中提取每个 OKR 的：
- Objective 描述
- 每个 KR 的描述
- P0/P1 优先级
- 是否标注 MIT

### Step 2：逐 KR 检查执行情况

对每个 KR，在最近 N 周的执行数据中找到对应的要务项，判断：

| 状态 | 标志 | 含义 |
|---|---|---|
| 完成 | ✅ | 当周完成 |
| 进行中 | 🚧 / Doing-xx% | 有进展但未完成 |
| 未开始 | 暂未开始 / ⭕️ | 计划了但未执行 |
| 长期未完成 | 连续 2+ 周 ⭕️ | 结构性问题，需重点标记 |

### Step 3：计算 MIT 完成率

统计标注为 MIT 的任务中，实际完成（✅）的比例。

- MIT 完成率 < 50%：警示，说明精力分散或 MIT 设置过多
- 一周内 MIT 数量 > 2：提示 MIT 失效风险

### Step 4：识别偏移模式

检查以下典型偏移：

1. **项目漂移**：同一 OKR 下，连续多周切换不同子任务，没有一个推进到完成
2. **名利方向停滞**：自媒体/输出类 KR 连续 3+ 周 ⭕️
3. **被动收入零进展**：金钱类 OKR 连续多季度 0%
4. **作息影响效率**：retro 中反复出现"作息不规律"关键词
5. **Q1 挤压 Q2**：日常工作（紧急）占满所有 MIT，重要不紧急的 KR 被持续搁置

### Step 5：结合用户 retro 和感受校正

用用户当次输入修正机器分析的盲点。

**5.1 情绪 / 状态校正**
- 用户说"情绪低落" → 降低对本周执行率的苛责，关注下周是否有节奏恢复计划
- 用户说"外部压力大" → 标记为外部因素，不归因为执行力问题
- 用户说某项"已完成但没记录" → 修正状态

**5.2 卡点分类校正（消费"有待提高"中的"卡在哪"字段）**

每个未完成项后跟随的卡点标签决定下周建议方向：

| 卡点类型 | 处方方向 | 不要做什么 |
|---|---|---|
| 外部阻塞 | 标记为外部依赖，下周计划保留但备注"等待 X"；建议主动 follow up 的动作 | 不要归因为用户执行力问题 |
| 自己拖延 | 检查是否长期模式（连续 2+ 周同类卡点）；触发结构性提示，建议拆分到更小单元或换时间段 | 不要简单复制到下周计划 |
| 目标定错 | 触发"是否调整 KR"的下周建议；在 framework_diagnosis 中提示 OKR review | 不要把它当成执行问题 |

如未提供卡点标签：按原逻辑处理，但在输出中提示用户下次可以补充以提高分析质量。

**5.3 计划外项目处理（消费"计划外"字段）**

- 若标记为"重要不紧急"或与某 OKR 相关 → 累计为第二象限信号，建议下周计划主动纳入
- 若是"救火 / 突发 / 帮人" → 累计为第一/第三象限信号，连续 2+ 周出现则触发"时间被挤占"的结构性诊断
- 输出中 `unplanned_pattern` 字段记录类型与频次

### Step 6：消费 OKR Metadata（仅 vault.enabled = true）

加载 `engine/06-metadata.md` 写入的 metadata 文件后，每个 KR 的对照表新增以下字段：

| 字段 | 来源 | 用途 |
|---|---|---|
| `deadline` | metadata.{kr}.deadline | 计算 days_to_deadline |
| `effort` | metadata.{kr}.effort | 评估"小事推不动"还是"大事拖延" |
| `status` | metadata.{kr}.status | phantom 不计入未完成；parked 暂时不分析 |

#### 派生指标

```python
days_to_deadline = (deadline - today).days  # 无 deadline 时为 None

# 紧急度等级
if status == 'phantom':
    urgency = 'phantom'
elif days_to_deadline is None:
    urgency = 'no_ddl'
elif days_to_deadline < 0:
    urgency = 'overdue'
elif days_to_deadline <= 7:
    urgency = 'this_week'
elif days_to_deadline <= 14:
    urgency = 'next_two_weeks'
else:
    urgency = 'comfortable'
```

#### 新增结构性诊断

| 诊断 | 触发条件 |
|---|---|
| `deadline_pressure` | urgency ∈ {overdue, this_week} 且进度 <50% |
| `phantom_kr_warning` | status=phantom 且本季度第二次出现，提示用户"是否降级或移除" |
| `hidden_q1` | urgency=this_week 但本周要务里没标 MIT |

### Step 7：消费 Todos（仅 vault.todos 已配置）

加载 `engine/07-todos.md` 解析的 todos 数据后：

- **不计入 KR 完成率**（todos 是背景，不是 OKR 推进）
- 输出独立的 `todos_summary` 章节
- 标记需要本周关注的 todos：urgency ∈ {overdue, this_week}

#### 输出附加字段

```python
todos_summary = {
    'open_count': int,
    'overdue': [{'text': '...', 'deadline': '...', 'days_overdue': N}, ...],
    'this_week': [{'text': '...', 'deadline': '...'}, ...],
    'blocked': [{'text': '...', 'reason': '...'}, ...],
    'recently_done': [{'text': '...', 'done_date': '...'}, ...]    # 最近 7 天
}
```

#### 不做的事（保守）

- ❌ 不做 todo 与 KR 关键词重合检测（避免误判）
- ❌ 不修改 todos.md 文件（archive 由用户手动）
- ❌ 不把 todos 当作要务参与 MIT 选择

### Step 8：调用框架分析

将以上数据（含 metadata 派生指标 + todos）传入 `frameworks/{framework}.md` 指定的分析视角，生成结构化诊断。

## 输出结构

```
{
  "completed": ["KR描述", ...],
  "incomplete": [
    {
      "kr": "KR描述",
      "reason": "一句话原因",
      "blocker_type": "external | procrastination | wrong_target | unspecified",
      "deadline": "YYYY-MM-DD | null",
      "urgency": "overdue | this_week | next_two_weeks | comfortable | no_ddl | phantom",
      "days_to_deadline": <int | null>
    },
    ...
  ],
  "mit_completion_rate": 0.6,
  "structural_issues": ["项目漂移：作品集个站已持续3周未完成", ...],
  "unplanned_pattern": [
    {"item": "帮学弟 debug", "category": "Q3-杂事", "weeks_seen": 1}
  ],
  "urgency_distribution": {
    "Q1": 2,                  # P0/P1 + this_week/overdue
    "Q2": 5,                  # P0/P1 + comfortable/no_ddl
    "Q3": 1,                  # 无优先级 + this_week
    "Q4": 0
  },
  "deadline_alerts": [
    {"kr": "...", "deadline": "...", "urgency": "overdue", "progress": 0.3}
  ],
  "phantom_krs": ["O3_KR4 完成自己的 portfolio"],
  "todos_summary": {
    "open_count": 6,
    "overdue": [{"text": "续车保", "deadline": "2026-05-10", "days_overdue": 4}],
    "this_week": [{"text": "买羽毛球鞋", "deadline": "2026-05-15"}],
    "blocked": [{"text": "给老妈寄药", "reason": "等地址确认"}],
    "recently_done": [{"text": "交报税材料", "done_date": "2026-05-03"}]
  },
  "framework_diagnosis": "框架特定的诊断内容（见 frameworks/）",
  "user_context": "retro 和感受的摘要"
}
```
