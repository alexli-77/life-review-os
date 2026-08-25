import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProviderFailure } from '../bin/life-review-os.mjs';

/**
 * The old handler was `(res.stderr || res.stdout).slice(0, 2000)`, which reports
 * nothing for any failure that produces no output — and that is the common case.
 * A biweekly run takes ~9.5 minutes against what used to be a 10-minute ceiling,
 * so it got SIGTERMed mid-draft and surfaced to the user as a bare
 * "life-review-os run failed: Claude failed:" with nothing after the colon.
 */

const NO_OUTPUT = { status: null, signal: 'SIGTERM', stdout: '', stderr: '' };

test('a timeout says it timed out, for how long, and how to raise it', () => {
  const message = describeProviderFailure('Claude', { ...NO_OUTPUT, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.match(message, /timed out after \d+s/);
  assert.match(message, /LIFE_REVIEW_OS_PROVIDER_TIMEOUT_MS/);
  assert.ok(message.length > 'Claude failed: '.length, 'must not be an empty tail');
});

test('a SIGTERM with no error object is still reported as a timeout', () => {
  // spawnSync surfaces the kill this way on some platforms: signal set, no error.
  assert.match(describeProviderFailure('Claude', NO_OUTPUT), /timed out after \d+s/);
});

test('partial output before the kill is preserved', () => {
  const message = describeProviderFailure('Claude', { ...NO_OUTPUT, stdout: '## 上周执行对比 …草稿写到一半' });
  assert.match(message, /Partial output: ## 上周执行对比/);
});

test('a missing binary names the binary and the env var to set', () => {
  const message = describeProviderFailure('Claude', {
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }),
  });
  assert.match(message, /binary not found: claude/);
  assert.match(message, /CLAUDE_BIN/);
});

test('null streams do not throw the way .slice() on null did', () => {
  assert.doesNotThrow(() => describeProviderFailure('Codex', { status: 1, signal: null, stdout: null, stderr: null }));
});

test('a plain non-zero exit still reports the real stderr', () => {
  const message = describeProviderFailure('Claude', { status: 1, signal: null, stdout: '', stderr: 'API Error: 401 OAuth access token has expired' });
  assert.match(message, /status 1/);
  assert.match(message, /401 OAuth access token has expired/);
});

test('a non-zero exit with genuinely no output says so instead of trailing off', () => {
  const message = describeProviderFailure('Claude', { status: 2, signal: null, stdout: '', stderr: '' });
  assert.equal(message, 'Claude exited with status 2 and produced no output.');
});

test('the codex branch reports its own binary and env var', () => {
  const message = describeProviderFailure('Codex', {
    status: null,
    signal: null,
    stdout: null,
    stderr: null,
    error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  });
  assert.match(message, /binary not found: codex/);
  assert.match(message, /CODEX_BIN/);
});
