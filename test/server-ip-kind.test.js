import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyIp, lookupAsn, describeExitIp, clearAsnCache } from '../server/proxies.js';

test('une IP d’hébergeur est classée datacenter, avec son fournisseur', () => {
  const ovh = classifyIp({ asn: 16276, org: 'OVH SAS' });
  assert.equal(ovh.kind, 'datacenter');
  assert.equal(ovh.asn, 16276);
  assert.match(ovh.provider, /OVH/);

  for (const asn of [16276, 16509, 14061, 24940, 12876, 9009, 20473]) {
    assert.equal(classifyIp({ asn, org: '' }).kind, 'datacenter', `AS${asn} doit être datacenter`);
  }
});

test('une IP grand public est classée résidentielle', () => {
  // Free (France) et un FAI africain : des réseaux d'abonnés.
  assert.equal(classifyIp({ asn: 12322, org: 'Free SAS' }).kind, 'residential');
  assert.equal(classifyIp({ asn: 36925, org: 'ASMedi' }).kind, 'residential');
});

test('à défaut d’ASN connu, le nom de l’hébergeur suffit', () => {
  // Certains services ne renvoient que l'organisation, sans numéro exploitable.
  assert.equal(classifyIp({ asn: null, org: 'Hetzner Online GmbH' }).kind, 'datacenter');
  assert.equal(classifyIp({ asn: null, org: 'Contabo GmbH' }).kind, 'datacenter');
  // Un FAI dont le nom contient un mot d'hébergeur ne doit pas être piégé par hasard.
  assert.equal(classifyIp({ asn: null, org: 'Free SAS' }).kind, 'residential');
});

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    async fetch(url, options = {}) {
      calls.push(String(url));
      const handler = responses[String(url)];
      if (!handler) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => handler };
    },
  };
}

test('l’ASN est lu chez le premier service qui répond', async () => {
  clearAsnCache();
  const { fetch } = fakeFetch({
    'https://ipinfo.io/51.15.10.20/json': { ip: '51.15.10.20', org: 'AS12876 SCALEWAY S.A.S.' },
  });
  const info = await lookupAsn('51.15.10.20', { fetchImpl: fetch, timeoutMs: 1000 });
  assert.equal(info.asn, 12876);
  assert.match(info.org, /SCALEWAY/);
  const described = await describeExitIp('51.15.10.20', { fetchImpl: fetch, timeoutMs: 1000 });
  assert.equal(described.kind, 'datacenter');
  assert.match(described.provider, /Scaleway/);
});

test('si le premier service tombe, le second est interrogé', async () => {
  clearAsnCache();
  const { fetch, calls } = fakeFetch({
    'https://ipwho.is/88.120.1.1': { success: true, connection: { asn: 12322, org: 'Free SAS' } },
  });
  const described = await describeExitIp('88.120.1.1', { fetchImpl: fetch, timeoutMs: 1000 });
  assert.equal(described.kind, 'residential');
  assert.equal(calls.length, 2, 'les deux services sont tentés dans l’ordre');
  assert.ok(calls[0].includes('ipinfo.io'));
  assert.ok(calls[1].includes('ipwho.is'));
});

test('un annuaire injoignable ne fait pas échouer le test du proxy', async () => {
  clearAsnCache();
  const failing = async () => { throw new Error('réseau indisponible'); };
  const described = await describeExitIp('51.15.10.20', { fetchImpl: failing, timeoutMs: 1000 });
  assert.equal(described.kind, 'unknown', 'type inconnu, jamais une erreur');
  assert.equal(described.ip, '51.15.10.20');
});
