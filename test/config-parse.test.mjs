import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfigYaml, weeklyTarget, taskTextElements } from '../bin/life-review-os.mjs';

/**
 * parseConfigYaml used to build its result from a hard-coded four-section
 * whitelist, so any other top-level block was parsed and dropped. `linear` was
 * one of them: the workspace slug sat in config.yaml while weeklyTarget read
 * `config.linear?.workspace` as undefined, and every issue id written back to
 * Feishu silently stayed plain text instead of becoming a link.
 */

const CONFIG = `
user:
  name: 大汪汪
  symbol: 🐶
  timezone: America/Toronto

framework: stephen-covey

documents:
  weekly:
    - year: 2026
      token: doccnFAKE2026
      table_block_id: BLOCK2026
    - year: 2025
      token: doccnFAKE2025

vault:
  enabled: false
  path: ""
  watch_list: 99_Meta/watch-list.md
  api:
    enabled: true
    base_url_env: VAULT_GATE_URL

planning:
  workload_mode: normal
  min_total_items: 6
  empty_row_placeholder: "本周期无安排"
  weekly_task_budget:
    mit: 1
    p1: 4

modes:
  biweekly:
    lookback_weeks: 4
    auto_write: true

linear:
  workspace: leon-os
`;

test('parseConfigYaml reads the linear section (was silently dropped)', () => {
  const config = parseConfigYaml(CONFIG);
  assert.deepEqual(config.linear, { workspace: 'leon-os' });
});

test('parseConfigYaml reads the vault section, including its nested api block', () => {
  const config = parseConfigYaml(CONFIG);
  assert.equal(config.vault.enabled, false);
  assert.equal(config.vault.watch_list, '99_Meta/watch-list.md');
  assert.deepEqual(config.vault.api, { enabled: true, base_url_env: 'VAULT_GATE_URL' });
});

test('a top-level scalar lands at the top level, not inside the preceding block', () => {
  const config = parseConfigYaml(CONFIG);
  assert.equal(config.framework, 'stephen-covey');
  assert.equal(config.user.framework, undefined, 'framework must not leak into the user block');
  assert.deepEqual(config.user, { name: '大汪汪', symbol: '🐶', timezone: 'America/Toronto' });
});

test('the previously-parsed sections are unchanged', () => {
  const config = parseConfigYaml(CONFIG);
  assert.equal(config.planning.workload_mode, 'normal');
  assert.equal(config.planning.min_total_items, 6);
  assert.equal(config.planning.empty_row_placeholder, '本周期无安排');
  assert.deepEqual(config.planning.weekly_task_budget, { mit: 1, p1: 4 });
  assert.deepEqual(config.modes.biweekly, { lookback_weeks: 4, auto_write: true });
  assert.equal(config.documents.weekly.length, 2);
  assert.equal(config.documents.weekly[0].table_block_id, 'BLOCK2026');
  assert.equal(config.documents.weekly[1].token, 'doccnFAKE2025');
});

test('a configured workspace turns an issue id into its own linked text_run', () => {
  const weekly = weeklyTarget(parseConfigYaml(CONFIG), '2026-01-01');
  assert.equal(weekly.linearWorkspace, 'leon-os');

  const elements = taskTextElements(weekly, '今日完成约 13,000 CAD 换汇 (LEO-197)');
  assert.equal(elements.length, 3);
  assert.equal(elements[0].text_run.text_element_style, undefined, 'leading prose stays unstyled');
  assert.equal(elements[1].text_run.content, 'LEO-197');
  // Feishu's docx API expects link.url percent-encoded.
  assert.equal(elements[1].text_run.text_element_style.link.url, 'https%3A%2F%2Flinear.app%2Fleon-os%2Fissue%2FLEO-197');
  assert.equal(elements[2].text_run.content, ')');
});

test('multiple ids in one item each become their own link', () => {
  const weekly = weeklyTarget(parseConfigYaml(CONFIG), '2026-01-01');
  const elements = taskTextElements(weekly, '收尾 (LEO-267) 与 (LEO-268)');
  const linked = elements.filter((element) => element.text_run.text_element_style?.link);
  assert.deepEqual(linked.map((element) => element.text_run.content), ['LEO-267', 'LEO-268']);
});

test('no workspace configured still degrades to plain text', () => {
  const config = parseConfigYaml(CONFIG.replace('linear:\n  workspace: leon-os', ''));
  const weekly = weeklyTarget(config, '2026-01-01');
  assert.equal(weekly.linearWorkspace, '');
  const elements = taskTextElements(weekly, '今日完成换汇 (LEO-197)');
  assert.deepEqual(elements, [{ text_run: { content: '今日完成换汇 (LEO-197)' } }]);
});

test('an item with no issue id is a single unstyled run', () => {
  const weekly = weeklyTarget(parseConfigYaml(CONFIG), '2026-01-01');
  const elements = taskTextElements(weekly, '和父母沟通近况。');
  assert.deepEqual(elements, [{ text_run: { content: '和父母沟通近况。' } }]);
});
