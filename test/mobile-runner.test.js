import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRandomRunTimes,
  getSensitiveLabelReason,
  normalizeTargetUrl,
  randomExecutionCount,
  validateUuid,
} from '../lib/shared.js';

test('schedule starts immediately and keeps every target interval at least five minutes', () => {
  const start = 1_800_000_000_000;
  const times = buildRandomRunTimes(60, 1, start);
  assert.equal(times.length, 60);
  assert.equal(times[0], start);
  for (let index = 1; index < times.length; index += 1) {
    assert.ok(times[index] - times[index - 1] >= 5 * 60 * 1000);
  }
  assert.ok(times.at(-1) < start + 7 * 24 * 60 * 60 * 1000);
});

test('single-execution schedule contains only the immediate visit', () => {
  const start = 1_800_000_000_000;
  assert.deepEqual(buildRandomRunTimes(1, 1, start), [start]);
});

test('random execution count stays within max(1, N-10) through N+10', () => {
  for (const target of [1, 10, 50]) {
    const values = Array.from({ length: 1000 }, () => randomExecutionCount({ execution_target: target }));
    assert.ok(Math.min(...values) >= Math.max(1, target - 10));
    assert.ok(Math.max(...values) <= target + 10);
  }
});

test('target URL normalization accepts public HTTP(S) URLs and rejects local targets', () => {
  assert.equal(normalizeTargetUrl('example.com/path'), 'https://example.com/path');
  assert.equal(normalizeTargetUrl('http://1.1.1.1/page'), 'http://1.1.1.1/page');
  for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'file:///etc/passwd', 'https://user:pass@example.com/']) {
    assert.throws(() => normalizeTargetUrl(url));
  }
});

test('sensitive link labels continue to require explicit approval', () => {
  for (const label of ['Connexion', 'S’identifier', 'Payer maintenant', 'Supprimer le compte', 'Publier', 'Confirmer']) {
    assert.ok(getSensitiveLabelReason(label), `${label} should be sensitive`);
  }
  assert.equal(getSensitiveLabelReason('Découvrir la collection'), false);
});

test('UUID validation accepts standard UUIDs only', () => {
  assert.equal(validateUuid('2c8c58e3-776e-4e6c-9369-2f5a098c7c9d'), true);
  assert.equal(validateUuid('not-a-uuid'), false);
});
