import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWeeklyPrompt } from '../bin/life-review-os.mjs';

/**
 * LEO-279 — the retro the user hand-writes in Daily OS's Cycles page has to
 * reach the planning prompt.
 *
 * Before this, the prompt told the model to prefer `weekly_rows` (the Feishu
 * retro cell) and, separately, that Daily OS context "不能覆盖 Feishu 🐶 表格事实".
 * Together those two lines mean a user who moved their retro into the local UI
 * gets a review of a cycle the planner believes was never written up.
 *
 * The second half of the contract is positional and lives on the Daily OS side:
 * only the first 20,000 characters of the input pack are read. That cut is
 * asserted here too, because it is the reason the block has to be emitted near
 * the top of the pack rather than wherever is convenient.
 */

const RETRO_MARKER = '口播连续两周挂零，是执行力问题不是外部原因';
const CUT = 20000;

function packWith(block, padding = 0) {
  return [
    '# Daily OS Skill Input Pack',
    '',
    '## Local OKR Chain',
    'x'.repeat(padding),
    '',
    block,
    '',
    '## Latest Workflow',
    '(none)',
  ].join('\n');
}

const LOCAL_RETRO_BLOCK = [
  '## Local Cycle Retro',
  '用户在本地 Cycles 页手写的 retro，按周期倒序。**这是 retro 的权威来源**：用户现在在这里写复盘，飞书的 retro 单元格可能为空或过时。',
  '',
  '### 6.23-7.6（biweekly · 更新于 2026-07-07）',
  '😄状态',
  '情绪：正常',
  '👍🏻做的好',
  '搬家和 Duolingo 都收尾了',
  '💪🏻待改进',
  RETRO_MARKER,
].join('\n');

const CREATED = [];
function tempPack(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lros-retro-'));
  CREATED.push(dir);
  const file = path.join(dir, 'pack.md');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

process.on('exit', () => {
  for (const dir of CREATED) fs.rmSync(dir, { recursive: true, force: true });
});

/** Feishu's own retro cell is deliberately empty: that is the case that broke. */
function promptInput(dailyOsInputPath, feishuRetro = '') {
  return {
    config: {},
    weekly: {},
    mode: 'biweekly',
    userText: '',
    dailyOsInputPath,
    planningPolicy: { min_total_items: 12, max_total_items: 20, mit: 1, min_okr_rows_touched: 3 },
    targetWeek: { label: '7.7-7.20' },
    reviewWeek: { label: '6.23-7.6' },
    reviewRows: [
      { row: 0, okr: 'OKR', tasks: '', retro: '' },
      { row: 1, okr: 'O1 重点', tasks: '', retro: feishuRetro },
    ],
    targetRows: [{ row: 0, okr: 'OKR', tasks: '', retro: '' }],
  };
}

test('a locally written retro reaches the prompt even when the Feishu cell is empty', () => {
  const prompt = buildWeeklyPrompt(promptInput(tempPack(packWith(LOCAL_RETRO_BLOCK))));
  assert.match(prompt, /## Local Cycle Retro/, 'the block is carried into the prompt');
  assert.ok(prompt.includes(RETRO_MARKER), 'the retro body itself is carried, not just the heading');
});

test('the prompt tells the model the local retro outranks the Feishu cell', () => {
  const prompt = buildWeeklyPrompt(promptInput(tempPack(packWith(LOCAL_RETRO_BLOCK))));
  assert.match(prompt, /唯一例外是「Local Cycle Retro」段落/, 'the blanket "cannot override Feishu" rule needs an explicit carve-out');
  assert.match(prompt, /Local Cycle Retro」里 6\.23-7\.6 这一段/, 'the retro_review contract names the reviewed cycle');
});

test('the retro_review contract still puts the Feishu cell second, not nowhere', () => {
  const prompt = buildWeeklyPrompt(promptInput(tempPack(packWith(LOCAL_RETRO_BLOCK)), '飞书上的旧稿'));
  assert.match(prompt, /weekly_rows 里同一 retro 单元格已有的状态/, 'the Feishu cell remains a listed source');
  const local = prompt.indexOf('Local Cycle Retro」里');
  const feishu = prompt.indexOf('weekly_rows 里同一 retro 单元格');
  assert.ok(local >= 0 && feishu > local, 'and it is listed after the local one');
});

test('an empty Feishu cell must not be read as "the user did not review"', () => {
  const prompt = buildWeeklyPrompt(promptInput(tempPack(packWith(LOCAL_RETRO_BLOCK))));
  assert.match(prompt, /不要因为②为空就当作用户没有复盘/);
});

test('a block past the 20,000 cut never reaches the prompt', () => {
  // The whole reason Daily OS emits this block near the top of the pack. The
  // cycle files were already in the pack before LEO-279 — inside the Memory
  // Repository Files dump, around offset 59k — and were read exactly never.
  const file = tempPack(packWith(LOCAL_RETRO_BLOCK, CUT + 1000));
  assert.ok(fs.readFileSync(file, 'utf8').indexOf('## Local Cycle Retro') > CUT, 'fixture really is past the cut');

  const prompt = buildWeeklyPrompt(promptInput(file));
  assert.ok(!prompt.includes(RETRO_MARKER), 'a retro past the cut is silently dropped');
  // The instructions still reference the block, which is exactly how this failed
  // quietly: the contract talks about a section the model cannot see.
  assert.match(prompt, /Local Cycle Retro/, 'the contract text is unconditional');
});

test('no Daily OS pack at all still produces a usable prompt', () => {
  const prompt = buildWeeklyPrompt(promptInput(''));
  assert.match(prompt, /writeback_plan/, 'the rest of the contract is unaffected');
  assert.match(prompt, /retro_review/);
});
