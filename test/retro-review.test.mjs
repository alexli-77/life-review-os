import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunReview, selectRetroReviewRow } from '../bin/life-review-os.mjs';

/**
 * Step 4.5 of engine/04-write.md (SKILL.md hard constraint #10) writes a
 * `review` section into the retro cell beside the target priorities column.
 * It shipped in #12 and had never written a single one: the Feishu doc contains
 * zero `review` blocks.
 *
 * `ready` was computed at run time as
 *
 *     targetTaskColumn >= 0 && targetRetroColumn >= 0 && typeof row === 'number' && text
 *
 * but for a new cycle the target columns do not exist yet — that is precisely
 * why the write-back action is `insert_columns`. So `ready` was false every
 * time, and writeReviewRun's own guard refused the very call that would have
 * created them. The flag asked about the table before write-back; the write
 * happens after it.
 */

const TEXT = '第一段：本双周 MIT 完成率 100%。\n\n第二段：投递验证仍未开工。';

test('a new cycle is ready: the target columns do not exist yet by design', () => {
  const review = buildRunReview({ targetTaskHeader: '8.24-9.6 要务', targetRetroHeader: null, targetRow: null, text: TEXT });
  assert.equal(review.ready, true, 'this is the exact shape that used to be blocked');
});

test('readiness tracks the text, which is the only thing settled at run time', () => {
  const ready = (text) => buildRunReview({ targetTaskHeader: 'H', targetRetroHeader: 'R', targetRow: 3, text }).ready;
  // Whitespace-only would otherwise pass here and fail deep inside
  // writeReviewRun with "Retro review text is empty".
  for (const empty of ['', null, undefined, '   ', '\n\n']) {
    assert.equal(ready(empty), false, `must not be ready: ${JSON.stringify(empty)}`);
  }
  assert.equal(ready(TEXT), true);
});

test('the resolved headers and row are kept as hints for write time', () => {
  const review = buildRunReview({ targetTaskHeader: '8.24-9.6 要务', targetRetroHeader: '8.24-9.6 retro', targetRow: 2, text: TEXT });
  assert.equal(review.target_task_header, '8.24-9.6 要务');
  assert.equal(review.target_retro_header, '8.24-9.6 retro');
  assert.equal(review.target_row, 2);
  assert.equal(review.text, TEXT);
});

test('selectRetroReviewRow prefers a row whose retro already has the usual headings', () => {
  const rows = [
    { row: 0, retro: '', tasks: '' },
    { row: 1, retro: '', tasks: '有要务' },
    { row: 2, retro: '状态：还行\n做得好：交付了', tasks: '' },
  ];
  assert.equal(selectRetroReviewRow(rows), 2);
});

test('it falls back to any non-empty retro, then to any non-empty tasks', () => {
  assert.equal(selectRetroReviewRow([{ row: 0, retro: '', tasks: '' }, { row: 1, retro: '随便写的', tasks: '' }]), 1);
  assert.equal(selectRetroReviewRow([{ row: 0, retro: '', tasks: '' }, { row: 3, retro: '', tasks: '有要务' }]), 3);
});

test('an all-empty target column yields no row — write time resolves it instead', () => {
  // This is the state of a freshly inserted column, and it must not be treated
  // as a failure at run time.
  const rows = [{ row: 0, retro: '', tasks: '' }, { row: 1, retro: '', tasks: '' }];
  assert.equal(selectRetroReviewRow(rows), null);
  assert.equal(buildRunReview({ targetTaskHeader: 'H', targetRetroHeader: null, targetRow: null, text: TEXT }).ready, true);
});

test('row 0 is never chosen: it is the header row', () => {
  assert.equal(selectRetroReviewRow([{ row: 0, retro: '状态：x', tasks: 'y' }]), null);
});
