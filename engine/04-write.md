# Engine 04 — 写回飞书表格

将 `engine/03-plan.md` 生成的下周计划写入飞书 Weekly 文档的表格中。

## 前置检查

1. 确认 `modes.{mode}.auto_write = true`，否则只在对话中输出，不写入
2. 从 config.yaml 获取当前年份 weekly 的 `table_block_id`，该值必须指向 `🐶` 每周要务表格
3. 确认飞书认证有效（`--as user`）
4. 确认 `engine/01-read.md` 已成功校验 `table_marker`，且 `engine/03-plan.md`
   的所有 KR 均来自 `🐶 重点OKR`
5. 确认每条下周要务都带有明确的第一列 OKR 行位置；无法定位到行的要务不得写回

如果无法确认目标表格属于 `🐶`，禁止写回。
如果无法确认要务对应第一列哪一行，禁止写回，不能默认写入第一行。

## Step 1：获取表格当前列结构

```bash
lark-cli api GET "/open-apis/docx/v1/documents/{doc_token}/blocks/{table_block_id}" \
  --as user 2>&1
```

从响应中读取：
- `cells` 数组（按 `row * col_count + col` 索引）
- 当前列数 `col_count`
- 第 0 行（表头行）的内容，确认最后一列是否已有本周日期
- 表格标题、邻近 block 或首列内容中必须包含 `table_marker`（默认 `🐶`）

## Step 2：判断是否需要插入新列

检查表头行最后几列：
- 若已有本周日期的列 → 直接写入，跳过插入
- 若没有 → 插入 2 列（要务列 + retro 列）
- 插入前再次确认写入列位于 `🐶` 表格内，不得根据全文搜索结果写入其他表格

**插入列（在倒数第二位置，即 retro 列之前）：**

```bash
# 先插入 retro 列
lark-cli api PATCH "/open-apis/docx/v1/documents/{doc_token}/blocks/{table_block_id}" \
  --as user \
  --data '{"insert_table_column": {"column_index": N}}'

# 再插入要务列（index N，retro 自动后移）
lark-cli api PATCH "/open-apis/docx/v1/documents/{doc_token}/blocks/{table_block_id}" \
  --as user \
  --data '{"insert_table_column": {"column_index": N}}'
```

## Step 3：写入表头

```bash
lark-cli api POST "/open-apis/docx/v1/documents/{doc_token}/blocks/{header_cell_id}/children" \
  --as user \
  --data '{
    "children": [{
      "block_type": 2,
      "text": {
        "elements": [{"text_run": {"content": "{MM.DD}-{MM.DD} 要务"}}],
        "style": {}
      }
    }],
    "index": 0
  }'
```

## Step 4：写入要务内容（有序列表）

每条要务写为一个有序列表项，格式保持 `🐶` 表格历史每周要务风格。
MIT 用红色文字标注。每条 KR 前缀必须对应 `🐶 重点OKR` 中的 KR 或稳定简称。
写入时必须使用该要务对应的第一列 OKR 行的单元格：`cell = cells[row_index * col_count + task_col]`。
同一 OKR 行下的多条要务可按顺序写入同一个单元格；不同 OKR 行不得合并到第一行。

```bash
# 写入普通要务
lark-cli api POST "/open-apis/docx/v1/documents/{doc_token}/blocks/{cell_id}/children" \
  --as user \
  --data '{
    "children": [{
      "block_type": 13,
      "ordered": {
        "elements": [{"text_run": {"content": "KR1: 要务内容"}}],
        "style": {}
      }
    }],
    "index": 0
  }'

# 写入 MIT 要务（红色标注）
lark-cli api POST "/open-apis/docx/v1/documents/{doc_token}/blocks/{cell_id}/children" \
  --as user \
  --data '{
    "children": [{
      "block_type": 13,
      "ordered": {
        "elements": [
          {"text_run": {"content": "MIT: 要务内容"}},
          {"text_run": {"content": " 🔴", "text_element_style": {"text_color": 1}}}
        ],
        "style": {}
      }
    }],
    "index": 0
  }'
```

## block_type 速查

| 值 | 类型 |
|---|---|
| 2 | 普通文本段落 |
| 12 | 无序列表 |
| 13 | 有序列表 |
| 19 | Callout 高亮框 |

## text_color 速查

| 值 | 颜色 |
|---|---|
| 1 | 红色（MIT 标注用）|
| 2 | 橙色 |
| 4 | 绿色 |
| 5 | 蓝色 |

## 写入完成后

输出确认信息：
```
✅ 已写入飞书：{doc_url}
   🐶 表格下周计划（{日期范围}）已插入新列
```

## 错误处理

| 错误 | 处理 |
|---|---|
| 权限不足 | `lark-cli auth login --scope "docx:document"` |
| table_block_id 无效 | 提示用户更新 config.yaml 中的 table_block_id |
| table_marker 校验失败 | 停止写回，提示用户确认该 block_id 是否为 🐶 表格 |
| 计划含非 🐶 重点OKR KR | 停止写回，回到 engine/03-plan.md 重新生成 |
| 列已存在 | 跳过插入，直接定位到已有列写入（避免重复） |
