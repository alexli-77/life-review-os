#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS_DIR = path.join(ROOT, '.runs');

// Only run the CLI when executed directly; stay importable for tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (hasFlag('--json')) {
      console.log(JSON.stringify({ ok: false, error: redact(message) }, null, 2));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  });
}

export { cycleDays, cycleRange, previousCycle, resolveCycle, biweeklyBudgetMultiplier, buildPlanningPolicy, parseConfigYaml };

async function main() {
  const [command = 'help', modeOrArg = 'weekly'] = positionalArgs();
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'run') {
    const result = await runCycle({
      mode: modeArgProvided() ? modeOrArg : '',
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
  if (command === 'write-review') {
    const result = await writeReviewRun(requiredFlag('--run-id'));
    printResult(result);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runCycle(input) {
  const config = loadConfig();
  const cycle = resolveCycle(config, input.mode);
  const now = new Date();
  const targetWeek = cycleRange(targetWeekDate(config, now), cycle);
  const reviewWeek = previousCycle(targetWeek.start, cycle);
  const weekly = weeklyTarget(config, targetWeek.start);
  const table = await readWeeklyTable(weekly);
  validateTableMarker(table, weekly.marker);
  const planningPolicy = buildPlanningPolicy(config, table.rows, cycle);

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
  const targetTaskColumn = findTaskHeaderForWeek(table.headers, targetTaskHeader, targetWeek, weekly.taskHeaderSuffix);
  const targetRetroColumn = findAdjacentRetro(table.headers, targetTaskColumn, weekly.retroHeaderSuffix);
  const targetTaskValues = targetTaskColumn >= 0 ? await readColumn(weekly, table, targetTaskColumn) : [];
  const targetRetroValues = targetRetroColumn >= 0 ? await readColumn(weekly, table, targetRetroColumn) : [];
  const targetRows = table.rows.map((row) => ({
    row: row.index,
    okr: row.firstColumn,
    tasks: targetTaskColumn >= 0 ? targetTaskValues[row.index] || '' : '',
    retro: targetRetroColumn >= 0 ? targetRetroValues[row.index] || '' : '',
  }));
  const layout = detectLayout(table.headers, weekly.retroHeaderSuffix, weekly.taskHeaderSuffix);

  const prompt = buildWeeklyPrompt({
    config,
    weekly,
    mode: cycle,
    userText: input.userText,
    dailyOsInputPath: input.dailyOsInputPath,
    planningPolicy,
    targetWeek,
    reviewWeek,
    reviewRows,
    targetRows,
  });
  const draft = input.provider === 'none' ? deterministicDraft(reviewWeek, targetWeek, reviewRows, planningPolicy, targetRows) : runProvider(input.provider, prompt);
  const items = extractWritebackItems(draft);
  const writebackItems = applyPlanningBudget(assignRows(items, table.rows), reviewRows, table.rows, planningPolicy);
  const reviewText = extractReviewText(draft) || buildDeterministicRetroReview(targetRows, reviewRows);
  const reviewTargetRow = selectRetroReviewRow(targetRows);
  const run = {
    ok: true,
    run_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    mode: cycle,
    provider: input.provider,
    draft,
    evidence: {
      review_week: reviewWeek.label,
      target_week: targetWeek.label,
      review_task_header: reviewTaskColumn >= 0 ? table.headers[reviewTaskColumn] : null,
      target_task_header: targetTaskColumn >= 0 ? table.headers[targetTaskColumn] : null,
      target_retro_header: targetRetroColumn >= 0 ? table.headers[targetRetroColumn] : null,
      review_task_rows: reviewRows.map((row) => ({ row: row.row, okr: row.okr.slice(0, 160), tasks_preview: row.tasks.slice(0, 260), retro_preview: row.retro.slice(0, 180) })),
      target_retro_rows: targetRows.map((row) => ({ row: row.row, okr: row.okr.slice(0, 160), tasks_preview: row.tasks.slice(0, 220), retro_preview: row.retro.slice(0, 260) })),
      planning_policy: planningPolicy,
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
      review: {
        target_task_header: targetTaskColumn >= 0 ? table.headers[targetTaskColumn] : targetTaskHeader,
        target_retro_header: targetRetroColumn >= 0 ? table.headers[targetRetroColumn] : null,
        target_row: reviewTargetRow,
        text: reviewText,
        ready: targetTaskColumn >= 0 && targetRetroColumn >= 0 && typeof reviewTargetRow === 'number' && Boolean(reviewText),
      },
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

  // Mark OKR rows that received no plan this cycle, if a placeholder is configured.
  const placeholder = cleanWritebackText(String(config.planning?.empty_row_placeholder || '').trim());
  let placeholderCount = 0;
  if (placeholder) {
    const plannedRowSet = new Set(rowPlan.rows.map((row) => row.rowIndex));
    const columnValues = await readColumn(weekly, finalTable, taskColumn);
    for (const tableRow of finalTable.rows) {
      const row = tableRow.index;
      if (row < 1) continue; // skip header row
      if (!String(tableRow.firstColumn || '').trim()) continue; // not a real OKR row
      if (plannedRowSet.has(row)) continue; // already received tasks
      if (hasMeaningfulCellContent(columnValues[row] || '')) continue; // cell already has content
      await postOrderedItem(weekly, finalTable.cellIds[row][taskColumn], placeholder, false, 0);
      placeholderCount += 1;
    }
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
    placeholder_count: placeholderCount,
  };
}

async function writeReviewRun(runId) {
  const run = loadRun(runId);
  const review = run.writeback?.review;
  if (!review?.ready) throw new Error('Run is not ready for retro review writeback.');
  const config = loadConfig();
  const weekly = weeklyTarget(config, `${run.writeback.doc_year || new Date().getFullYear()}-01-01`);
  const table = await readWeeklyTable(weekly);
  validateTableMarker(table, weekly.marker);

  const taskColumn = findHeader(table.headers, review.target_task_header || run.writeback.task_header);
  if (taskColumn < 0) throw new Error(`Could not locate target task header for review writeback: ${review.target_task_header || run.writeback.task_header}`);
  const retroColumn = findAdjacentRetro(table.headers, taskColumn, weekly.retroHeaderSuffix);
  if (retroColumn < 0) throw new Error(`Could not locate adjacent retro column for target task header: ${table.headers[taskColumn]}`);

  const retroValues = await readColumn(weekly, table, retroColumn);
  const taskValues = await readColumn(weekly, table, taskColumn);
  const targetRows = table.rows.map((row) => ({
    row: row.index,
    okr: row.firstColumn,
    tasks: taskValues[row.index] || '',
    retro: retroValues[row.index] || '',
  }));
  const targetRow = validTargetRow(review.target_row, table.rows) ?? selectRetroReviewRow(targetRows);
  if (typeof targetRow !== 'number') throw new Error('Could not choose a target row for retro review writeback.');

  const text = clipReviewText(review.text);
  if (!text) throw new Error('Retro review text is empty.');
  const cellId = table.cellIds[targetRow][retroColumn];
  const existing = await readCellText(weekly, cellId);
  if (cellContainsItem(existing, text)) {
    return {
      ok: true,
      run_id: run.run_id,
      written: false,
      already_written: true,
      target_header: table.headers[taskColumn],
      retro_header: table.headers[retroColumn],
      target_row: targetRow,
    };
  }

  await appendReviewSection(weekly, cellId, text);
  return {
    ok: true,
    run_id: run.run_id,
    written: true,
    already_written: false,
    target_header: table.headers[taskColumn],
    retro_header: table.headers[retroColumn],
    target_row: targetRow,
    chars: text.length,
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
  const config = { user: {}, documents: { weekly: [] }, modes: {}, planning: {} };
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
    } else if (section[0] === 'planning' && section[1] === 'weekly_task_budget') {
      config.planning.weekly_task_budget ||= {};
      config.planning.weekly_task_budget[key] = value;
    } else if (section[0] === 'planning') {
      config.planning[key] = value;
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

function buildPlanningPolicy(config, tableRows, cycle = 'weekly') {
  const mode = String(config.planning?.workload_mode || 'normal').toLowerCase();
  const presets = {
    light: { min_total_items: 4, max_total_items: 6, min_okr_rows_touched: 3, p1: 3, p2: 2 },
    conservative: { min_total_items: 4, max_total_items: 6, min_okr_rows_touched: 3, p1: 3, p2: 2 },
    normal: { min_total_items: 6, max_total_items: 10, min_okr_rows_touched: 4, p1: 4, p2: 3 },
    ambitious: { min_total_items: 8, max_total_items: 12, min_okr_rows_touched: 5, p1: 6, p2: 4 },
  };
  const preset = presets[mode] || presets.normal;
  const configuredBudget = config.planning?.weekly_task_budget || {};
  const maxRows = Math.max(1, (tableRows || []).filter((row) => row.index > 0 && String(row.firstColumn || '').trim()).length);
  const minItems = clampNumber(config.planning?.min_total_items, preset.min_total_items, 1, 20);
  const maxItems = Math.max(minItems, clampNumber(config.planning?.max_total_items, preset.max_total_items, minItems, 24));
  const p1 = clampNumber(configuredBudget.p1, preset.p1, 0, maxItems);
  const p2 = clampNumber(configuredBudget.p2, preset.p2, 0, maxItems);
  // Biweekly plans cover two weeks, so scale the item budget (default 2x). MIT stays 1 per cycle.
  const multiplier = cycle === 'biweekly' ? biweeklyBudgetMultiplier(config) : 1;
  return {
    workload_mode: mode in presets ? mode : 'normal',
    cycle,
    budget_multiplier: multiplier,
    mit: clampNumber(configuredBudget.mit, 1, 1, 1),
    p1: Math.round(p1 * multiplier),
    p2: Math.round(p2 * multiplier),
    min_total_items: Math.round(minItems * multiplier),
    max_total_items: Math.round(maxItems * multiplier),
    min_okr_rows_touched: Math.min(maxRows, clampNumber(config.planning?.min_okr_rows_touched, preset.min_okr_rows_touched, 1, 20)),
    carryover_policy: String(config.planning?.carryover_policy || 'include_or_explain_internally'),
    hide_internal_reasoning: config.planning?.hide_internal_reasoning !== false,
    empty_row_placeholder: config.planning?.empty_row_placeholder ? String(config.planning.empty_row_placeholder) : '',
  };
}

function biweeklyBudgetMultiplier(config) {
  const raw = config.modes?.biweekly?.budget_multiplier;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 2;
}

function clampNumber(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
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

function findTaskHeaderForWeek(headers, label, week, taskSuffix) {
  const exact = findHeader(headers, label);
  if (exact >= 0) return exact;
  const targetStart = parseMonthDayLabel(week.label.split('-')[0]);
  const targetEnd = parseMonthDayLabel(week.label.split('-').slice(1).join('-'));
  if (!targetStart || !targetEnd) return -1;
  return headers.findIndex((header) => {
    const text = String(header || '');
    if (!text.includes(taskSuffix)) return false;
    const range = parseHeaderDateRange(text);
    if (!range) return false;
    return compareMonthDay(range.start, targetStart) <= 0 && compareMonthDay(range.end, targetEnd) >= 0;
  });
}

function findAdjacentRetro(headers, taskColumn, retroSuffix) {
  if (taskColumn < 0) return -1;
  const candidates = [taskColumn - 1, taskColumn + 1].filter((index) => index >= 0 && index < headers.length);
  return candidates.find((index) => headers[index].toLowerCase().includes(String(retroSuffix).toLowerCase())) ?? -1;
}

function normalizeHeader(value) {
  return String(value).replace(/\s+/g, '').toLowerCase();
}

function parseHeaderDateRange(header) {
  const match = String(header || '').match(/(\d{1,2})\s*[.月]\s*(\d{1,2})\s*[-~—–至到]\s*(?:(\d{1,2})\s*[.月])?\s*(\d{1,2})/);
  if (!match) return null;
  const start = { month: Number(match[1]), day: Number(match[2]) };
  const end = { month: Number(match[3] || match[1]), day: Number(match[4]) };
  return validMonthDay(start) && validMonthDay(end) ? { start, end } : null;
}

function parseMonthDayLabel(label) {
  const match = String(label || '').match(/(\d{1,2})\.(\d{1,2})/);
  if (!match) return null;
  const value = { month: Number(match[1]), day: Number(match[2]) };
  return validMonthDay(value) ? value : null;
}

function validMonthDay(value) {
  return value.month >= 1 && value.month <= 12 && value.day >= 1 && value.day <= 31;
}

function compareMonthDay(left, right) {
  return left.month === right.month ? left.day - right.day : left.month - right.month;
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
    ...(input.mode === 'biweekly'
      ? [
          `本次为双周（biweekly）模式：target_week（${input.targetWeek.label}）是一个两周区间，review_week（${input.reviewWeek.label}）是上两周。`,
          '请规划覆盖未来两周的要务，一次性写入这一个两周区间列，不要拆成两列或两次计划。',
          '复盘时按 modes/biweekly.md 增加双周趋势分析，识别周期性偏移；趋势章节只在草稿正文展示，不写入表格 retro 单元格。',
        ]
      : []),
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
        planning_policy: input.planningPolicy,
        user_text: input.userText,
        first_column_okr_rows: input.reviewRows.slice(1).map((row) => ({ row_index: row.row, okr: row.okr })),
        weekly_rows: input.reviewRows,
        target_week_rows: input.targetRows,
      },
      null,
      2,
    ),
    '',
    '# Daily OS context',
    '以下是 Daily OS 补充上下文，只能用于补充候选、校准任务量和识别实际投入；不能覆盖 Feishu 🐶 表格事实，也不能在最终用户可见输出中展示来源、证据名、row_index 或内部判断过程。',
    dailyOs,
    '',
    '# Output contract',
    `输出必须包含 "## 📊 上周执行对比（${input.reviewWeek.label}）" 和 "## 📋 下周计划（${input.targetWeek.label}）"。`,
    '下周计划里的每条要务必须对应或可追溯到第一列 🐶 重点OKR 的某一行。',
    `下周写回计划必须符合 planning_policy：总数尽量在 ${input.planningPolicy.min_total_items}-${input.planningPolicy.max_total_items} 条之间，最多 ${input.planningPolicy.mit} 个 MIT，尽量覆盖至少 ${input.planningPolicy.min_okr_rows_touched} 个 OKR 行。`,
    '如果 Feishu 上周未完成项不足以达到任务量，优先从 Daily OS context 中的 Linear、todo inbox、vault daily、recent daily memory 选择能挂到现有 OKR 行的候选；挂不上现有 OKR 行的事项不要进入 writeback_plan。',
    '最终用户可见正文只输出结果，不要写“来源/依据/我参考了/内部预算/row_index/debug”等解释；如有取舍，只体现在最终任务安排中。',
    '最后必须附一个 fenced JSON 代码块，格式为：',
    '```json',
    '{"retro_review":"写入目标周要务左侧相邻 retro 单元格底部的 review，350字以内","writeback_plan":[{"row_index":1,"row_label":"第一列 OKR 原文或稳定简称","text":"要写入该行的下周要务","is_mit":false}]}',
    '```',
    `retro_review 必须写给目标周 ${input.targetWeek.label} 的 retro；优先参考 target_week_rows 里同一 retro 单元格已有的状态、做得好、待改进，再参考相邻要务完成状态和 Daily OS context。`,
    'retro_review 只写复盘结论，不要写来源说明；长度必须控制在 350 个中文字符以内，固定两段：第一段是肯定的总结，第二段是待改进的总结。',
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
      timeout: 600000,
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
      timeout: 600000,
    });
    const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : res.stdout;
    fs.rmSync(out, { force: true });
    if (res.status !== 0) throw new Error(`Codex failed: ${(res.stderr || res.stdout).slice(0, 2000)}`);
    return text.trim();
  }
  throw new Error(`Unsupported provider: ${provider}`);
}

function deterministicDraft(reviewWeek, targetWeek, rows, planningPolicy = buildPlanningPolicy({}, rows), targetRows = []) {
  const completed = [];
  const unfinished = [];
  const writebackPlan = [];
  for (const row of rows.slice(1)) {
    for (const item of splitItems(row.tasks)) {
      if (/[✅]/.test(item)) completed.push(item);
      else if (/[⭕️❌🚧]/.test(item)) {
        unfinished.push(item);
        if (writebackPlan.length < planningPolicy.max_total_items) {
          writebackPlan.push({
            row_index: row.row,
            row_label: row.okr,
            text: item.replace(/[⭕️❌🚧]/g, '').trim() || item,
            is_mit: writebackPlan.length === 0 && planningPolicy.mit > 0,
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
    JSON.stringify({ retro_review: buildDeterministicRetroReview(targetRows, rows), writeback_plan: writebackPlan }, null, 2),
    '```',
  ].join('\n');
}

function extractReviewText(draft) {
  const blocks = [...String(draft).matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      const text = parsed?.retro_review || parsed?.review_text || parsed?.review;
      if (typeof text === 'string' && text.trim()) return clipReviewText(text);
    } catch {
      // Try the next JSON block.
    }
  }
  return '';
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

function applyPlanningBudget(items, reviewRows, tableRows, policy) {
  const maxItems = policy.max_total_items || 10;
  const minItems = policy.min_total_items || 6;
  const minRows = policy.min_okr_rows_touched || 1;
  const validRows = new Set(tableRows.slice(1).filter((row) => String(row.firstColumn || '').trim()).map((row) => row.index));
  const planned = [];
  const seen = new Set();

  const add = (item) => {
    const row = typeof item.target_row === 'number' ? item.target_row : null;
    if (!validRows.has(row)) return false;
    const text = cleanWritebackText(item.text);
    if (!text) return false;
    const key = `${row}:${comparableText(text)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    planned.push({
      ...item,
      text,
      target_row: row,
      target_row_label: item.target_row_label || tableRows[row]?.firstColumn?.slice(0, 120) || '',
      is_mit: Boolean(item.is_mit),
    });
    return true;
  };

  for (const item of items) {
    if (planned.length >= maxItems) break;
    add(item);
  }

  const carryovers = carryoverCandidates(reviewRows, tableRows);
  const touched = () => new Set(planned.map((item) => item.target_row)).size;
  for (const candidate of carryovers) {
    if (planned.length >= maxItems || touched() >= minRows) break;
    if (!planned.some((item) => item.target_row === candidate.target_row)) add(candidate);
  }
  for (const candidate of carryovers) {
    if (planned.length >= maxItems || planned.length >= minItems) break;
    add(candidate);
  }

  const mitIndex = planned.findIndex((item) => item.is_mit);
  planned.forEach((item, index) => {
    item.is_mit = index === (mitIndex >= 0 ? mitIndex : 0);
  });
  return planned.slice(0, maxItems);
}

function buildDeterministicRetroReview(targetRows = [], reviewRows = []) {
  const row = targetRows.find((candidate) => candidate.row > 0 && /状态|做得好|做的好|待改进|review|复盘/.test(candidate.retro || '')) ||
    targetRows.find((candidate) => candidate.row > 0 && String(candidate.retro || '').trim()) ||
    targetRows.find((candidate) => candidate.row > 0 && String(candidate.tasks || '').trim()) ||
    reviewRows.find((candidate) => candidate.row > 0 && String(candidate.tasks || candidate.retro || '').trim());
  if (!row) return '';

  const sections = extractRetroSections(row.retro || '');
  const taskSummary = summarizeTasks(row.tasks || '');
  let positive = sections.good ? `做得好的地方是${sections.good}` : '';
  if (!positive && taskSummary) positive = `从要务完成情况看，${taskSummary}`;
  if (!positive && sections.status) positive = `本周状态是${sections.status}`;
  if (!positive && row.okr) positive = `围绕${stripOkrText(row.okr)}，本周已经有了可以继续沉淀的主线。`;

  const improvement = sections.improve
    ? `需要改进的是${sections.improve}。下周先把未闭环事项写进固定时间块，并把复盘沉淀当成工作任务完成。`
    : '需要改进的是把未闭环事项写进固定时间块，并把复盘沉淀当成工作任务完成。';

  return clipReviewText([positive, improvement].filter(Boolean).join('\n\n'));
}

function extractRetroSections(text) {
  const normalized = String(text || '').replace(/\s*\/\s*/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim();
  return {
    status: clipSection(sectionAfter(normalized, /(?:😄\s*)?状态\s*[：:]?/, /(?:👍🏻?\s*)?做[得的]好\s*[：:]?|(?:💪🏻?\s*)?待改进\s*[：:]?|(?:^|\n)\s*(?:🧭\s*)?review/i), 90),
    good: clipSection(sectionAfter(normalized, /(?:👍🏻?\s*)?做[得的]好\s*[：:]?/, /(?:💪🏻?\s*)?待改进\s*[：:]?|(?:^|\n)\s*(?:🧭\s*)?review/i), 150),
    improve: clipSection(sectionAfter(normalized, /(?:💪🏻?\s*)?待改进\s*[：:]?/, /(?:^|\n)\s*(?:🧭\s*)?review/i), 140),
  };
}

function sectionAfter(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start < 0) return '';
  const afterStart = text.slice(start).replace(startPattern, '').trim();
  const end = afterStart.search(endPattern);
  return (end >= 0 ? afterStart.slice(0, end) : afterStart).trim();
}

function summarizeTasks(text) {
  const items = splitItems(text);
  const done = items.filter((item) => /✅/.test(item)).length;
  const open = items.filter((item) => /⭕|❌|🚧|未完成|待/.test(item)).length;
  if (done || open) return `已完成 ${done} 项，仍有 ${open} 项需要继续推进`;
  return items[0] ? `主要围绕${clipSection(cleanCarryoverTask(items[0]) || items[0], 80)}` : '';
}

function selectRetroReviewRow(targetRows = []) {
  const row =
    targetRows.find((candidate) => candidate.row > 0 && /状态|做得好|做的好|待改进|review|复盘/.test(candidate.retro || '')) ||
    targetRows.find((candidate) => candidate.row > 0 && String(candidate.retro || '').trim()) ||
    targetRows.find((candidate) => candidate.row > 0 && String(candidate.tasks || '').trim());
  return typeof row?.row === 'number' ? row.row : null;
}

function stripOkrText(text) {
  return clipSection(String(text || '').replace(/[•·]/g, ' ').replace(/\s+/g, ' ').trim(), 60);
}

function clipSection(value, limit) {
  const lines = String(value || '')
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && !/^(?:情绪|精力|外部压力|计划外吃掉时间的事)[：:]\s*$/.test(line));
  if (lines.length > 1) {
    const selected = [];
    for (const line of lines) {
      const candidate = [...selected, line].join(' ');
      if (candidate.length <= limit) {
        selected.push(line);
        continue;
      }
      if (selected.length === 0) selected.push(clipAtBoundary(line, limit));
      break;
    }
    return selected.join(' ').trim();
  }
  const text = (lines[0] || String(value || '')).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return clipAtBoundary(text, limit);
}

function clipAtBoundary(text, limit) {
  const punctuation = Math.max(text.lastIndexOf('。', limit), text.lastIndexOf('；', limit), text.lastIndexOf(';', limit), text.lastIndexOf('.', limit));
  if (punctuation >= Math.floor(limit * 0.45)) return text.slice(0, punctuation + 1).trim();
  const space = text.lastIndexOf(' ', limit);
  const cut = space >= Math.floor(limit * 0.45) ? space : limit;
  return text.slice(0, cut).replace(/[A-Za-z0-9_-]+$/, '').trim();
}

function clipReviewText(value) {
  const paragraphs = String(value || '')
    .replace(/^\s*review\s*[：:]?\s*/i, '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').replace(/([。；;,.，])\1+/g, '$1').trim())
    .filter(Boolean)
    .slice(0, 2);
  if (!paragraphs.length) return '';

  const firstLimit = paragraphs.length > 1 ? 160 : 350;
  const secondLimit = 350 - Math.min(paragraphs[0].length, firstLimit) - (paragraphs.length > 1 ? 2 : 0);
  const clipped = paragraphs.map((paragraph, index) => clipAtBoundary(paragraph, index === 0 ? firstLimit : Math.max(120, secondLimit)));
  let text = clipped.join('\n\n').trim();
  if (text.length > 350) text = `${clipAtBoundary(clipped[0], 150)}\n\n${clipAtBoundary(clipped[1] || '', 198)}`.trim();
  return text;
}

function carryoverCandidates(reviewRows, tableRows) {
  const out = [];
  for (const row of reviewRows.slice(1)) {
    if (!String(row.okr || '').trim()) continue;
    for (const raw of splitItems(row.tasks)) {
      if (!isCarryoverTask(raw)) continue;
      const text = cleanCarryoverTask(raw);
      if (!text) continue;
      out.push({
        text,
        heading: row.okr,
        is_mit: /MIT|🔴/i.test(raw),
        target_row: row.row,
        target_row_label: tableRows[row.row]?.firstColumn?.slice(0, 120) || row.okr.slice(0, 120),
      });
    }
  }
  return out;
}

function isCarryoverTask(value) {
  const text = String(value);
  if (!text.trim()) return false;
  if (/[✅]/.test(text) && !/[⭕❌🚧]/.test(text)) return false;
  return /[⭕❌🚧]|未完成|待完成|延续|follow[- ]?up|blocked|阻塞|继续|补齐|确认|完成|准备|整理|记录|推进|复盘|检查|更新|联系/.test(text);
}

function cleanCarryoverTask(value) {
  return cleanWritebackText(
    String(value)
      .replace(/[⭕️⭕❌🚧✅]/g, '')
      .replace(/（?延续上周[^）)]*[）)]?/g, '')
      .replace(/\bDoing-\d+%/gi, '')
      .trim(),
  );
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

async function appendReviewSection(weekly, cellId, reviewText) {
  const cell = await getBlock(weekly, cellId);
  const index = Array.isArray(cell.children) ? cell.children.length : 0;
  const childBlocks = await mapLimit(cell.children || [], 3, (child) => getBlock(weekly, child));
  const hasReviewHeading = childBlocks.some((child) => /(?:^|\s)(?:🧭\s*)?review(?:\s|$)/i.test(textFromBlock(child)));
  const paragraphs = reviewParagraphs(reviewText);
  if (!hasReviewHeading) {
    await postText(weekly, cellId, 'review', index);
    for (const [offset, paragraph] of paragraphs.entries()) await postText(weekly, cellId, paragraph, index + 1 + offset);
    return;
  }
  for (const [offset, paragraph] of paragraphs.entries()) await postText(weekly, cellId, paragraph, index + offset);
}

function reviewParagraphs(reviewText) {
  return String(reviewText || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 2);
}

async function postText(weekly, cellId, content, index = 0) {
  await larkApi('POST', `/open-apis/docx/v1/documents/${weekly.token}/blocks/${cellId}/children`, {
    children: [{ block_type: 2, text: { elements: [{ text_run: { content } }], style: {} } }],
    index,
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

function cycleDays(cycle) {
  return cycle === 'biweekly' ? 14 : 7;
}

function resolveCycle(config, mode) {
  const requested = String(mode || config.planning?.todo_cycle || 'weekly').toLowerCase();
  if (requested === 'weekly' || requested === 'biweekly') return requested;
  throw new Error(`Unsupported todo cycle: ${requested}. Only weekly and biweekly are implemented in the CLI bridge.`);
}

function modeArgProvided() {
  return positionalArgs().length >= 2;
}

function cycleRange(date, cycle = 'weekly') {
  const span = cycleDays(cycle);
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  const end = new Date(monday);
  end.setUTCDate(monday.getUTCDate() + span - 1);
  const start = monday.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);
  return { start, end: endDate, label: `${monday.getUTCMonth() + 1}.${monday.getUTCDate()}-${end.getUTCMonth() + 1}.${end.getUTCDate()}` };
}

function previousCycle(start, cycle = 'weekly') {
  return cycleRange(addDays(start, -cycleDays(cycle)), cycle);
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
  console.log('Usage: life-review-os run [weekly|biweekly] --json [--provider claude|codex|none]');
  console.log('       life-review-os preview --run-id <id> --json');
  console.log('       life-review-os writeback --run-id <id> --json');
  console.log('       life-review-os write-review --run-id <id> --json');
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
