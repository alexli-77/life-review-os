# Engine 01 — 读取飞书文档

从 config.yaml 读取文档 token，按文档类型选择正确的读取方式。

## 文档类型判断

| 判断条件 | 文档类型 | 读取方式 |
|---|---|---|
| config 中有 `format: legacy` | 旧版 doc | Legacy API |
| token 以 `docx` 开头，或无 format 字段，且为新版 | 新版 docx | lark-cli docs +fetch |
| token 为纯字母数字（如 `XxxxxXxxxxXxxxxXxxxxXxxxxX`） | 新版 docx | lark-cli docs +fetch |

## 方式 A：读取新版 docx

```bash
lark-cli docs +fetch --doc {token} --as user 2>&1
```

输出为 JSON，取 `data.markdown` 字段即为文档内容。

**文档过大时**（markdown 超过 50KB）：用 python 管道过滤，只提取需要的部分：

```bash
lark-cli docs +fetch --doc {token} --as user 2>&1 | python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
md = data['data']['markdown']
lines = md.split('\n')
# 只取 OKR 和 🐧 相关段落
in_section = False
output = []
for line in lines:
    if '# OKR' in line or '## OKR' in line:
        in_section = True
    if in_section:
        output.append(line)
    if in_section and len(output) > 200:
        break
print('\n'.join(output))
"
```

## 方式 B：读取旧版 legacy doc

```bash
lark-cli api GET "/open-apis/doc/v2/{token}/content" --as user 2>&1 | python3 -c "
import sys, json

raw = sys.stdin.read()
data = json.loads(raw)
content = json.loads(data['data']['content'])
blocks = content['body']['blocks']

def get_text(block, depth=0):
    lines = []
    btype = block.get('type','')
    indent = '  ' * depth
    if btype == 'paragraph':
        style = block.get('paragraph',{}).get('style',{})
        h = style.get('headingLevel', 0)
        prefix = ('#'*h + ' ') if h else ''
        if style.get('list',{}).get('type') == 'bullet':
            prefix = '- '
        elif style.get('list',{}).get('type') == 'ordered':
            prefix = '1. '
        els = [el['textRun']['text'] for el in block.get('paragraph',{}).get('elements',[]) if el.get('type')=='textRun']
        t = ''.join(els).strip()
        if t:
            lines.append(indent + prefix + t)
    elif btype in ('callout', 'quote'):
        for b in block.get(btype,{}).get('body',{}).get('blocks',[]):
            lines.extend(get_text(b, depth))
    return lines

for block in blocks:
    for l in get_text(block):
        print(l)
"
```

## 按 mode 决定读取范围

### weekly 模式（lookback_weeks: 2）
读取内容：
1. 当前年份 Weekly 文档中的 OKR 定义段落（完整读取）
2. 当前年份 Weekly 文档中最近 2 周的执行表格行（过滤 `user.symbol`）

### biweekly 模式（lookback_weeks: 4）
读取内容同 weekly，但扩展到最近 4 周执行数据。

### quarterly 模式
读取内容：
1. 使命宣言文档（全量）
2. 五年计划文档（只取 `百岁目标` / `用户相关` 章节）
3. 当前年份 Weekly 的 OKR 定义
4. 当前年份所有季度的执行表格（全量）
5. 历史年份 Weekly 的 OKR 完成情况（仅摘要）

## 过滤用户数据

所有文档中，只处理包含 `config.user.symbol` 的行/区块，忽略其他角色。

```python
# 示例：过滤 🐧 行
user_symbol = '🐧'  # 从 config.yaml 读取
relevant = [line for line in lines if user_symbol in line or in_user_section]
```

## 错误处理

| 错误 | 原因 | 处理方式 |
|---|---|---|
| `Unsupported document type: Legacy document` | 用 docx API 读旧版文档 | 改用方式 B（Legacy API） |
| `not found` / 404 | token 错误或无权限 | 提示用户检查 config.yaml 中的 token |
| `user_access_token is invalid` | token 过期 | 运行 `lark-cli auth login --scope "docx:document:readonly"` |
| 输出过大（>50KB） | 文档内容太长 | 用 python 管道过滤，只取关键章节 |
