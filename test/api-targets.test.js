import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

const userId = '2c8c58e3-776e-4e6c-9369-2f5a098c7c9d';
const originalFetch = globalThis.fetch;
const originalEnv = {
  url: process.env.SUPABASE_URL,
  anon: process.env.SUPABASE_ANON_KEY,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
let handler;
let calls;

before(async () => {
  process.env.SUPABASE_URL = 'https://project-ref.supabase.co';
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  const module = await import('../api/targets.js');
  handler = module.default;
  calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({ url, options });
    if (url.pathname === '/auth/v1/user') {
      return new Response(JSON.stringify({ id: userId, email: 'owner@example.test' }), { status: 200 });
    }
    if (url.pathname === '/rest/v1/instava_mobile_targets') {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body);
        return new Response(JSON.stringify([{ id: userId, ...body }]), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'unexpected request' }), { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = originalEnv.url;
  if (originalEnv.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = originalEnv.anon;
  if (originalEnv.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.service;
});

function responseMock() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
}

test('target API normalizes public URLs and scopes creation to the authenticated user', async () => {
  calls.length = 0;
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-user-token' },
    body: { pseudo: 'Boutique', url: 'example.com/offre', linkLabel: 'Découvrir', executionTarget: 10, durationWeeks: 2 },
  }, res);
  const result = JSON.parse(res.body);
  assert.equal(res.statusCode, 201);
  assert.equal(result.target.url, 'https://example.com/offre');
  assert.equal(result.target.user_id, userId);
  assert.ok(calls.some(({ url, options }) => url.pathname.endsWith('/instava_mobile_targets') && options.method === 'POST'));
});

test('target API rejects private destinations without creating a row', async () => {
  calls.length = 0;
  const res = responseMock();
  await handler({
    method: 'POST',
    headers: { authorization: 'Bearer test-user-token' },
    body: { pseudo: 'Local', url: 'http://127.0.0.1/admin', linkLabel: 'Open', executionTarget: 1, durationWeeks: 1 },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'Les adresses locales ou privées ne sont pas autorisées.');
  assert.ok(!calls.some(({ options }) => options.method === 'POST'));
});
