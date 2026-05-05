# OKR Metadata Conventions

为 life-review-os 的"结构化分析"功能提供数据。**完全可选**——不启用也能完成核心 OKR 复盘。

## 给谁看这份文档

- 想了解 metadata 文件每个字段含义的用户
- 想直接编辑 `okr-metadata.yaml`（而不是通过对话补全）的用户
- 想给 life-review-os 提 PR、修改 metadata schema 的贡献者

如果你只是想用，不用读这份——skill 会通过对话引导你完成所有补全。

## 文件位置

```
{vault.path}/{vault.okr_metadata}
```

默认 `99_Meta/okr-metadata.yaml`。可以在 `config.yaml` 改。

## 顶层结构

```yaml
schema_version: 1               # 当前唯一版本

<year>-<quarter>:               # 例如 "2026-Q2"，按季度切分
  <user_symbol>:                # 来自 config.user.symbol，比如 🐶
    <KR_ID>:                    # 见下方"KR ID 规则"
      <fields>...

manual_overrides:               # 用户手动维护，skill 不动
  - kr: <KR_ID>
    note: "..."
    until: YYYY-MM-DD
```

## KR ID 规则

格式：`O<n>_KR<m>`

- `n` = Objective 在飞书 OKR 段中的顺序号（从 1 开始）
- `m` = Objective 内 KR 的顺序号（从 1 开始）

例：`O1_KR1` = Objective 1 的 KR1；`O3_KR4` = Objective 3 的 KR4。

> 同一季度内 ID 稳定。换季 / 用户调整 OKR 顺序时，skill 用 `kr_text_snapshot` 做 fuzzy match 重新分配 ID（差异较大时会问用户）。

## KR 字段

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `kr_text_snapshot` | string | yes | KR 描述快照（用于 ID 复用 / 漂移检测） |
| `priority` | `P0` \| `P1` \| `P1.5` \| null | yes | 从飞书 OKR 段抽取的优先级 |
| `deadline` | `YYYY-MM-DD` \| null | no | 截止日期；null 表示无截止或长期方向 |
| `effort` | `S` \| `M` \| `L` \| null | no | 估计投入，S=小时级 / M=天级 / L=周级 |
| `status` | `active` \| `phantom` \| `parked` \| `done` \| `archived` | yes | 当前状态（见下） |
| `noted_on` | `YYYY-MM-DD` | yes | 该字段最后写入时间（skill 自动维护） |
| `source` | `dialog` \| `auto_extracted` \| `manual` | yes | 信息来源（用于追溯） |

### `status` 取值含义

| 值 | 含义 | 影响 |
|---|---|---|
| `active` | 正常推进中 | 进入下周要务候选 |
| `phantom` | 列在 OKR 但实际无意启动 | 不进入要务建议；周期性提示"是否降级" |
| `parked` | 用户主动延后到指定日期 | 在 `until` 日期之前不出现在要务建议中 |
| `done` | 已完成 | 仅作历史保留 |
| `archived` | 飞书 OKR 段已不存在该 KR | skill 自动标记，不删除（保留 git 历史） |

### `source` 取值含义

| 值 | 含义 |
|---|---|
| `dialog` | 用户在 weekly review 对话中回答的 |
| `auto_extracted` | skill 从 KR 描述里用正则抽出的 |
| `manual` | 用户直接编辑 yaml 写的 |

## `manual_overrides` 区

skill 不会修改这块。用户可以写：

```yaml
manual_overrides:
  - kr: O3_KR4
    note: "明确长期方向，下季度再决定是否启动"
    until: 2026-07-01
  - kr: O1_KR2
    note: "等导师 5 月底回邮件，确认范围"
```

`until` 字段在 `parked` 状态下生效——到了指定日期 skill 会重新提示。

## Deadline 自然语言抽取

skill 第一次读到没有 metadata 的 KR 时，会先尝试从飞书描述里**自动抽取** deadline，再在对话里向用户**确认**。

支持的模式：

| 输入 | 抽取结果 |
|---|---|
| `2026-06-15` | `2026-06-15` |
| `6月15日` | `2026-06-15`（当年） |
| `4.30前` | `2026-04-30` |
| `周四前` | 本周四的日期 |
| `本周末` | 本周日 |
| `月底` | 当月最后一天 |
| `季度末` | 当季最后一天 |
| `下季度` | 下季度最后一天（粗略，会让用户确认） |

未命中任何模式 → 进入 dialog 询问。

## 手动编辑须知

允许直接编辑 `okr-metadata.yaml`。注意事项：

- **不要改 `schema_version`**——版本升级时 skill 会自动迁移
- 改了 `kr_text_snapshot` 不会同步回飞书，反之亦然
- 改 `status` 立刻影响下次 review 行为（见 status 取值表）
- 加新字段 skill 会保留但忽略——可以拿来记自己的备注，但不影响分析
- 改坏了：上一次 review 写之前的 `.bak` 文件可以恢复（除非你在 config 关了备份）

## 跨季度迁移

新季度第一次跑 quarterly 或 weekly review 时，skill 会：

1. 创建新的 `<year>-<quarter>` 顶层节点
2. 把上季度仍 `active` 的 KR 询问用户："要不要带到本季？"
3. 用户选 yes → 复制 metadata；选 no → 旧的标 `done` / `archived`

不会自动复制——避免上一季的 phantom KR 永远漂移下去。

## 与 watch-list 的区别

| | watch-list | okr-metadata |
|---|---|---|
| 跟踪对象 | 任何笔记（idea / project / 待启动） | 仅 OKR 段中的 KR |
| 状态字段 | `watching` `considering` `active` `done` `abandoned` | `active` `phantom` `parked` `done` `archived` |
| 入口 | Obsidian 笔记的 frontmatter | weekly review 对话补全 |
| 用途 | 长期跟进、决定是否启动 | 给 OKR 分析提供 deadline / status |

watch-list 是"还没成 KR 的事"，okr-metadata 是"已经是 KR 了的元信息"。

## Schema 演进

`schema_version` 字段用来标识当前结构版本。如果未来变更：

- skill 自动检测旧版本
- 写入新版本前备份 `.bak`
- 在 release notes 里说明迁移行为
- **不会自动覆盖你的手动改动**——任何冲突都先问用户
