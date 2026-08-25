import test from 'node:test';
import assert from 'node:assert/strict';
import { splitItems, carryoverCandidates, extractWritebackItems } from '../bin/life-review-os.mjs';

/**
 * readCellText used to join a cell's child blocks with ' / ' and splitItems
 * split back on the same string — a round-trip that is lossy for any item
 * containing ' / ' itself.
 *
 * The observed damage, from one real priority:
 *
 *   完成三条路径 yes/no 决策文档（PhD / AI 工程求职 / 过渡现金流…） MIT ✅
 *
 * became three fragments. The first was truncated mid-sentence at "（PhD", and
 * the ✅ ended up on the third — so the completion filter never saw it and a
 * finished task was carried into the next cycle as unfinished.
 */

const DONE = '完成三条路径 yes/no 决策文档（PhD / AI 工程求职 / 过渡现金流评分、证据、最终选择和不做清单） MIT ✅';
const OPEN = '完成 1 页 AI Agent 研究方向与职业可行性分析 (LEO-98) ⭕️';

test('an item containing " / " survives the round-trip intact', () => {
  assert.deepEqual(splitItems(DONE), [DONE]);
});

test('one line per item is still split into separate items', () => {
  assert.deepEqual(splitItems(`${DONE}\n${OPEN}`), [DONE, OPEN]);
});

test('ASCII semicolons still separate, blank lines are dropped', () => {
  assert.deepEqual(splitItems('甲;乙\n\n丙'), ['甲', '乙', '丙']);
  // Full-width ；is not a delimiter, and never was — it is ordinary punctuation
  // inside a Chinese sentence, so splitting on it would shred items.
  assert.deepEqual(splitItems('先做甲；再做乙'), ['先做甲；再做乙']);
});

const rows = [
  { row: 0, okr: 'OKR', tasks: '' },
  { row: 1, okr: 'O1 求职', tasks: `${DONE}\n${OPEN}` },
];
const tableRows = [{ index: 0, firstColumn: 'OKR' }, { index: 1, firstColumn: 'O1 求职' }];

test('a ✅ item is not carried over, and the open one keeps its full text', () => {
  const carried = carryoverCandidates(rows, tableRows);
  assert.equal(carried.length, 1, 'only the unfinished item may carry over');
  assert.match(carried[0].text, /AI Agent 研究方向/);
  assert.ok(!carried[0].text.includes('三条路径'), 'the completed item must not reappear');
});

test('no carried item is a fragment cut at a slash', () => {
  for (const item of carryoverCandidates(rows, tableRows)) {
    assert.ok(!/（[^）]*$/.test(item.text), `unbalanced bracket means a mid-sentence cut: ${item.text}`);
  }
});

test('the model plan is not capped below a biweekly cycle budget', () => {
  // min_total_items for biweekly is 12; a hard slice(0, 10) here dropped the
  // model's own last items and the shortfall was refilled from the old column.
  const plan = Array.from({ length: 12 }, (_, index) => ({ row_index: 1, text: `要务 ${index + 1}`, is_mit: index === 0 }));
  const draft = ['正文', '```json', JSON.stringify({ retro_review: 'r', writeback_plan: plan }), '```'].join('\n');
  const items = extractWritebackItems(draft);
  assert.equal(items.length, 12);
  assert.equal(items[11].text, '要务 12');
});

test('a plan item that really does chain tasks with slashes is still split', () => {
  // splitWritebackItem keeps that behaviour for model-authored text, gated on
  // each segment looking like the start of a task.
  const plan = [{ row_index: 1, text: '完成简历初稿 / 整理作品集首页 / 联系 2 位内推人', is_mit: false }];
  const draft = ['```json', JSON.stringify({ writeback_plan: plan }), '```'].join('\n');
  const items = extractWritebackItems(draft);
  assert.ok(items.length > 1, 'chained tasks should still separate');
  assert.ok(items.every((item) => item.text.trim().length > 0));
});

test('a parenthetical enumeration in a plan item is not split apart', () => {
  const plan = [{ row_index: 1, text: '输出决策文档（PhD / AI 工程求职 / 过渡现金流）', is_mit: false }];
  const draft = ['```json', JSON.stringify({ writeback_plan: plan }), '```'].join('\n');
  const [item] = extractWritebackItems(draft);
  assert.match(item.text, /过渡现金流/, 'the enumeration must stay with its item');
});
