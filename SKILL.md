---
name: weekly-review
description: >
  Life Review OS：对比计划与执行、生成下周计划并写回飞书。
  当用户说"帮我做 weekly review"、"做双周复盘"、"做季末复盘"、
  "/weekly-review"、"检查我的计划和执行是否一致"时触发。
  支持三种模式：weekly（默认）/ biweekly / quarterly。
license: MIT
metadata:
  author: life-review-skill
  version: 1.0.0
keywords:
  - weekly-review
  - life-review
  - okr
  - planning
  - stephen-covey
  - feishu
  - lark
  - 周计划
  - 复盘
  - 执行对齐
---

# Life Review OS — SKILL 入口

## 触发方式

```
/weekly-review              # 周模式（默认）
/weekly-review weekly       # 周模式（显式）
/weekly-review biweekly     # 双周复盘
/weekly-review quarterly    # 季末深度复盘
```

## 执行前必读

每次执行前，**按顺序**读取以下文件：

1. `config.yaml` — 获取用户信息、飞书 token、框架选择、模式规则、vault 配置
2. `engine/01-read.md` — 读取飞书文档的方法
3. `engine/02-analyze.md` — 分析逻辑
4. `engine/03-plan.md` — 生成下周计划
5. `engine/04-write.md` — 写回飞书（仅 auto_write=true 时执行）
6. `engine/05-watch-list.md` — 扫描知识库 watch-list（仅 vault.enabled=true 时执行；支持本地/API fallback）
7. `engine/06-metadata.md` — OKR metadata 补全与读取（仅 vault.enabled=true 时执行）
8. `engine/07-todos.md` — Todos 文件读取（仅 vault.enabled=true 且 vault.todos 已配置时）
9. `frameworks/{framework}.md` — 对应的分析框架（从 config.yaml 读取 framework 字段）
10. `modes/{mode}.md` — 对应模式的具体行为规则

## 🐶 Feishu Weekly 硬约束

weekly / biweekly 模式必须以 Feishu Weekly 文档中的 **`🐶` 专属数据** 为唯一权威来源：

1. **OKR 来源**：只读取当前 Weekly 文档中 `documents.weekly[].okr_heading`
   指向的章节，默认标题为 `🐶 重点OKR`。下周 KR / 要务必须从该章节中的 KR 推导。
2. **执行来源**：只读取 `documents.weekly[].table_block_id` 指向的 `🐶`
   每周要务表格。review 必须基于最近 N 周的 `{日期范围} 要务` 和
   `{日期范围} retro` 列，不得用对话输入或 vault/todos 替代 Feishu 表格内容。
3. **表格校验**：读取和写回前，必须确认目标表格或其邻近标题/首列包含
   `documents.weekly[].table_marker`（默认 `🐶`）。无法确认时停止执行，并提示用户更新
   `table_block_id` 或文档结构。
4. **辅助数据边界**：用户当次 retro、vault watch-list、metadata、todos 只能用于解释、
   调整强度或补充候选；不能覆盖 Feishu 表格里的每周要务，也不能生成脱离
   `🐶 重点OKR` 的 KR。
5. **写回目标**：下周 KR / 要务只能写回同一个 `🐶` 表格的新一周 `{日期范围} 要务`
   列；不得写到其他用户或其他 emoji 的表格。
6. **写回行定位**：每条写回要务必须严格对应 `🐶` 表格第一列 `🐶 重点OKR`
   的某一行，并写入同一行的新周要务单元格。无法确定对应行时必须停止写回并请用户确认，
   禁止把未匹配内容默认写入第一行或任意兜底行。
7. **写回颗粒度**：每条写回要务必须是一个独立的小标题/有序列表项。同一 OKR 行有多件事时，
   写为同一单元格内的多条有序列表，不得用 `/` 把多个任务串成一条，也不得在句尾保留 `/`。
   MIT 样式沿用历史表格：任务标题后追加红色 `MIT` 和 `✅`。
8. **任务量预算**：weekly / biweekly 模式必须读取 `planning` 配置。默认 normal 强度为
   6-10 条下周要务、最多 1 个 MIT、尽量覆盖至少 4 个 OKR 行。任务量预算只用于内部规划和
   写回候选，不得在最终用户卡片中展示。
9. **Daily OS 补充上下文**：如果由 Daily OS 触发，Linear、todo inbox、vault daily、
   recent daily memory 只能用于补充候选和校准任务量；所有写回项仍必须映射到 `🐶` 表格第一列
   的某个 OKR 行。最终输出不要展示来源、证据名、row_index 或内部推理。
10. **retro review 写回**：weekly / biweekly 模式可以在目标周 `{日期范围} 要务`
    相邻的 `retro` 单元格底部写入 `review` 小节。review 必须优先参考同一 retro 单元格中
    已有的 `状态`、`做得好/做的好`、`待改进` 内容，再参考相邻要务完成状态和 Daily OS
    补充上下文。review 控制在 350 个中文字符以内，只写复盘结论，不写来源说明或内部推理。
    文本固定为两段：第一段是肯定的总结，第二段是待改进的总结。
    若目标周是双周表头（如 `6.29-7.12 要务`）且覆盖当前周，也视为合法目标周。

如果以上任一项无法满足，本次 review 必须进入 blocked 状态：说明缺失的信息、
已经读到的内容、需要用户补齐的配置或 Feishu 文档结构。

## 标准执行流程

```
Step 0: 读取 config.yaml
        → 确定 user.symbol、documents、framework、modes.{mode}
        → 对 weekly 文档读取 okr_heading / table_block_id / table_marker
        ↓
Step 0.5: Vault 检测（仅 vault.enabled=true 时）
        → vault.source=local/auto 且 vault.path 存在 → 继续本地读取
        → vault.source=api 或本地缺失且 vault.source=auto → 按 vault.api 尝试 API fallback
        → 本地/API 都不可用 → 显示 onboarding 菜单（见下）或本次跳过 vault
        → 用户选 (a)/(b)/(c)/skip 后继续
        ↓
Step 1: 询问用户输入（如未在触发时提供）
        → 本周 retro（完成了什么、卡在哪里）
        → 本周感受（情绪、精力、外部压力）
        ↓
Step 2: 读取飞书文档（按 engine/01-read.md）
        → 根据 mode 决定读取范围（lookback_weeks）
        → weekly/biweekly：🐶 重点OKR + 🐶 表格最近 N 周要务/retro
        → quarterly：使命宣言 + 五年计划 + 当年全量 OKR + 执行
        ↓
Step 2.5: OKR Metadata 补全（按 engine/06-metadata.md，仅 vault.enabled=true 时）
        → 加载 {vault.path}/{vault.okr_metadata}（缺失则询问是否创建）
        → 对每个 P0/P1 KR 自然语言抽取 deadline，命中则候选
        → 候选给用户一次性确认；缺失项逐个对话补全
        → 写入 metadata 文件
        ↓
Step 2.7: Todos 读取（按 engine/07-todos.md，仅 vault.enabled=true 且 vault.todos 已配置时）
        → 加载 {vault.path}/{vault.todos}（缺失则询问是否创建空模板）
        → 解析 Open / Done / Parked 三段 + 标签
        → 派生 urgency（overdue / this_week / next_two_weeks / no_ddl / blocked / parked）
        → 文件全程只读，skill 不修改
        ↓
Step 3: 分析（按 engine/02-analyze.md + frameworks/{framework}.md）
        → 对比 🐶 重点OKR vs 🐶 表格每周要务执行
        → 识别完成项 / 未完成项 / 偏移点
        → 结合用户 retro、感受、metadata（deadline / status）校正结论
        ↓
Step 3.5: 扫描 Watch List（按 engine/05-watch-list.md，仅 vault.enabled=true 时）
        → 从本地或 API 读取 99_Meta/watch-list.md
        → 抓出 next-review <= 今天 的事项
        → 逐项问用户：触发 / 推迟 / 放弃
        → 决策落地：修改笔记 frontmatter + watch-list 栏目
        → 被激活（status → active）的事项作为下周计划候选
        ↓
Step 4: 生成下周计划（按 engine/03-plan.md）
        → 只根据 🐶 重点OKR 生成每个 KR 下的具体要务（DDL-aware MIT 选择）
        → 标注 MIT（最多 1 个真正的 MIT）
        → 优先级排序
        ↓
Step 5: 输出分析摘要（在对话中展示）
        ↓
Step 6: 写回飞书（按 engine/04-write.md）
        → 仅当 modes.{mode}.auto_write = true 时执行
        → 写回同一个 🐶 表格的新一周要务列
        → quarterly 模式默认先在对话中确认，再写回
```

## Vault Onboarding 菜单（Step 0.5）

当 `vault.enabled: true` 但 `vault.path` 不存在时显示：

```
⚠️ vault.path 配置为 "/xxx" 但该路径不存在。

vault 是可选功能，提供 watch-list 扫描 + OKR metadata 持久化。
任何 markdown 笔记目录都可以作为 vault（Obsidian / Logseq / 纯 md 都行）。

选项：

  (a) 关闭 vault 功能
      把 config.yaml 的 vault.enabled 改为 false。
      OKR 复盘核心功能完全不受影响。

  (b) 指向已有的笔记目录
      把 vault.path 改成你已有的 markdown 笔记目录。
      skill 会在该目录的 99_Meta/ 下创建需要的文件（创建前会问你）。

  (c) 用现成的知识库模板初始化
      推荐：https://github.com/alexli-77/Leon-knowledgeBase-template
      Obsidian PARA 结构 + Claude Code /record skill 一键部署，
      包含本 skill 需要的 watch-list 结构。

      git clone https://github.com/alexli-77/Leon-knowledgeBase-template
      cd Leon-knowledgeBase-template && ./setup.sh ~/ObsidianVault
      然后把 config.yaml 的 vault.path 指向 ~/ObsidianVault/Private-Vault

要用哪个？(a/b/c/skip)
```

`skip` = 这次跳过 vault 功能，下次再决定，config 不动。

## 用户输入格式（每次触发时提供）

### 标准格式（推荐）

```
做得好:
- [完成项 / 个人感觉不错的事]

有待提高:
- [事项] —— 卡在哪（外部阻塞 / 自己拖延 / 目标定错）

状态: [情绪/精力/外部压力，一句话]
（可选）计划外: [本周吃掉时间但不在计划里的事]
```

> **为什么要"卡在哪"分类**：不同卡点对应不同处方——"外部阻塞"不归因执行力；"自己拖延"检查长期模式；"目标定错"提示调整 KR。没分类只能瞎猜。
>
> **为什么要"计划外"**：救火多 = 第一象限过载；杂事多 = 第三象限漏到生活里。这是柯维四象限诊断的关键素材。

### 最低可用（赶时间时）

```
做得好: [一两个最关键的产出]
有待提高: [一个最大的卡点] —— 卡在哪
状态: [一句话]
```

### 示例

```
做得好:
- 主项目周报按时交付，导师反馈正面
- 跑了 3 次步，状态恢复

有待提高:
- 副项目 baseline 实验还差最后一步 —— 自己拖延，每天划水到深夜
- 论文 related work 没动 —— 外部阻塞，等导师那篇 preprint

状态: 情绪一般偏低，精力还行，签证压力大
计划外: 帮 lab 学弟 debug 了一下午
```

## 输出格式

### 周模式输出
```
## 📊 本周执行对比（{日期范围}）

**完成** ✅
- ...

**未完成** ⭕️
- ...（原因分析一句话）

**下周计划**
- MIT 🔴：...
- KR1：...
- KR2：...
...

> 已写入飞书：{文档链接}
```

### 双周/季末模式
在周模式输出基础上，增加「趋势分析」或「方向诊断」章节，
详见 `modes/biweekly.md` 和 `modes/quarterly.md`。

## 依赖技能

本 skill 依赖以下工具读写飞书：
- `lark-cli docs +fetch` — 读取 docx 文档
- `lark-cli api GET /open-apis/doc/v2/{token}/content` — 读取旧版 legacy doc
- `lark-cli api POST/PATCH /open-apis/docx/v1/...` — 写入表格单元格

认证方式：`--as user`（所有操作均以用户身份执行）
