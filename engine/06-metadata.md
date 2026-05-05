# Engine 06 — OKR Metadata（结构化补全）

为 KR 增补"飞书文档里写不下"的结构化信息（deadline、effort、phantom 状态等），让分析有数据依据，而不是仅从字面推断。

> **仅在 `vault.enabled = true` 时执行**。vault 关闭则跳过本步骤。

## 设计原则

1. **零标记**：用户在飞书 KR 描述里**不需要**写任何额外标签
2. **对话补全**：缺失信息通过 weekly review 时的对话逐步问出来
3. **本地持久化**：信息存在 `{vault.path}/{vault.okr_metadata}`（默认 `99_Meta/okr-metadata.yaml`），用户能看、能改、能 git 管理
4. **优雅降级**：metadata 文件不存在 = 退回纯文本启发式分析（即原有行为）

## 何时执行

在标准流程中作为 **Step 2.5**（读完飞书文档后、正式分析前）。

理由：
- 分析需要 metadata（deadline → Q1/Q2 分类）
- 计划生成需要 metadata（DDL-aware MIT 选择）
- 这两步都在分析之后，所以 metadata 必须先准备好

## 执行流程

```
Step 2.5.1：检测 metadata 文件
  → 存在  → 加载
  → 缺失 → 询问用户是否创建（y / n / skip）
            创建后写入空 schema（带注释）
            → 进入 2.5.2

Step 2.5.2：自然语言抽取
  → 对每个 P0/P1 KR 描述运行 deadline regex
  → 命中：暂存为 candidate（待用户确认）
  → 未命中：标记为 needs_dialog

Step 2.5.3：候选确认
  → 把 candidates 一次性列给用户：
    "我从描述里读出以下 deadline，对吗？
       O1.KR1（完成博士研究方向提案）→ 6.15
       O3.KR1（强制令产品化）→ 周三前 = 5.7（本周）
     回 y 全部接受 / 给出修正"
  → 用户确认后写入 metadata 文件

Step 2.5.4：缺失项对话
  → 对 needs_dialog 项逐个询问：
    "O1.KR2（AI Agent 调研）这次没看到 deadline。它有截止日吗？
       (a) YYYY-MM-DD
       (b) 长期方向，没截止 → 标记为 phantom
       (c) 暂跳过，下次再问"
  → 用户回答后立即写入 metadata
  → 第一次跑会问几次；第二次起只问新增 KR

Step 2.5.5：状态同步
  → 把当前飞书 OKR 段中已不存在的 KR 标记为 archived
  → 不删除，保留历史（git diff 可见）
```

## Metadata 文件格式

路径：`{vault.path}/{vault.okr_metadata}`，默认 `99_Meta/okr-metadata.yaml`。

```yaml
# OKR Metadata
# 自动维护 + 用户可手动修改
# skill 写的字段：noted_on, source, kr_text_snapshot
# 用户可改任何字段，下次 review 会尊重

schema_version: 1

2026-Q2:
  🐶:                              # user.symbol from config
    O1_KR1:                        # 见下方 KR ID 规则
      kr_text_snapshot: "完成博士的研究方向提案，并与导师汇报实验结果"
      priority: P0                 # 从飞书 OKR 段抽取
      deadline: 2026-06-15
      effort: L                    # S/M/L，可选
      status: active               # active | phantom | parked | archived
      noted_on: 2026-05-04
      source: dialog               # dialog | auto_extracted | manual

    O1_KR2:
      kr_text_snapshot: "整理 AI Agent 领域的基本概念..."
      priority: P0
      deadline: 2026-06-30
      status: active
      noted_on: 2026-05-04
      source: dialog

    O3_KR4:
      kr_text_snapshot: "完成自己的 portfolio"
      priority: P0
      deadline: null
      status: phantom              # 用户说"长期方向，没截止"
      noted_on: 2026-05-04
      source: dialog

# 用户手动覆盖区（skill 不会改这块）
manual_overrides:
  - kr: O3_KR4
    note: "明确长期方向，下季度再决定是否启动"
    until: 2026-07-01
```

## KR ID 规则

格式：`O<objective_idx>_KR<kr_idx>`，例如 `O1_KR1` = Objective 1 的 KR1。

- **objective_idx**：从飞书 OKR 段中按顺序编号（O1, O2, O3...）
- **kr_idx**：每个 Objective 内 KR 的顺序编号（KR1, KR2...）

> 这个 ID 在一个 quarter 内稳定。如果用户在飞书里调整 OKR 顺序，下一季会失配——届时 skill 用 `kr_text_snapshot` 做 fuzzy match 重新分配 ID（提示用户确认）。

## Deadline 自然语言抽取规则

正则模式（按优先级匹配）：

| 模式 | 示例 | 抽取规则 |
|---|---|---|
| `\d{4}-\d{2}-\d{2}` | `2026-06-15` | 直接采用 |
| `(\d{1,2})月(\d{1,2})日` | `6月15日` | 当年 + 月 + 日 |
| `(\d{1,2})\.(\d{1,2})前` | `4.30前` | 当年 + 月 + 日（前一日为 deadline） |
| `周(一二三四五六日)前` | `周四前` | 当周对应日期 |
| `(本周末\|下周\|月底\|季度末)` | — | 计算最近的对应日期 |

未命中任何模式 → 标记为 `needs_dialog`。

## 与分析 / 计划的衔接

### `engine/02-analyze.md` 消费 metadata

- 计算每个 KR 的 `days_to_deadline`
- 输出新增字段 `urgency_distribution`（Q1/Q2/Q3/Q4 计数）
- 标记 `phantom_krs`：metadata 中 status=phantom 且本周期无进展

### `engine/03-plan.md` 消费 metadata

- MIT 候选优先级：`P0 + days_to_deadline ≤ 14d + 进度 < 50%` → 强候选
- 自动建议：`status=phantom` 的 KR 不进入下周要务，除非用户显式启用

### `frameworks/stephen-covey.md` 消费 metadata

- Q1 = (P0 OR P1) AND days_to_deadline ≤ 7
- Q2 = (P0 OR P1) AND (days_to_deadline > 7 OR no deadline)
- 这比基于关键词的启发式判定精确得多

## 错误处理

| 情况 | 处理 |
|---|---|
| metadata 文件存在但格式损坏 | 备份为 `.bak`，提示用户，本次跑使用空 metadata |
| KR 在飞书里改了描述但 metadata 还是旧的 | 用 `kr_text_snapshot` 比对，差异 >30% 时提示用户 |
| 用户在 dialog 阶段回 "skip" | 不写文件，下次还会问 |
| 跨年份运行（如年初的 quarterly review） | 保留所有历史 quarter 数据，仅新增本季节点 |

## 隐私与安全

- metadata 文件存用户本地 vault，**不通过任何网络传输**
- skill 不调用 git 命令，不自动 commit / push
- 文件包含 KR 描述快照——如果用户的 OKR 内容敏感，**他们的 vault 是不是 git/是否公开是他们自己的事**
- skill 写入前会创建 `.bak` 备份（可在 config 里关闭）

## 配置

```yaml
vault:
  enabled: true
  path: /absolute/path/to/your/vault
  watch_list: 99_Meta/watch-list.md
  okr_metadata: 99_Meta/okr-metadata.yaml   # 新增
  metadata_backup: true                      # 写入前备份 .bak，默认 true
```
