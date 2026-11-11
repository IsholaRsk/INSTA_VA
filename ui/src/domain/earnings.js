/**
 * Barème des gains.
 *
 * Chaque tranche de 250 clics est rémunérée. La première vaut 12 $, et la
 * deuxième (de 251 à 500) vaut encore 12 $ — soit 24 $ à 500 clics. Au-delà de
 * 500 clics, une tranche de 250 ne vaut plus que 8 $.
 *
 *   250 clics →  12 $
 *   500 clics →  24 $
 *   750 clics →  32 $
 *  1000 clics →  40 $
 *
 * Le calcul est fait par tranches entières : 300 clics rapportent 12 $, pas une
 * fraction de la tranche suivante. Dégressif n'est jamais perdant : le total ne
 * baisse jamais quand le nombre de clics augmente.
 */

export const CLICKS_PER_TIER = 250;
export const TIER_RATE_START = 12;
export const TIER_RATE_AFTER_BONUS = 8;
/** Nombre de tranches rémunérées au tarif de départ (les deux premières). */
export const BONUS_TIERS = 2;

/** Ce que rapporte une tranche donnée (1-indexée). */
export function rateForTier(tierIndex) {
  if (!Number.isFinite(tierIndex) || tierIndex < 1) return 0;
  return tierIndex <= BONUS_TIERS ? TIER_RATE_START : TIER_RATE_AFTER_BONUS;
}

/** Nombre de tranches complètes pour un total de clics. */
export function completedTiers(clicks) {
  const total = Math.max(0, Math.floor(Number(clicks) || 0));
  return Math.floor(total / CLICKS_PER_TIER);
}

/** Montant cumulé pour un nombre de clics. */
export function earningsForClicks(clicks) {
  const tiers = completedTiers(clicks);
  let total = 0;
  for (let tier = 1; tier <= tiers; tier += 1) total += rateForTier(tier);
  return total;
}

/**
 * Détail lisible pour l'interface : montant acquis, tranche en cours, reste à
 * faire et valeur de la prochaine tranche.
 */
export function earningsBreakdown(clicks) {
  const total = Math.max(0, Math.floor(Number(clicks) || 0));
  const tiers = completedTiers(total);
  const earned = earningsForClicks(total);
  const inTier = total % CLICKS_PER_TIER;
  const nextTier = tiers + 1;
  return {
    clicks: total,
    earned,
    tiers,
    inTier,
    remainingInTier: inTier === 0 ? CLICKS_PER_TIER : CLICKS_PER_TIER - inTier,
    nextTierRate: rateForTier(nextTier),
    nextTierTarget: nextTier * CLICKS_PER_TIER,
    progress: inTier / CLICKS_PER_TIER,
  };
}

/** Formatage monétaire simple, sans dépendre d'Intl.NumberFormat côté tests. */
export function formatMoney(amount, { currency = '$' } = {}) {
  const value = Number(amount) || 0;
  const [whole, cents] = value.toFixed(2).split('.');
  return `${currency}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}
