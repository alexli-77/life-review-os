# Life Review OS

> 一个把"周计划 / 双周复盘 / 季末方向校准"做成自动化流程的 Claude Skill。
> 读取你的飞书 Weekly 文档，对比计划与执行，生成下周计划，自动写回。

![License](https://img.shields.io/badge/license-MIT-blue)
![Skill](https://img.shields.io/badge/claude-skill-orange)
![Lark](https://img.shields.io/badge/integration-feishu/lark-green)

---

## 这是什么？

Life Review OS 是为 **已经在飞书上做 OKR + 周计划** 的人设计的 Claude Skill。

它解决一个具体的痛点：**计划做了，但很少回头看；执行偏了，自己感觉不到。**

每周（或每两周、每季末）触发一次 skill，它会：

1. 读你的 OKR 定义和最近 N 周的执行表格
2. 对比计划 vs 实际，识别完成 / 未完成 / 偏移
3. 结合你口头给出的 retro 和当周感受
4. 生成下周计划（含 MIT），写回飞书表格

底层分析框架可选：
- `stephen-covey` — Q1/Q2/Q3/Q4 + P/PC 平衡 + 使命对齐
- `okr-pure` — 纯 KR 完成率 + 偏移检测

---

## 快速开始

### 前置条件

- [Claude Code](https://claude.com/claude-code) CLI 已安装
- [lark-cli](https://github.com/larksuite/lark-openapi-cli) 已安装并完成 `lark-cli auth login`
- 一份在飞书上的 Weekly 文档（含 OKR 段落和按周分列的执行表格）

### 安装

```bash
# 1. 克隆到 Claude skills 目录
git clone https://github.com/alexli-77/life-review-os.git \
  ~/.claude/skills/weekly-review

# 2. 复制配置模板并填入你的飞书 token
cd ~/.claude/skills/weekly-review
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

### 配置 `config.yaml`

```yaml
user:
  name: 你的名字
  symbol: 🐧                # 飞书文档中标识你的 emoji
  timezone: America/Toronto

framework: stephen-covey    # 或 okr-pure

documents:
  mission_statement: YOUR_MISSION_DOC_TOKEN
  five_year_plan: YOUR_FIVE_YEAR_PLAN_TOKEN
  weekly:
    - year: 2026
      token: YOUR_2026_WEEKLY_TOKEN
      table_block_id: YOUR_2026_TABLE_BLOCK_ID
    - year: 2025
      token: YOUR_2025_WEEKLY_TOKEN

modes:
  weekly:
    lookback_weeks: 2
    auto_write: true
  biweekly:
    lookback_weeks: 4
    auto_write: true
  quarterly:
    auto_write: false       # 季末报告先确认再写回
```

> 飞书文档 token 在文档 URL 中：`https://xxx.feishu.cn/docx/[TOKEN]`
>
> 表格 `block_id` 通过 `lark-cli api GET /open-apis/docx/v1/documents/{token}/blocks` 找出。

---

## 使用

在 Claude Code 中：

```
/weekly-review              # 周模式（默认）
/weekly-review weekly       # 同上
/weekly-review biweekly     # 双周复盘 + 趋势分析
/weekly-review quarterly    # 季末深度复盘 + 使命对齐
```

也可以用自然语言触发："帮我做 weekly review" / "做双周复盘"。

### 触发后的标准流程

```
Step 1: skill 询问你的 retro 和本周感受
Step 2: 读取 OKR 段落 + 最近 N 周执行表
Step 3: 对比分析（完成 / 未完成 / 偏移）
Step 4: 生成下周计划（MIT + 6-8 条要务）
Step 5: 在对话中输出分析摘要
Step 6: 自动写回飞书表格新列（quarterly 模式需手动确认）
```

### 输入示例

```
retro: 完成了主项目日常工作，副项目还差最后一步没推进
感受: 情绪有点低落，但运动状态很好，外部压力大
```

---

## 三种模式对比

| | weekly | biweekly | quarterly |
|---|---|---|---|
| 频率 | 每周 | 每两周 | 每季末 |
| 读取范围 | 最近 2 周 | 最近 4 周 | 全季度 + 使命宣言 + 5 年计划 |
| 额外输出 | — | KR 趋势表 + MIT 完成率 | 使命对齐 + 长期停滞 + 方向校准 |
| 自动写回 | ✅ | ✅ | ❌（需确认） |
| 时长 | < 2 分钟 | < 5 分钟 | 15-30 分钟 |

---

## 文件结构

```
life-review-os/
├── SKILL.md                # Claude skill 入口
├── config.example.yaml     # 配置模板（复制为 config.yaml）
├── engine/                 # 通用执行引擎
│   ├── 01-read.md          # 读取飞书文档
│   ├── 02-analyze.md       # 分析逻辑
│   ├── 03-plan.md          # 生成下周计划
│   └── 04-write.md         # 写回飞书
├── frameworks/             # 分析框架（可扩展）
│   ├── stephen-covey.md
│   └── okr-pure.md
└── modes/                  # 三种模式的具体规则
    ├── weekly.md
    ├── biweekly.md
    └── quarterly.md
```

**两层架构：** `engine/` `frameworks/` `modes/` 是通用的，所有用户共用；
`config.yaml` 是个人的，被 `.gitignore`，不会进仓库。
迁移到其他人只需改 `config.yaml`。

---

## 扩展

### 新增分析框架

在 `frameworks/` 下加一个 `.md` 文件，按现有文件的结构定义：
- 输入：OKR + 最近 N 周执行数据
- 输出：诊断摘要

然后在 `config.yaml` 把 `framework` 改成新文件名（不含 `.md`）。

### 替换数据源

当前实现绑定飞书。如果你用 Notion / Obsidian / Google Docs，
改写 `engine/01-read.md` 和 `engine/04-write.md` 即可，其他文件无需改动。

---

## 限制

- ❌ 不支持定时触发——需要你手动执行（或自己用 launchd / cron 包一层）
- ❌ 写回操作以你的飞书用户身份执行，不会代表"组织"
- ⚠️ 飞书文档结构需要符合预期：OKR 段落 + 按周分列的表格

---

## License

MIT — 自由使用、修改、分发。
