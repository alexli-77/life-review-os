import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeArgs, skillConstraints } from '../bin/life-review-os.mjs';

/**
 * A biweekly draft used to take 9.5 minutes and once hit the 20-minute ceiling.
 * The transcript showed why: 30,584 output tokens, of which a 128KB thinking
 * block against a 5KB answer. Input was never the bottleneck — it is prefill.
 *
 * Measured on the same 49KB prompt:
 *   default                       9m27s   30,584 out   59,185 in
 *   --effort low                  3m42s   13,288 out   59,185 in
 *   + own system prompt/no tools  3m27s   12,326 out   45,970 in
 */

test('effort is capped by default — this is what cuts the run time', () => {
  const args = claudeArgs();
  const index = args.indexOf('--effort');
  assert.ok(index > -1, 'effort must be set explicitly, not left to the default');
  assert.equal(args[index + 1], 'low');
});

test('effort is overridable for a cycle that needs more reasoning', async () => {
  process.env.LIFE_REVIEW_OS_CLAUDE_EFFORT = 'high';
  const fresh = await import(`../bin/life-review-os.mjs?effort=high`);
  assert.equal(fresh.claudeArgs()[fresh.claudeArgs().indexOf('--effort') + 1], 'high');
  delete process.env.LIFE_REVIEW_OS_CLAUDE_EFFORT;
});

test('the agent system prompt is replaced, not appended to', () => {
  const args = claudeArgs();
  // --append-system-prompt would keep the full agent preamble and its cost.
  assert.ok(args.includes('--system-prompt'));
  assert.ok(!args.includes('--append-system-prompt'));
  assert.match(args[args.indexOf('--system-prompt') + 1], /不要调用任何工具/);
});

test('file and network tools are denied: drafting is a pure text transformation', () => {
  const args = claudeArgs();
  const index = args.indexOf('--disallowed-tools');
  assert.ok(index > -1);
  const denied = args.slice(index + 1);
  for (const tool of ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
});

test('output stays plain text and MCP stays strict', () => {
  const args = claudeArgs();
  assert.equal(args[0], '-p');
  assert.equal(args[args.indexOf('--output-format') + 1], 'text');
  assert.ok(args.includes('--strict-mcp-config'));
});

test('--bare is not used: it skips auth setup and the run fails "Not logged in"', () => {
  assert.ok(!claudeArgs().includes('--bare'));
});

/**
 * SKILL.md targets the interactive skill: Claude reads the folder, asks the
 * user questions, performs the write-back. This CLI already did all of it, so
 * the only part that still applies is the hard-constraints section. The rest
 * was 5,208 of 6,881 characters — and worse than inert: "按顺序读取以下文件"
 * asks for tool calls on content inlined right below it, and its 输出格式
 * section contradicts the prompt's own "# Output contract".
 */
test('only the hard-constraints section of SKILL.md reaches the prompt', () => {
  const text = skillConstraints();
  assert.match(text, /^## 🐶 Feishu Weekly 硬约束/);
  assert.ok(text.length < 2000, `expected the trimmed section, got ${text.length} chars`);
});

test('the constraints that actually bind the output are all still there', () => {
  const text = skillConstraints();
  assert.match(text, /只读取当前 Weekly 文档中/, 'OKR 来源');
  assert.match(text, /table_marker/, '表格校验');
  assert.match(text, /不得用 `\/` 把多个任务串成一条/, '写回颗粒度');
  assert.match(text, /最多 1 个 MIT/, '任务量预算');
  assert.match(text, /350 个中文字符以内/, 'retro review');
});

test('the interactive-only sections are gone', () => {
  const text = skillConstraints();
  for (const dead of ['按顺序**读取以下文件', '标准执行流程', 'Vault Onboarding', '依赖技能', 'lark-cli']) {
    assert.ok(!text.includes(dead), `"${dead}" must not reach the prompt`);
  }
});

test('the plan-time ✅ clause is gone: writing it fabricates completion evidence', () => {
  assert.ok(!/追加红色 `MIT` 和 `✅`/.test(skillConstraints()));
});
