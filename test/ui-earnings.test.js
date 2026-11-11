import test from 'node:test';
import assert from 'node:assert/strict';

import {
  earningsForClicks, earningsBreakdown, rateForTier, completedTiers,
  formatMoney, CLICKS_PER_TIER,
} from '../ui/src/domain/earnings.js';

test('barème : 250 clics = 12 $, 500 clics = 24 $, puis 8 $ par tranche', () => {
  assert.equal(earningsForClicks(0), 0);
  assert.equal(earningsForClicks(249), 0, 'une tranche incomplète ne paie rien');
  assert.equal(earningsForClicks(250), 12);
  assert.equal(earningsForClicks(499), 12);
  assert.equal(earningsForClicks(500), 24);
  assert.equal(earningsForClicks(750), 32, '3e tranche à 8 $');
  assert.equal(earningsForClicks(1000), 40);
  assert.equal(earningsForClicks(1250), 48);
});

test('barème : le tarif par tranche bascule après deux tranches', () => {
  assert.equal(rateForTier(1), 12);
  assert.equal(rateForTier(2), 12);
  assert.equal(rateForTier(3), 8);
  assert.equal(rateForTier(10), 8);
  assert.equal(rateForTier(0), 0, 'aucune tranche');
  assert.equal(rateForTier(-3), 0);
});

test('barème : dégressif mais jamais perdant', () => {
  let previous = -1;
  for (let clicks = 0; clicks <= 5000; clicks += 37) {
    const earned = earningsForClicks(clicks);
    assert.ok(earned >= previous, `le gain baisse à ${clicks} clics (${earned} < ${previous})`);
    previous = earned;
  }
  // Le gain ne baisse jamais, même en franchissant la bascule de tarif.
  assert.ok(earningsForClicks(501) >= earningsForClicks(500));
});

test('barème : la progression est cohérente avec le total', () => {
  const detail = earningsBreakdown(620);
  assert.equal(detail.tiers, 2);
  assert.equal(detail.earned, 24);
  assert.equal(detail.inTier, 120);
  assert.equal(detail.remainingInTier, 130);
  assert.equal(detail.nextTierRate, 8);
  assert.equal(detail.nextTierTarget, 750);
  assert.ok(Math.abs(detail.progress - 0.48) < 1e-9);
});

test('barème : un total rond affiche la tranche suivante en entier', () => {
  const detail = earningsBreakdown(500);
  assert.equal(detail.inTier, 0);
  assert.equal(detail.remainingInTier, CLICKS_PER_TIER);
  assert.equal(detail.nextTierTarget, 750);
});

test('barème : entrées douteuses ramenées à zéro', () => {
  for (const value of [null, undefined, NaN, -100, 'inconnu', {}]) {
    assert.equal(earningsForClicks(value), 0, `entrée ${String(value)}`);
    assert.equal(completedTiers(value), 0);
  }
  // Une chaîne numérique reste exploitable.
  assert.equal(earningsForClicks('250'), 12);
});

test('le montant est formaté comme une devise, séparateur de milliers inclus', () => {
  assert.equal(formatMoney(0), '$0.00');
  assert.equal(formatMoney(12), '$12.00');
  assert.equal(formatMoney(1234.5), '$1,234.50');
  assert.equal(formatMoney(null), '$0.00');
});
