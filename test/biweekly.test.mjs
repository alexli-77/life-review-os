import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleDays,
  cycleRange,
  previousCycle,
  resolveCycle,
  biweeklyBudgetMultiplier,
  buildPlanningPolicy,
  parseConfigYaml,
} from '../bin/life-review-os.mjs';

// Fixture: header row + 5 OKR rows (indexes 1..5 non-empty).
const tableRows = [
  { index: 0, firstColumn: 'OKR' },
  { index: 1, firstColumn: 'A' },
  { index: 2, firstColumn: 'B' },
  { index: 3, firstColumn: 'C' },
  { index: 4, firstColumn: 'D' },
  { index: 5, firstColumn: 'E' },
];

test('cycleDays: weekly=7, biweekly=14', () => {
  assert.equal(cycleDays('weekly'), 7);
  assert.equal(cycleDays('biweekly'), 14);
  assert.equal(cycleDays(undefined), 7);
});

test('cycleRange: weekly is a Monday..Sunday 7-day span', () => {
  const w = cycleRange('2025-07-09', 'weekly'); // Wed
  assert.equal(w.start, '2025-07-07');
  assert.equal(w.end, '2025-07-13');
  assert.equal(w.label, '7.7-7.13');
});

test('cycleRange: biweekly is a Monday..Sunday+7 14-day span, single label', () => {
  const b = cycleRange('2025-07-09', 'biweekly');
  assert.equal(b.start, '2025-07-07');
  assert.equal(b.end, '2025-07-20');
  assert.equal(b.label, '7.7-7.20');
});

test('cycleRange: aligns to Monday and crosses month boundary', () => {
  assert.equal(cycleRange('2025-07-07', 'weekly').start, '2025-07-07'); // Monday stays
  const cross = cycleRange('2025-06-30', 'biweekly'); // Monday 6.30
  assert.equal(cross.label, '6.30-7.13');
});

test('cycleRange: Sunday snaps back to that week\'s Monday', () => {
  const sun = cycleRange('2025-07-13', 'weekly'); // Sunday
  assert.equal(sun.start, '2025-07-07');
  assert.equal(sun.label, '7.7-7.13');
});

test('previousCycle: looks back one cycle length', () => {
  assert.equal(previousCycle('2025-07-07', 'weekly').label, '6.30-7.6');
  assert.equal(previousCycle('2025-07-07', 'biweekly').label, '6.23-7.6');
});

test('resolveCycle: explicit mode wins', () => {
  assert.equal(resolveCycle({}, 'weekly'), 'weekly');
  assert.equal(resolveCycle({}, 'biweekly'), 'biweekly');
});

test('resolveCycle: falls back to config.planning.todo_cycle, then weekly', () => {
  assert.equal(resolveCycle({ planning: { todo_cycle: 'biweekly' } }, ''), 'biweekly');
  assert.equal(resolveCycle({}, ''), 'weekly');
});

test('resolveCycle: rejects unsupported cycles', () => {
  assert.throws(() => resolveCycle({}, 'monthly'), /Unsupported todo cycle/);
});

test('biweeklyBudgetMultiplier: default 2, configurable, guards invalid', () => {
  assert.equal(biweeklyBudgetMultiplier({}), 2);
  assert.equal(biweeklyBudgetMultiplier({ modes: { biweekly: { budget_multiplier: 3 } } }), 3);
  assert.equal(biweeklyBudgetMultiplier({ modes: { biweekly: { budget_multiplier: 0 } } }), 2);
  assert.equal(biweeklyBudgetMultiplier({ modes: { biweekly: { budget_multiplier: 'x' } } }), 2);
});

test('buildPlanningPolicy: weekly uses the normal preset unchanged', () => {
  const p = buildPlanningPolicy({}, tableRows, 'weekly');
  assert.equal(p.cycle, 'weekly');
  assert.equal(p.budget_multiplier, 1);
  assert.deepEqual(
    { min: p.min_total_items, max: p.max_total_items, p1: p.p1, p2: p.p2, mit: p.mit },
    { min: 6, max: 10, p1: 4, p2: 3, mit: 1 },
  );
});

test('buildPlanningPolicy: biweekly doubles the item budget, MIT stays 1', () => {
  const p = buildPlanningPolicy({}, tableRows, 'biweekly');
  assert.equal(p.cycle, 'biweekly');
  assert.equal(p.budget_multiplier, 2);
  assert.deepEqual(
    { min: p.min_total_items, max: p.max_total_items, p1: p.p1, p2: p.p2, mit: p.mit },
    { min: 12, max: 20, p1: 8, p2: 6, mit: 1 },
  );
});

test('buildPlanningPolicy: biweekly respects a configured budget_multiplier', () => {
  const config = { modes: { biweekly: { budget_multiplier: 3 } } };
  const p = buildPlanningPolicy(config, tableRows, 'biweekly');
  assert.deepEqual(
    { min: p.min_total_items, max: p.max_total_items, p1: p.p1, p2: p.p2, mit: p.mit },
    { min: 18, max: 30, p1: 12, p2: 9, mit: 1 },
  );
});

test('buildPlanningPolicy: workload_mode preset is honored (conservative)', () => {
  const p = buildPlanningPolicy({ planning: { workload_mode: 'conservative' } }, tableRows, 'weekly');
  assert.equal(p.min_total_items, 4);
  assert.equal(p.max_total_items, 6);
});

test('parseConfigYaml -> resolveCycle/multiplier integration', () => {
  const yaml = ['planning:', '  todo_cycle: biweekly', 'modes:', '  biweekly:', '    budget_multiplier: 3'].join('\n');
  const config = parseConfigYaml(yaml);
  assert.equal(config.planning.todo_cycle, 'biweekly');
  assert.equal(config.modes.biweekly.budget_multiplier, 3);
  assert.equal(resolveCycle(config, ''), 'biweekly');
  assert.equal(biweeklyBudgetMultiplier(config), 3);
});
