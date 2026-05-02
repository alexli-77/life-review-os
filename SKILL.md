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

```
retro: [本周完成了什么，卡在哪里，一两句话即可]
感受: [情绪/精力/外部状态，一句话即可]
```

示例：
```
retro: 完成了主项目日常工作，副项目还差最后一步没推进
感受: 情绪有点低落，但运动状态很好，外部压力大
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
