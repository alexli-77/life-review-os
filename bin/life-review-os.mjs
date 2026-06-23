#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = path.join(ROOT, '.runs');

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (hasFlag('--json')) {
    console.log(JSON.stringify({ ok: false, error: redact(message) }, null, 2));
  } else {
    console.error(message);
  }
  process.exitCode = 1;
});

async function main() {
  const [command = 'help', modeOrArg = 'weekly'] = positionalArgs();
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'run') {
    const mode = modeOrArg || 'weekly';
    if (mode !== 'weekly') throw new Error(`Only weekly mode is implemented in the CLI bridge, got: ${mode}`);
    const result = await runWeekly({
      provider: flagValue('--provider') || 'claude',
      userText: flagValue('--user-text') || '',
      dailyOsInputPath: flagValue('--daily-os-input') || '',
    });
    printResult(result);
    return;
  }
  if (command === 'preview') {
    const run = loadRun(requiredFlag('--run-id'));
    printResult({ ok: true, run_id: run.run_id, mode: run.mode, draft: run.draft, writeback: run.writeback, evidence: run.evidence });
    return;
  }
  if (command === 'writeback') {
    const result = await writebackRun(requiredFlag('--run-id'));
    printResult(result);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runWeekly(input) {
  const config = loadConfig();
  const now = new Date();
  const targetWeek = weekRange(targetWeekDate(config, now));
  const reviewWeek = previousWeek(targetWeek.start);
  const weekly = weeklyTarget(config, targetWeek.start);
  const table = await readWeeklyTable(weekly);
  validateTableMarker(table, weekly.marker);

  const reviewTaskColumn = findHeader(table.headers, `${reviewWeek.label} ${weekly.taskHeaderSuffix}`);
  const reviewRetroColumn = findAdjacentRetro(table.headers, reviewTaskColumn, weekly.retroHeaderSuffix);
  const taskValues = reviewTaskColumn >= 0 ? await readColumn(weekly, table, reviewTaskColumn) : [];
  const retroValues = reviewRetroColumn >= 0 ? await readColumn(weekly, table, reviewRetroColumn) : [];
  const reviewRows = table.rows.map((row) => ({
    row: row.index,
    okr: row.firstColumn,
    tasks: reviewTaskColumn >= 0 ? taskValues[row.index] || '' : '',
    retro: reviewRetroColumn >= 0 ? retroValues[row.index] || '' : '',
  }));
  const targetTaskHeader = `${targetWeek.label} ${weekly.taskHeaderSuffix}`;
  const targetTaskColumn = findHeader(table.headers, targetTaskHeader);
  const layout = detectLayout(table.headers, weekly.retroHeaderSuffix, weekly.taskHeaderSuffix);

  const prompt = buildWeeklyPrompt({
    config,
    weekly,
    mode: 'weekly',
    userText: input.userText,
    dailyOsInputPath: input.dailyOsInputPath,
    targetWeek,
    reviewWeek,
    reviewRows,
  });
  const draft = input.provider === 'none' ? deterministicDraft(reviewWeek, targetWeek, reviewRows) : runProvider(input.provider, prompt);
  const items = extractWritebackItems(draft);
  const writebackItems = assignRows(items, table.rows);
  const run = {
    ok: true,
    run_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    mode: 'weekly',
    provider: input.provider,
    draft,
    evidence: {
      review_week: reviewWeek.label,
      target_week: targetWeek.label,
      review_task_header: reviewTaskColumn >= 0 ? table.headers[reviewTaskColumn] : null,
      review_task_rows: reviewRows.map((row) => ({ row: row.row, okr: row.okr.slice(0, 160), tasks_preview: row.tasks.slice(0, 260), retro_preview: row.retro.slice(0, 180) })),
    },
    writeback: {
      doc_year: weekly.year,
      doc_label: `Weekly ${weekly.year}`,
      target_week: targetWeek.label,
      task_header: targetTaskHeader,
      action: targetTaskColumn >= 0 ? 'append_to_existing_empty_column' : 'insert_columns',
      layout,
      items: writebackItems,
      ready: writebackItems.length > 0 && writebackItems.every((item) => typeof item.target_row === 'number'),
    },
  };
  saveRun(run);
  return run;
}

async function writebackRun(runId) {
  const run = loadRun(runId);
  if (!run.writeback?.ready) throw new Error('Run is not ready for writeback; one or more items could not be mapped to a first-column OKR row.');
  const config = loadConfig();
  const weekly = weeklyTarget(config, `${run.writeback.doc_year || new Date().getFullYear()}-01-01`);
  const table = await readWeeklyTable(weekly);
  validateTableMarker(table, weekly.marker);
  const targetHeader = run.writeback.task_header;
  let taskColumn = findHeader(table.headers, targetHeader);
  let insertedColumns = false;
  if (taskColumn < 0) {
    insertedColumns = true;
    await insertWeekColumns(weekly, run.writeback.layout);
    const updated = await readWeeklyTable(weekly);
    await writeHeadersForInsertedWeek(weekly, updated, run.writeback);
    taskColumn = findHeader((await readWeeklyTable(weekly)).headers, targetHeader);
  }
  if (taskColumn < 0) throw new Error(`Could not locate target header after insert: ${targetHeader}`);
  const finalTable = await readWeeklyTable(weekly);
  const rowPlan = await planRowWrites(weekly, finalTable, taskColumn, run.writeback.items);
  let writtenCount = 0;
  let skippedCount = 0;
  for (const row of rowPlan.rows) {
    const cellId = finalTable.cellIds[row.rowIndex][taskColumn];
    for (const [itemIndex, item] of row.toWrite.entries()) {
      await postOrderedItem(weekly, cellId, item.text, item.is_mit, itemIndex);
      writtenCount += 1;
    }
    skippedCount += row.skipped.length;
  }
  return {
    ok: true,
    run_id: run.run_id,
    written: true,
    already_written: writtenCount === 0 && skippedCount > 0,
    inserted_columns: insertedColumns,
    task_header: targetHeader,
    item_count: writtenCount,
    skipped_count: skippedCount,
  };
}

function loadConfig() {
  const configPath = flagValue('--config') || firstExistingPath([path.join(ROOT, 'config.yaml'), path.join(os.homedir(), '.codex/skills/weekly-review/config.yaml')]);
  if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
  return parseConfigYaml(fs.readFileSync(configPath, 'utf8'));
}

function firstExistingPath(paths) {
  return paths.find((candidate) => fs.existsSync(candidate)) || paths[0];
}

function parseConfigYaml(text) {
  const config = { user: {}, documents: { weekly: [] }, modes: {} };
  const lines = text.split('\n');
  let section = [];
  let currentWeekly = null;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '');
    if (!line.trim()) continue;
    const indent = raw.match(/^\s*/)?.[0].length || 0;
    const trimmed = line.trim();
    if (indent === 0 && trimmed.endsWith(':')) {
      section = [trimmed.slice(0, -1)];
      currentWeekly = null;
      continue;
    }
    if (indent === 2 && trimmed.endsWith(':')) {
      section = [section[0], trimmed.slice(0, -1)];
      currentWeekly = null;
      continue;
    }
    const item = trimmed.match(/^-\s+([A-Za-z0-9_]+):\s*(.+)$/);
    if (section[0] === 'documents' && section[1] === 'weekly' && item) {
      currentWeekly = {};
      config.documents.weekly.push(currentWeekly);
      currentWeekly[item[1]] = parseScalar(item[2]);
      continue;
    }
    const kv = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = parseScalar(rawValue);
    if (section[0] === 'user') config.user[key] = value;
    else if (section[0] === 'documents' && section[1] === 'weekly' && currentWeekly) currentWeekly[key] = value;
    else if (section[0] === 'modes' && section[1]) {
      config.modes[section[1]] ||= {};
      config.modes[section[1]][key] = value;
    }
  }
  return config;
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function weeklyTarget(config, date) {
  const year = Number(String(date).slice(0, 4)) || new Date().getFullYear();
  const selected = config.documents.weekly.find((doc) => doc.year === year) || config.documents.weekly[0];
  if (!selected?.token || !selected?.table_block_id) throw new Error(`Missing weekly token/table_block_id for ${year}`);
  return {
    year: selected.year || year,
    token: selected.token,
    tableBlockId: selected.table_block_id,
    marker: selected.table_marker || config.user.symbol || '🐶',
    taskHeaderSuffix: selected.task_header_suffix || '要务',
    retroHeaderSuffix: selected.retro_header_suffix || 'retro',
  };
}

async function readWeeklyTable(weekly) {
  const block = await getBlock(weekly, weekly.tableBlockId);
  const cells = block.table?.cells || [];
  const columnCount = block.table?.property?.column_size || block.table?.property?.column_count;
  const rowCount = block.table?.property?.row_size || block.table?.property?.row_count;
  if (!columnCount || !rowCount) throw new Error('Weekly table is missing row/column metadata.');
  const cellIds = [];
  for (let row = 0; row < rowCount; row += 1) {
    cellIds[row] = [];
    for (let col = 0; col < columnCount; col += 1) {
      const cellId = cells[row * columnCount + col];
      cellIds[row][col] = cellId;
    }
  }
  const headers = await mapLimit(cellIds[0], 3, (cellId) => readCellText(weekly, cellId));
  const firstColumn = await mapLimit(cellIds, 3, (row) => readCellText(weekly, row[0]));
  const rows = firstColumn.map((value, index) => ({ index, firstColumn: index === 0 ? headers[0] || value || '' : value || '' }));
  return { rowCount, columnCount, headers, rows, cellIds };
}

async function readColumn(weekly, table, column) {
  return mapLimit(table.cellIds, 3, (row) => readCellText(weekly, row[column]));
}

async function readCellText(weekly, cellId) {
  const cell = await getBlock(weekly, cellId);
  const childBlocks = await mapLimit(cell.children || [], 3, (child) => getBlock(weekly, child));
  const chunks = childBlocks.map((child) => textFromBlock(child));
  return chunks.join(' / ').replace(/\s+/g, ' ').trim();
}

async function getBlock(weekly, blockId) {
  const result = await larkApi('GET', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${blockId}`);
  return result.data?.block || {};
}

function larkApi(method, apiPath, data) {
  return larkApiWithRetry(method, apiPath, data, 0);
}

async function larkApiWithRetry(method, apiPath, data, attempt) {
  try {
    return await larkApiOnce(method, apiPath, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempt < 4 && /rate_limit|frequency limit|99991400|retryable/i.test(message)) {
      await sleep(800 * 2 ** attempt);
      return larkApiWithRetry(method, apiPath, data, attempt + 1);
    }
    throw error;
  }
}

function larkApiOnce(method, apiPath, data) {
  const args = ['api', method, apiPath, '--as', 'user', '--format', 'json'];
  if (data) args.push('--data', JSON.stringify(data));
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`lark-cli ${method} timed out: ${redact(apiPath)}`));
    }, 30000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status !== 0) {
        reject(new Error(redact((stderr || stdout).slice(0, 1200))));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (parsed.code && parsed.code !== 0) reject(new Error(redact(JSON.stringify(parsed).slice(0, 1200))));
        else resolve(parsed);
      } catch (error) {
        reject(new Error(`lark-cli ${method} returned invalid JSON: ${redact(stdout.slice(0, 500))}`));
      }
    });
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function textFromBlock(block) {
  const chunks = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.content === 'string') chunks.push(value.content);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(block);
  return chunks.join('').trim();
}

function validateTableMarker(table, marker) {
  const text = [table.headers.join(' '), ...table.rows.map((row) => row.firstColumn)].join('\n');
  if (!text.includes(marker)) throw new Error(`Target table marker check failed: ${marker}`);
}

function detectLayout(headers, retroSuffix, taskSuffix) {
  const retro = headers.findIndex((header, index) => index > 0 && header.toLowerCase().includes(String(retroSuffix).toLowerCase()));
  const task = headers.findIndex((header, index) => index > 0 && header.includes(taskSuffix));
  return retro >= 0 && task >= 0 && retro < task ? 'retro_before_task' : 'task_before_retro';
}

function findHeader(headers, label) {
  const needle = normalizeHeader(label);
  return headers.findIndex((header) => normalizeHeader(header).includes(needle));
}

function findAdjacentRetro(headers, taskColumn, retroSuffix) {
  if (taskColumn < 0) return -1;
  const candidates = [taskColumn - 1, taskColumn + 1].filter((index) => index >= 0 && index < headers.length);
  return candidates.find((index) => headers[index].toLowerCase().includes(String(retroSuffix).toLowerCase())) ?? -1;
}

function normalizeHeader(value) {
  return String(value).replace(/\s+/g, '').toLowerCase();
}

function buildWeeklyPrompt(input) {
  const skill = readText('SKILL.md');
  const engine02 = readText('engine/02-analyze.md');
  const engine03 = readText('engine/03-plan.md');
  const framework = readText(`frameworks/${input.config.framework || 'stephen-covey'}.md`);
  const dailyOs = input.dailyOsInputPath && fs.existsSync(input.dailyOsInputPath) ? fs.readFileSync(input.dailyOsInputPath, 'utf8').slice(0, 20000) : '';
  return [
    '# Life Review OS weekly run',
    '',
    '请严格按 Life Review OS 规则输出中文 weekly review 草稿。不要写回飞书；写回由 CLI 的 writeback 命令执行。',
    '必须使用下面的 Feishu 表格结构化数据作为权威事实，不要说表格为空，除非对应 rows 的 tasks 真的为空。',
    '',
    '# Skill',
    skill,
    '',
    '# Analysis Rules',
    engine02,
    '',
    '# Planning Rules',
    engine03,
    '',
    '# Framework',
    framework,
    '',
    '# Runtime Evidence',
    JSON.stringify(
      {
        review_week: input.reviewWeek.label,
        target_week: input.targetWeek.label,
        user_text: input.userText,
        first_column_okr_rows: input.reviewRows.slice(1).map((row) => ({ row_index: row.row, okr: row.okr })),
        weekly_rows: input.reviewRows,
      },
      null,
      2,
    ),
    '',
    '# Daily OS context',
    dailyOs,
    '',
    '# Output contract',
    `输出必须包含 "## 📊 上周执行对比（${input.reviewWeek.label}）" 和 "## 📋 下周计划（${input.targetWeek.label}）"。`,
    '下周计划里的每条要务必须对应或可追溯到第一列 🐶 重点OKR 的某一行。',
    '最后必须附一个 fenced JSON 代码块，格式为：',
    '```json',
    '{"writeback_plan":[{"row_index":1,"row_label":"第一列 OKR 原文或稳定简称","text":"要写入该行的下周要务","is_mit":false}]}',
    '```',
    'row_index 必须来自 Runtime Evidence 的 first_column_okr_rows；不确定归属的要务不要放进 writeback_plan。',
    'writeback_plan 的每个对象只允许是一条 Feishu 有序列表项；同一 OKR 行有多条要务时，输出多个对象并使用相同 row_index。',
    '不要在 text 里用 "/" 串联多个要务，也不要在 text 末尾保留 "/"。',
    'MIT 项只设置 is_mit=true，text 里不要写 "MIT:"、"MIT 🔴" 或红点；写回时会按历史表格风格追加红色 MIT 和 ✅。',
  ].join('\n');
}

function readText(relativePath) {
  const filePath = path.join(ROOT, relativePath);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function runProvider(provider, prompt) {
  if (provider === 'claude') {
    const res = spawnSync(process.env.CLAUDE_BIN || 'claude', ['-p', '--output-format', 'text', '--strict-mcp-config'], {
      input: prompt,
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 180000,
    });
    if (res.status !== 0) throw new Error(`Claude failed: ${(res.stderr || res.stdout).slice(0, 2000)}`);
    return res.stdout.trim();
  }
  if (provider === 'codex') {
    const out = path.join(os.tmpdir(), `life-review-os-${Date.now()}.md`);
    const res = spawnSync(process.env.CODEX_BIN || 'codex', ['exec', '--skip-git-repo-check', '--ignore-rules', '--sandbox', 'read-only', '--output-last-message', out, '--cd', ROOT, '-'], {
      input: prompt,
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 180000,
    });
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : res.stdout;
    fs.rmSync(out, { force: true });
    if (res.status !== 0) throw new Error(`Codex failed: ${(res.stderr || res.stdout).slice(0, 2000)}`);
    return text.trim();
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function deterministicDraft(reviewWeek, targetWeek, rows) {
  const completed = [];
  const unfinished = [];
  const writebackPlan = [];
  for (const row of rows.slice(1)) {
    for (const item of splitItems(row.tasks)) {
      if (/[✅]/.test(item)) completed.push(item);
      else if (/[⭕️❌🚧]/.test(item)) {
        unfinished.push(item);
        if (writebackPlan.length < 5) {
          writebackPlan.push({
            row_index: row.row,
            row_label: row.okr,
            text: item.replace(/[⭕️❌🚧]/g, '').trim() || item,
            is_mit: writebackPlan.length === 0,
          });
        }
      }
    }
  }
  return [
    `## 📊 上周执行对比（${reviewWeek.label}）`,
    '',
    '**完成 ✅**',
    ...(completed.length ? completed.slice(0, 8).map((item) => `- ${item}`) : ['- 暂无明确完成项']),
    '',
    '**未完成 ⭕️**',
    ...(unfinished.length ? unfinished.slice(0, 8).map((item) => `- ${item}`) : ['- 暂无明确未完成项']),
    '',
    `## 📋 下周计划（${targetWeek.label}）`,
    '',
    '**MIT 🔴**：延续上周未闭环的最高优先级事项',
    '',
    '1. 根据上周未完成项补齐本周要务',
    '',
    '```json',
    JSON.stringify({ writeback_plan: writebackPlan }, null, 2),
    '```',
  ].join('\n');
}

function extractWritebackItems(draft) {
  const structured = extractStructuredWritebackItems(draft);
  if (structured.length) return structured;
  const lines = draft.split('\n').map((line) => stripMarkdown(line.trim())).filter(Boolean);
  const start = lines.findIndex((line) => /^(?:📋\s*)?下周计划/.test(line));
  const relevant = start >= 0 ? lines.slice(start + 1) : lines;
  const items = [];
  for (let index = 0; index < relevant.length; index += 1) {
    const line = relevant[index];
    if (/^-{3,}$/.test(line) || /^>?\s*基于\s/.test(line) || /^KR[：:]/i.test(line)) continue;
    if (/^\[?如有余力\]?/.test(line) || /^(如果|你确认|您确认|写回|已写入)/.test(line)) break;
    const mit = line.match(/^MIT\s*🔴?[：:]\s*(.+)$/i);
    if (mit?.[1]) {
      items.push({ text: `MIT 🔴: ${mit[1].trim()}`, heading: '' });
      continue;
    }
    const numbered = line.match(/^(?:[-*]|\d+[.、])\s*(.+)$/);
    if (numbered?.[1] && !/^完成标准[：:]/.test(numbered[1])) items.push({ text: numbered[1].trim(), heading: '' });
  }
  return Array.from(new Map(items.map((item) => [item.text, item])).values()).slice(0, 10);
}

function assignRows(items, rows) {
  return items.map((item) => {
    const ranked = rows.slice(1).map((row) => ({ row, score: overlapScore(`${item.heading} ${item.text}`, row.firstColumn) })).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    return {
      text: item.text,
      is_mit: Boolean(item.is_mit) || /MIT|🔴/.test(item.text),
      target_row: validTargetRow(item.target_row, rows) ?? (best && best.score >= 2 ? best.row.index : null),
      target_row_label:
        item.target_row && rows[item.target_row]?.firstColumn
          ? rows[item.target_row].firstColumn.slice(0, 120)
          : best && best.score >= 2
            ? best.row.firstColumn.slice(0, 120)
            : '',
      match_score: item.target_row ? 999 : best?.score || 0,
    };
  });
}

function extractStructuredWritebackItems(draft) {
  const blocks = [...String(draft).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      const plan = Array.isArray(parsed?.writeback_plan) ? parsed.writeback_plan : Array.isArray(parsed) ? parsed : [];
      const items = plan
        .flatMap((item) =>
          splitWritebackItem({
            text: String(item?.text || '').trim(),
            heading: String(item?.row_label || item?.okr || '').trim(),
            target_row: Number.isInteger(item?.row_index) ? item.row_index : null,
            is_mit: Boolean(item?.is_mit),
          }),
        )
        .filter((item) => item.text);
      if (items.length) return items.slice(0, 10);
    } catch {
      // Try the next JSON block.
    }
  }
  return [];
}

function validTargetRow(row, rows) {
  return Number.isInteger(row) && row > 0 && row < rows.length ? row : null;
}

function splitWritebackItem(item) {
  const text = cleanWritebackText(item.text);
  if (!text) return [];
  const segments = text.split(/\s+\/\s+/).map(cleanWritebackText).filter(Boolean);
  if (segments.length <= 1) return [{ ...item, text }];

  const pieces = [];
  let current = '';
  for (const segment of segments) {
    if (!current) {
      current = segment;
    } else if (looksLikeTaskStart(segment)) {
      pieces.push(current);
      current = segment;
    } else {
      current = `${current} / ${segment}`;
    }
  }
  if (current) pieces.push(current);
  return pieces.map((piece, index) => ({
    ...item,
    text: piece,
    is_mit: Boolean(item.is_mit) && index === 0,
  }));
}

function looksLikeTaskStart(value) {
  return /^(?:MIT\b|OKR|跟进|联系|确认|完成|准备|整理|记录|处理|推进|发布|输出|阅读|战术|给父母|Leon|穿线|todo\b|被动收入|协助|建立|发送|写清|复核|检查|更新|列出|安排|固定|拍|补齐|列出|映射|同步|设计|实现|测试|修复|复盘)/i.test(value.trim());
}

function cleanWritebackText(value) {
  return String(value)
    .replace(/^\s*(?:MIT\s*){1,}🔴?\s*[:：]?\s*/i, '')
    .replace(/\s*🔴\s*/g, ' ')
    .replace(/^\s*\/+\s*/, '')
    .replace(/\s*\/+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function overlapScore(left, right) {
  const a = tokenSet(left);
  const b = tokenSet(right);
  let score = 0;
  for (const token of a) if (b.has(token)) score += token.length > 4 ? 2 : 1;
  return score;
}

function tokenSet(value) {
  const text = String(value).toLowerCase();
  const out = new Set();
  for (const token of text.match(/[a-z0-9][a-z0-9_-]{2,}/g) || []) out.add(token);
  for (const token of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    for (let index = 0; index < token.length - 1; index += 1) out.add(token.slice(index, index + 2));
  }
  return out;
}

async function insertWeekColumns(weekly, layout) {
  if (layout === 'retro_before_task') {
    await larkApi('PATCH', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${weekly.tableBlockId}`, { insert_table_column: { column_index: 1 } });
    await larkApi('PATCH', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${weekly.tableBlockId}`, { insert_table_column: { column_index: 2 } });
    return;
  }
  await larkApi('PATCH', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${weekly.tableBlockId}`, { insert_table_column: { column_index: 1 } });
  await larkApi('PATCH', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${weekly.tableBlockId}`, { insert_table_column: { column_index: 2 } });
}

async function writeHeadersForInsertedWeek(weekly, table, writeback) {
  const retroCol = writeback.layout === 'retro_before_task' ? 1 : 2;
  const taskCol = writeback.layout === 'retro_before_task' ? 2 : 1;
  await postText(weekly, table.cellIds[0][retroCol], 'retro');
  await postText(weekly, table.cellIds[0][taskCol], writeback.task_header);
}

async function assertColumnEmpty(weekly, table, column) {
  const filled = [];
  for (let row = 1; row < table.rowCount; row += 1) {
    const text = await readCellText(weekly, table.cellIds[row][column]);
    if (text.trim()) filled.push(row);
  }
  if (filled.length) throw new Error(`Target column already has content in rows ${filled.join(', ')}; refusing to overwrite.`);
}

async function planRowWrites(weekly, table, column, items) {
  const grouped = groupItemsByTargetRow(items, table.rowCount);
  const plannedRows = new Set([...grouped.keys()]);
  const existingValues = await readColumn(weekly, table, column);
  const conflictingRows = [];
  const rows = [];

  for (let row = 1; row < table.rowCount; row += 1) {
    const existing = existingValues[row] || '';
    if (!hasMeaningfulCellContent(existing)) {
      if (grouped.has(row)) rows.push({ rowIndex: row, toWrite: grouped.get(row), skipped: [] });
      continue;
    }
    if (!plannedRows.has(row)) {
      conflictingRows.push(row);
      continue;
    }
    const toWrite = [];
    const skipped = [];
    for (const item of grouped.get(row) || []) {
      if (cellContainsItem(existing, item.text)) skipped.push(item);
      else toWrite.push(item);
    }
    if (toWrite.length > 0 && skipped.length === 0) {
      conflictingRows.push(row);
    } else {
      rows.push({ rowIndex: row, toWrite, skipped });
    }
  }

  if (conflictingRows.length) {
    throw new Error(`Target column already has unrelated content in rows ${conflictingRows.join(', ')}; refusing to overwrite.`);
  }
  return { rows };
}

function groupItemsByTargetRow(items, rowCount) {
  const grouped = new Map();
  for (const item of items) {
    if (typeof item.target_row !== 'number' || item.target_row <= 0 || item.target_row >= rowCount) {
      throw new Error(`Writeback item is not mapped to a first-column OKR row: ${item.text}`);
    }
    grouped.set(item.target_row, [...(grouped.get(item.target_row) || []), item]);
  }
  return grouped;
}

function cellContainsItem(cellText, itemText) {
  const cell = comparableText(cellText);
  const item = comparableText(itemText);
  if (!cell || !item) return false;
  return cell.includes(item) || item.includes(cell);
}

function hasMeaningfulCellContent(cellText) {
  return Boolean(comparableText(cellText));
}

function comparableText(value) {
  return String(value)
    .replace(/MIT|🔴|✅|⭕️|⭕|❌|🚧/gi, '')
    .replace(/[\s`*_>#:/：;；,，.。()（）\[\]【】"'“”‘’/\\|-]/g, '')
    .toLowerCase();
}

async function postText(weekly, cellId, content) {
  await larkApi('POST', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${cellId}/children`, {
    children: [{ block_type: 2, text: { elements: [{ text_run: { content } }], style: {} } }],
    index: 0,
  });
}

async function postOrderedItem(weekly, cellId, content, isMit, position = 0) {
  await larkApi('POST', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${cellId}/children`, {
    children: [
      {
        block_type: 13,
        ordered: {
          elements: isMit
            ? [
                { text_run: { content: formatTaskContent(content) } },
                { text_run: { content: ' MIT', text_element_style: { text_color: 1 } } },
                { text_run: { content: ' ✅' } },
              ]
            : [{ text_run: { content: formatTaskContent(content) } }],
          style: {},
        },
      },
    ],
    index: position,
  });
}

function formatTaskContent(content) {
  return cleanWritebackText(content);
}

function targetWeekDate(config, now) {
  const timezone = config.user.timezone || 'UTC';
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? addDays(date, 1) : date;
}

function weekRange(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const start = monday.toISOString().slice(0, 10);
  const end = sunday.toISOString().slice(0, 10);
  return { start, end, label: `${monday.getUTCMonth() + 1}.${monday.getUTCDate()}-${sunday.getUTCMonth() + 1}.${sunday.getUTCDate()}` };
}

function previousWeek(start) {
  return weekRange(addDays(start, -7));
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function splitItems(text) {
  return String(text)
    .split(/\s+\/\s+|\n|;/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripMarkdown(value) {
  return String(value).replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').replace(/^>\s*/, '').trim();
}

function saveRun(run) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNS_DIR, `${run.run_id}.json`), JSON.stringify(run, null, 2), 'utf8');
}

function loadRun(runId) {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Invalid run id');
  const file = path.join(RUNS_DIR, `${runId}.json`);
  if (!fs.existsSync(file)) throw new Error(`Run not found: ${runId}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function positionalArgs() {
  return process.argv.slice(2).filter((arg, index, args) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'));
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function requiredFlag(name) {
  const value = flagValue(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function printResult(result) {
  if (hasFlag('--json')) console.log(JSON.stringify(redactObject(result), null, 2));
  else console.log(result.draft || JSON.stringify(redactObject(result), null, 2));
}

function printHelp() {
  console.log('Usage: life-review-os run weekly --json [--provider claude|codex|none]');
  console.log('       life-review-os preview --run-id <id> --json');
  console.log('       life-review-os writeback --run-id <id> --json');
}

function redactObject(value) {
  return JSON.parse(redact(JSON.stringify(value)));
}

function redact(value) {
  return String(value)
    .replace(/\b(?:doccn|doxcn)[A-Za-z0-9_-]{8,}\b/g, '[redacted-doc-token]')
    .replace(/(documents\/)[A-Za-z0-9_-]+/g, '$1[redacted-doc-token]')
    .replace(/(blocks\/)[A-Za-z0-9_-]+/g, '$1[redacted-block-id]');
}
