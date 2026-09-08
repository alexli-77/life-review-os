import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCycleReviewPrompt, stripReviewWrapping, buildWeeklyPrompt, RETRO_REVIEW_STYLE } from '../bin/life-review-os.mjs';

/**
 * `review-cycle` drafts the review for one already-finished cycle from content
 * the caller hands over, with no Feishu read and no re-planning.
 *
 * It exists because Daily OS keeps the same three sections in a local cycle
 * file and wants a review for one of them on demand. The thing worth guarding
 * is that it stays the *same* review: one style contract, shared with the full
 * weekly prompt, so the two cannot drift into producing differently shaped
 * reviews for the same person.
 */

const INPUT = {
  cycle: '8.24-9.6',
  mode: 'biweekly',
  priorities: '### 工作 · 技术专家\n- 发起至少 5 家目标公司内推 **MIT**',
  retro: '😄状态\n情绪：正常\n👍🏻做的好\nMIT 按时完成\n💪🏻待改进\n口播还是 0 条',
};

test('the prompt carries the cycle, the plan and the hand-written retro', () => {
  const prompt = buildCycleReviewPrompt(INPUT);
  assert.match(prompt, /cycle: 8\.24-9\.6/);
  assert.match(prompt, /mode: biweekly/);
  assert.ok(prompt.includes('发起至少 5 家目标公司内推'), 'the plan is in the prompt');
  assert.ok(prompt.includes('口播还是 0 条'), 'the retro is in the prompt');
});

test('the hand-written retro is presented as the authoritative account', () => {
  const prompt = buildCycleReviewPrompt(INPUT);
  assert.match(prompt, /用户手写，权威/);
  assert.match(prompt, /以用户手写的 retro 为事实基础/);
});

test('the style contract is the same object the weekly prompt uses', () => {
  const cycle = buildCycleReviewPrompt(INPUT);
  assert.ok(cycle.includes(RETRO_REVIEW_STYLE), 'review-cycle uses the shared contract');
  const weekly = buildWeeklyPrompt({
    config: {}, weekly: {}, mode: 'biweekly', userText: '', dailyOsInputPath: '',
    planningPolicy: { min_total_items: 12, max_total_items: 20, mit: 1, min_okr_rows_touched: 3 },
    targetWeek: { label: '9.7-9.20' }, reviewWeek: { label: '8.24-9.6' },
    reviewRows: [{ row: 0, okr: 'OKR', tasks: '', retro: '' }],
    targetRows: [{ row: 0, okr: 'OKR', tasks: '', retro: '' }],
  });
  assert.ok(weekly.includes(RETRO_REVIEW_STYLE), 'and so does the full weekly prompt');
  assert.match(RETRO_REVIEW_STYLE, /350 个中文字符以内/);
  assert.match(RETRO_REVIEW_STYLE, /固定两段/);
});

test('the SKILL constraints and the analysis rules are both included', () => {
  const prompt = buildCycleReviewPrompt(INPUT);
  assert.match(prompt, /# Skill/);
  assert.match(prompt, /# Analysis Rules/);
  assert.match(prompt, /Feishu Weekly 硬约束/, 'the skill section really loaded');
});

test('a cycle with no retro says so instead of inviting invention', () => {
  const prompt = buildCycleReviewPrompt({ ...INPUT, retro: '' });
  assert.match(prompt, /用户还没写 retro/);
  assert.match(prompt, /不要编造完成情况/);
  assert.ok(!prompt.includes('以用户手写的 retro 为事实基础'), 'the with-retro instruction is not emitted');
});

test('a cycle with no priorities is described, not left blank', () => {
  const prompt = buildCycleReviewPrompt({ ...INPUT, priorities: '' });
  assert.match(prompt, /这个周期没有记录要务/);
});

test('optional extra context is included only when given', () => {
  assert.ok(!buildCycleReviewPrompt(INPUT).includes('## 补充上下文'));
  assert.match(buildCycleReviewPrompt({ ...INPUT, context: 'Linear 关了 3 个 issue' }), /## 补充上下文\nLinear 关了 3 个 issue/);
});

test('the prompt asks for bare prose, no fence and no heading', () => {
  const prompt = buildCycleReviewPrompt(INPUT);
  assert.match(prompt, /只输出 review 正文本身/);
  assert.match(prompt, /不要写「review：」这样的前缀/);
});

// --- cleaning what the provider actually returns -------------------------------

test('a fenced answer is unwrapped', () => {
  assert.equal(stripReviewWrapping('```\n本双周 MIT 完成。\n```'), '本双周 MIT 完成。');
  assert.equal(stripReviewWrapping('```markdown\n本双周 MIT 完成。\n```'), '本双周 MIT 完成。');
});

test('a leading label is stripped, in either language', () => {
  assert.equal(stripReviewWrapping('review: 完成率高。'), '完成率高。');
  assert.equal(stripReviewWrapping('retro_review：完成率高。'), '完成率高。');
  assert.equal(stripReviewWrapping('## 复盘：完成率高。'), '完成率高。');
});

test('prose that merely mentions review is left alone', () => {
  const text = '本双周完成率高，下周期要把 review 机制固定下来。';
  assert.equal(stripReviewWrapping(text), text);
});

test('empty and nullish input do not throw', () => {
  assert.equal(stripReviewWrapping(''), '');
  assert.equal(stripReviewWrapping(null), '');
  assert.equal(stripReviewWrapping(undefined), '');
});
