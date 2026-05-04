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
6. `engine/05-watch-list.md` — 扫描本地知识库 watch-list（仅 vault.enabled=true 时执行）
7. `frameworks/{framework}.md` — 对应的分析框架（从 config.yaml 读取 framework 字段）
8. `modes/{mode}.md` — 对应模式的具体行为规则

## 标准执行流程

```
Step 0: 读取 config.yaml
        → 确定 user.symbol、documents、framework、modes.{mode}
        ↓
Step 1: 询问用户输入（如未在触发时提供）
        → 本周 retro（完成了什么、卡在哪里）
        → 本周感受（情绪、精力、外部压力）
        ↓
Step 2: 读取飞书文档（按 engine/01-read.md）
        → 根据 mode 决定读取范围（lookback_weeks）
        → weekly/biweekly：当前 OKR + 最近 N 周执行表格
        → quarterly：使命宣言 + 五年计划 + 当年全量 OKR + 执行
        ↓
Step 3: 分析（按 engine/02-analyze.md + frameworks/{framework}.md）
        → 对比计划 vs 执行
        → 识别完成项 / 未完成项 / 偏移点
        → 结合用户 retro 和感受校正结论
        ↓
Step 3.5: 扫描 Watch List（按 engine/05-watch-list.md）
        → 仅当 vault.enabled = true 时执行
        → 读取 99_Meta/watch-list.md
        → 抓出 next-review <= 今天 的事项
        → 逐项问用户：触发 / 推迟 / 放弃
        → 决策落地：修改笔记 frontmatter + watch-list 栏目
        → 被激活（status → active）的事项作为下周计划候选
        ↓
Step 4: 生成下周计划（按 engine/03-plan.md）
        → 每个 OKR 下的具体要务
        → 标注 MIT（最多 1 个真正的 MIT）
        → 优先级排序
        ↓
Step 5: 输出分析摘要（在对话中展示）
        ↓
Step 6: 写回飞书（按 engine/04-write.md）
        → 仅当 modes.{mode}.auto_write = true 时执行
        → quarterly 模式默认先在对话中确认，再写回
```

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
