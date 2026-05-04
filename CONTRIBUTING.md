# Contributing to Life Review OS

感谢你对这个项目感兴趣。

> ⚠️ **先说清楚预期**
>
> 这是一个**个人项目**，由一个 maintainer（[@alexli-77](https://github.com/alexli-77)）业余维护。
> PR 和 issue 我会看，但**响应可能很慢**（通常 1-2 周内回复，遇到论文 deadline 可能更久）。
> 如果你的改动有时效性需求，建议先开 issue 讨论，或者直接 fork 走自己的版本。

---

## 欢迎什么样的贡献

✅ **明确欢迎**
- Bug 修复（飞书 API 调用失败、文档解析错误、配置加载边界 case 等）
- 文档改进（README、SKILL.md、engine/*.md 中的表述、示例、错别字）
- 新增分析框架（在 `frameworks/` 下加文件，不影响现有逻辑）
- 新增数据源适配（替换飞书为 Notion / Obsidian / Google Docs，**作为可选 backend**）
- 测试用例 / 示例配置

🤔 **建议先开 issue 讨论**
- 新增模式（除了 weekly / biweekly / quarterly）
- 修改 engine/ 下的核心分析逻辑
- 改动输出 JSON schema（`engine/02-analyze.md` 的输出结构）
- 改动用户输入格式（SKILL.md 中的"用户输入格式"段）
- 任何引入新依赖的改动

❌ **不接受**
- 仅为风格偏好的大规模重构（"我喜欢这样写"不是合理动机）
- 删除现有功能（除非有明确技术理由）
- 把项目"通用化"到失去原有定位（这是一个"飞书 + OKR + 柯维"工作流的 skill，不是通用 review 工具）

---

## 提交流程

### 1. 先开 issue（推荐）

除非是 typo 或一目了然的 bug 修复，先开 issue 描述你想做什么。
这样可以避免你写了一大堆代码后我说"这个方向不对"。

### 2. Fork + 本地开发

```bash
# Fork 后克隆你自己的 fork
git clone git@github.com:你的用户名/life-review-os.git
cd life-review-os

# 添加 upstream 指向原仓库
git remote add upstream git@github.com:alexli-77/life-review-os.git

# 从最新 main 拉 feature 分支
git fetch upstream
git checkout -b feature/简短描述 upstream/main
```

分支命名建议：
- `feature/xxx` — 新功能
- `fix/xxx` — bug 修复
- `docs/xxx` — 文档改动
- `framework/xxx` — 新增分析框架

### 3. 本地验证

提 PR 前请至少跑一次完整的 weekly 模式，确认：
- [ ] config.yaml 加载正常
- [ ] 飞书文档读取没报错
- [ ] 分析输出结构符合 `engine/02-analyze.md` 描述
- [ ] 写回飞书的内容格式正确（如果改动了 04-write.md）

如果你的改动不涉及飞书交互（比如只改文档），说明清楚即可。

### 4. Commit message 风格

参考已有 commit：

```
Refine retro input format with blocker classification and unplanned items

- SKILL.md: 用户输入格式从 retro/感受 两栏扩展为 ...
- engine/02-analyze.md: Step 5 拆分为 5.1 / 5.2 / 5.3 ...

动机：原格式信息密度太低 ...
```

约定：
- 标题用英文（祈使句，<= 70 字符）
- 正文中文 / 英文均可，分点列出具体改动 + 一段动机
- 一个 commit 做一件事，避免无关改动混在一起
- **不要在 commit message 里加 `Co-Authored-By` 你没真合作过的人**

### 5. 提 PR

在你的 fork 页面点 "Compare & pull request"，按 [PR template](.github/PULL_REQUEST_TEMPLATE.md) 填写。

PR title 建议直接用主 commit message 的标题。

### 6. Review 流程

我会：
- 在 1-2 周内给第一次反馈（如果超时请直接 @ 我）
- 提具体修改意见，不会要求"完全推倒重来"——除非方向真的偏了
- 合并方式默认 **squash merge**，所以你 PR 中间的 commit 不需要太精致，但**最后一个 commit 的 message 要规范**（squash 后会用它）

---

## 代码 / 内容风格

这个项目主要是 markdown，没有传统意义上的"代码"。但 skill 内容也有风格：

### Skill markdown 风格

- **指令性优于描述性**：写"读取 X，提取 Y"而不是"这一步会读取 X 来提取 Y"
- **结构化优于段落**：能用表格 / 列表的不要用大段文字
- **示例要具体**：不要写"例如某个 OKR"，要写真实的 KR 描述（可以脱敏）
- **避免 emoji 堆叠**：每段最多一个，作为视觉锚点而不是装饰

### 不要做的事

- ❌ 把中文改成英文（除非是技术专有名词）—— 这个 skill 的目标用户是中文使用者
- ❌ 把"飞书"改成"Feishu/Lark"全局替换 —— 中文语境就用"飞书"
- ❌ 在 markdown 里加大量 HTML —— 保持纯 markdown 兼容性
- ❌ 把 `config.yaml`（含真实 token）误推到仓库 —— 检查 `.gitignore`

---

## 报告 Bug

开 issue 时请包含：

1. **触发命令**（`/weekly-review` 还是自然语言？哪种模式？）
2. **config.yaml 关键字段**（脱敏后的 framework / modes 配置，**不要贴 token**）
3. **报错信息或异常输出**
4. **预期行为 vs 实际行为**
5. （可选）你的飞书文档结构示意（脱敏截图或文字描述）

---

## 关于敏感信息

- **永远不要 commit `config.yaml`**（已在 `.gitignore` 中）
- 不要在 issue / PR 中贴你的飞书 token、文档 token、`block_id`
- 不要贴可识别个人的 OKR 内容
- 示例和测试数据请用脱敏版本（参考 `config.example.yaml`）

---

## 联系

- 一般问题：开 [GitHub issue](https://github.com/alexli-77/life-review-os/issues)
- 安全问题（如发现 token 泄漏路径或敏感信息处理 bug）：使用 GitHub 的 [Private Vulnerability Reporting](https://github.com/alexli-77/life-review-os/security/advisories/new)，**不要开公开 issue**

---

## License

提交 PR 即表示你同意你的贡献以 [MIT License](LICENSE) 发布。
