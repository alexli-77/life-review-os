# Engine 05：扫描 Watch List

读取本地知识库中的 `99_Meta/watch-list.md`（如果配置了 vault），把当前到期需要 review 的事项抓出来供用户决策。
**仅在 `config.yaml` 中 `vault.enabled: true` 时执行**——这是可选步骤，没有 Obsidian / 知识库的人完全不需要。

## 何时执行

在标准流程的 **Step 3.5**（分析完成后、生成下周计划前）。

理由：
- 状态变化（watching → active）会影响下周计划
- 用户可能因为 review 决定"这件事进入下周要务" → 必须在生成计划前定下来
- 反过来，watching 的事如果决定推迟，也不应进入计划

## 配置读取

```yaml
# config.yaml
vault:
  enabled: true                                                       # 关闭则跳过本步骤
  path: /Users/xxx/Desktop/LeonKnowledgeBase/Private-Vault             # 知识库根
  watch_list: 99_Meta/watch-list.md                                    # 相对路径
```

## 执行步骤

1. **读取 watch-list 文件**

```bash
cat "{vault.path}/{vault.watch_list}"
```

2. **解析"Watching"和"Considering"两个章节**

watch-list 的标准结构（来自 `Leon-knowledgeBase-template/99_Meta/watch-list.md.template`）：

```markdown
## 🔭 Watching（等条件触发）

| 笔记 | 触发条件 | 下次 review | 优先级 |
|---|---|---|---|
| [[xxx]] | ... | YYYY-MM-DD | medium |

## 🤔 Considering（还在想要不要做）

| 笔记 | 关键决策点 | 下次 review | 优先级 |
|---|---|---|---|
```

3. **筛选到期项**

把 `下次 review <= 今天` 的行抓出来。今天的日期用系统时区（如 `America/Toronto`）。

4. **同时打开每个到期笔记**

对每个到期项，读取它对应的笔记文件（从 `[[link]]` 解析路径），提取 frontmatter（status / priority / trigger-condition）和正文摘要。

5. **在对话中呈现**

```markdown
## 🔭 Watch List 到期事项（{N} 项）

### 1. [opencut-ai-integration](70_Areas/claude-skills/opencut-ai-integration.md)
- **状态：** watching
- **触发条件：** OpenCut export 重构稳定 / desktop GPUI 可用
- **创建于：** 2026-05-02（已躺 {N} 天）
- **正文摘要：** {第一段或一句话}

**问你：** 这件事现在是
  - (a) 触发条件已满足 → 改 status: active，加入下周计划
  - (b) 还在等 → 推迟 next-review 到 {YYYY-MM-DD}
  - (c) 不再做了 → 改 status: abandoned

### 2. ...
```

逐项问用户，不批量。用户的每一个决策都立即落地：

- 选 (a) → 修改笔记 frontmatter（status → active）+ 把这件事并入下周计划候选项
- 选 (b) → 修改笔记 frontmatter（next-review 延后）
- 选 (c) → 修改笔记 frontmatter（status → abandoned），同步移到 watch-list 的 ❌ Abandoned 栏目

6. **更新 watch-list.md**

所有决策落地后，把 watch-list.md 里的对应行同步到正确栏目（Watching → Active / Abandoned 等）。

## 错误处理

- vault.path 不存在 → 报错并跳过本步骤，但继续后面的流程
- watch-list.md 不存在 → 提示用户"未找到 watch-list.md，是否要创建？"，跳过决策
- 无到期项 → 输出"✅ 没有到期需要 review 的事项"，跳过决策环节

## 与下周计划的衔接

被改成 `status: active` 的事项，作为**候选要务**传给 `engine/03-plan.md`。最终是否进入下周计划，仍由计划生成逻辑决定（受 OKR 优先级、本周精力、MIT 唯一性约束）。
