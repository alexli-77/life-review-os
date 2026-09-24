import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readCycleContext, gatherFromCycleContext, weeklyMeta, normalizeCycleTasks, buildWeeklyPrompt } from '../bin/life-review-os.mjs';

/**
 * cycle_context — the local-md replacement for reading the Feishu weekly table.
 *
 * Daily OS builds the OKR rows and the previous/target cycle 要务/retro from the
 * user's own vault and drops them into the input pack as a `## Cycle Context`
 * JSON block. When it's there the run reads it and never touches Feishu (no
 * token); when it isn't, readCycleContext returns null and the run falls back to
 * the table. These tests pin the parse, the null cases, and that the normalized
 * evidence feeds the planner the same shape the table path always did.
 */

const CREATED = [];
process.on('exit', () => {
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
});

function tempPack(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lros-cc-'));
  CREATED.push(dir);
  const file = path.join(dir, 'pack.md');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

const CONTEXT = {
  schema: 1,
  mode: 'biweekly',
  reviewWeek: { label: '6.23-7.6', start: '2026-06-23', end: '2026-07-06' },
  targetWeek: { label: '7.7-7.20', start: '2026-07-07', end: '2026-07-20' },
  okrRows: [
    { row_index: 1, okr: '工作 · 技术专家' },
    { row_index: 2, okr: '金钱 · 家庭理财规划师' },
  ],
  reviewRows: [
    { row: 1, okr: '工作 · 技术专家', tasks: '- 完成简历 (LEO-93)\n- 更新 LinkedIn' },
    { row: 2, okr: '金钱 · 家庭理财规划师', tasks: '' },
  ],
  reviewRetro: '上期复盘：口播挂零',
  targetRows: [
    { row: 1, okr: '工作 · 技术专家', tasks: '- 本期已有要务' },
    { row: 2, okr: '金钱 · 家庭理财规划师', tasks: '' },
  ],
};

function packWith(block) {
  return ['# Daily OS Skill Input Pack', '', '## Local OKR Chain', '(chain)', '', block, '', '## Latest Workflow', '(none)'].join('\n');
}

function contextBlock(context) {
  return ['## Cycle Context', '本地推导的结构化周期上下文。', '```json', JSON.stringify(context), '```'].join('\n');
}

test('reads the Cycle Context JSON out of the pack', () => {
  const parsed = readCycleContext(tempPack(packWith(contextBlock(CONTEXT))));
  assert.ok(parsed, 'block is found and parsed');
  assert.equal(parsed.targetWeek.label, '7.7-7.20');
  assert.equal(parsed.okrRows.length, 2);
});

test('missing block, placeholder, and bad JSON all read as null (Feishu fallback)', () => {
  assert.equal(readCycleContext(tempPack(packWith('## Cycle Context\n(no local cycle context)'))), null, 'placeholder → null');
  assert.equal(readCycleContext(tempPack(packWith('## Local Cycle Retro\nx'))), null, 'no block → null');
  assert.equal(readCycleContext(tempPack(packWith('## Cycle Context\n```json\n{not json}\n```'))), null, 'bad JSON → null');
  assert.equal(readCycleContext(tempPack(packWith('## Cycle Context\n```json\n{"schema":1,"okrRows":[]}\n```'))), null, 'empty okrRows → null');
  assert.equal(readCycleContext(''), null, 'no pack path → null');
});

test('gatherFromCycleContext mirrors the table shape the planner expects', () => {
  const evidence = gatherFromCycleContext({ documents: { weekly: [] } }, CONTEXT, 'biweekly');

  // tableRows: header at 0, then one row per OKR, index aligned to row_index.
  assert.deepEqual(evidence.tableRows, [
    { index: 0, firstColumn: '' },
    { index: 1, firstColumn: '工作 · 技术专家' },
    { index: 2, firstColumn: '金钱 · 家庭理财规划师' },
  ]);
  // reviewRows/targetRows: header-prefixed, bullets stripped to plain lines.
  assert.equal(evidence.reviewRows[0].row, 0, 'index 0 is the header row');
  assert.equal(evidence.reviewRows[1].tasks, '完成简历 (LEO-93)\n更新 LinkedIn', 'bullet markers stripped, Linear id kept');
  assert.equal(evidence.targetRows[1].tasks, '本期已有要务');
  assert.equal(evidence.reviewRows[2].tasks, '', 'a row with no plan is empty, not a placeholder');

  // Weeks come straight from the context, no Feishu columns exist.
  assert.equal(evidence.targetWeek.label, '7.7-7.20');
  assert.equal(evidence.reviewWeek.label, '6.23-7.6');
  assert.equal(evidence.evTargetTaskHeader, null);
  assert.equal(evidence.writebackAction, 'insert_columns');
});

test('weeklyMeta yields header suffixes without demanding a Feishu token', () => {
  const meta = weeklyMeta({ documents: { weekly: [{ year: 2026, task_header_suffix: '要务', retro_header_suffix: 'retro' }] } }, '2026-07-07');
  assert.equal(meta.year, 2026);
  assert.equal(meta.taskHeaderSuffix, '要务');
  // No token/table_block_id present, yet this does not throw (weeklyTarget would).
  const bare = weeklyMeta({}, '2026-07-07');
  assert.equal(bare.taskHeaderSuffix, '要务');
  assert.equal(bare.year, 2026);
});

test('normalizeCycleTasks strips list markers and blank lines', () => {
  assert.equal(normalizeCycleTasks('- a\n* b\n\n  - c '), 'a\nb\nc');
  assert.equal(normalizeCycleTasks(''), '');
});

test('the prompt built from local context calls the data local, not Feishu', () => {
  const evidence = gatherFromCycleContext({ documents: { weekly: [] } }, CONTEXT, 'biweekly');
  const prompt = buildWeeklyPrompt({
    config: {},
    weekly: evidence.weekly,
    mode: 'biweekly',
    userText: '',
    dailyOsInputPath: '',
    planningPolicy: { min_total_items: 12, max_total_items: 20, mit: 1, min_okr_rows_touched: 3 },
    targetWeek: evidence.targetWeek,
    reviewWeek: evidence.reviewWeek,
    reviewRows: evidence.reviewRows,
    targetRows: evidence.targetRows,
    linearCoverage: {},
    evidenceSource: 'local',
  });
  assert.match(prompt, /本地周期数据（20_CYCLES \/ 10_OKR）/, 'authority line names the local source');
  assert.ok(!/必须使用下面 Feishu 表格的结构化数据/.test(prompt), 'it does not claim the facts came from Feishu');
});
