import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCycleReviewPrompt, stripReviewWrapping, buildWeeklyPrompt, RETRO_REVIEW_STYLE, retroReviewStyle } from '../bin/life-review-os.mjs';

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

test('the style contract is the same one the weekly prompt uses', () => {
  const cycle = buildCycleReviewPrompt(INPUT);
  assert.ok(cycle.includes(retroReviewStyle()), 'review-cycle uses the shared contract');
  const weekly = buildWeeklyPrompt({
    config: {}, weekly: {}, mode: 'biweekly', userText: '', dailyOsInputPath: '',
    planningPolicy: { min_total_items: 12, max_total_items: 20, mit: 1, min_okr_rows_touched: 3 },
    targetWeek: { label: '9.7-9.20' }, reviewWeek: { label: '8.24-9.6' },
    reviewRows: [{ row: 0, okr: 'OKR', tasks: '', retro: '' }],
    targetRows: [{ row: 0, okr: 'OKR', tasks: '', retro: '' }],
  });
  assert.ok(weekly.includes(retroReviewStyle()), 'and so does the full weekly prompt');
  assert.match(retroReviewStyle(), /350 个中文字符以内/);
  assert.match(retroReviewStyle(), /固定两段/);
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

// --- the CLI itself, as a subprocess -------------------------------------------
//
// Importing this module never calls main(), so every test above runs against a
// fully evaluated module. The CLI does not: main() is async, an async function
// runs synchronously up to its first `await`, and review-cycle builds its whole
// prompt before awaiting anything. That combination read a `const` declared
// further down the file and threw a TDZ ReferenceError on every invocation,
// while all thirteen tests above passed. Only running the binary catches it.

test('the review-cycle command runs far enough to reach the provider', async () => {
  const { spawnSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'life-review-os.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lros-cli-')), 'input.json');
  fs.writeFileSync(file, JSON.stringify(INPUT), 'utf8');

  // `none` is not a provider this command supports, which is the point: the
  // prompt has to have been built for that message to be the one we get.
  const result = spawnSync(process.execPath, [cli, 'review-cycle', '--input', file, '--provider', 'none', '--json'], { encoding: 'utf8' });
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.ok, false);
  assert.match(payload.error, /Unsupported provider/, payload.error);
  assert.doesNotMatch(payload.error, /before initialization|is not defined|ReferenceError/, 'the module must be fully evaluated before main() runs');
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('the command reports a missing input file instead of crashing', async () => {
  const { spawnSync } = await import('node:child_process');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'life-review-os.mjs');

  const result = spawnSync(process.execPath, [cli, 'review-cycle', '--input', '/tmp/does-not-exist-xyz.json', '--json'], { encoding: 'utf8' });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /ENOENT|no such file/i, payload.error);
});

// --- the editable contract file ------------------------------------------------

test('the shipped file and the built-in fallback say the same thing', () => {
  // If these ever drift, editing the file and deleting the file produce
  // different reviews, and only one of them is the documented behaviour.
  assert.equal(retroReviewStyle(), RETRO_REVIEW_STYLE);
});

test('only the text after the CONTRACT marker reaches the model', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', '08-retro-review.md');
  const raw = fs.readFileSync(file, 'utf8');

  assert.match(raw, /<!-- CONTRACT -->/, 'the file keeps its marker');
  assert.ok(raw.includes('编辑注意'), 'the editing guidance is in the file');
  assert.ok(!retroReviewStyle().includes('编辑注意'), 'but never in the prompt');
  assert.ok(!buildCycleReviewPrompt(INPUT).includes('编辑注意'), 'nor in the built prompt');
});

test('a missing or emptied contract file falls back instead of dropping the rules', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', '08-retro-review.md');
  const original = fs.readFileSync(file, 'utf8');
  try {
    // Emptied: someone selected all and deleted in the console editor.
    fs.writeFileSync(file, '   \n\n', 'utf8');
    assert.equal(retroReviewStyle(), RETRO_REVIEW_STYLE, 'an empty file must not mean "no length or shape contract"');

    // Preamble kept, contract removed.
    fs.writeFileSync(file, '# 说明\n随便写点什么\n\n<!-- CONTRACT -->\n\n', 'utf8');
    assert.equal(retroReviewStyle(), RETRO_REVIEW_STYLE);

    // Gone entirely.
    fs.rmSync(file);
    assert.equal(retroReviewStyle(), RETRO_REVIEW_STYLE);

    // A real edit is honoured, and it is the only thing in the prompt.
    fs.writeFileSync(file, '<!-- CONTRACT -->\nreview 写成一段，不超过 100 字。\n', 'utf8');
    assert.equal(retroReviewStyle(), 'review 写成一段，不超过 100 字。');
    assert.ok(buildCycleReviewPrompt(INPUT).includes('review 写成一段，不超过 100 字。'));
    assert.ok(!buildCycleReviewPrompt(INPUT).includes(RETRO_REVIEW_STYLE), 'the edited contract replaces the default, not joins it');

    // No marker at all: take the file whole rather than falling back, so a user
    // who deleted the preamble still gets what they wrote.
    fs.writeFileSync(file, '就写两句话。\n', 'utf8');
    assert.equal(retroReviewStyle(), '就写两句话。');
  } finally {
    fs.writeFileSync(file, original, 'utf8');
  }
  assert.equal(retroReviewStyle(), RETRO_REVIEW_STYLE, 'the shipped file is restored');
});
