import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../supabase/functions/create-pickup/handler.mjs';

// Deliberately fake keys; these tests never contact Supabase.
const env = {
  ALLOWED_ORIGINS: 'http://localhost:8000,https://loopboard.example',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: 'sb_publishable_test' }),
  SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_test' }),
};
const valid = {
  request_id: '17bcc198-3f23-414e-b98b-73b8cf729172',
  name: 'Test Person', phone: '9876543210', address: '123 Example Street',
  item_type: 'Mixed e-waste', preferred_date: '2099-01-02', notes: '', website: '',
};
const makeRequest = (body = valid, headers = {}, method = 'POST') => new Request('https://project.supabase.co/functions/v1/create-pickup', {
  method,
  headers: { origin: 'http://localhost:8000', apikey: 'sb_publishable_test', 'content-type': 'application/json', 'x-forwarded-for': '192.0.2.1', ...headers },
  ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
});
const mustNotSave = () => { throw new Error('Database must not be called'); };

test('saves normalized values, sends the server key only to the database, and hashes IPs', async () => {
  const response = await handleRequest(makeRequest({ ...valid, name: ' Test Person ', phone: '98765-43210' }), env, async (url, options) => {
    assert.equal(url, env.SUPABASE_URL + '/rest/v1/rpc/create_pickup');
    assert.equal(options.headers.apikey, 'sb_secret_test');
    assert.equal(options.headers.Authorization, undefined);
    const saved = JSON.parse(options.body);
    assert.equal(saved.p_name, 'Test Person');
    assert.equal(saved.p_phone, '9876543210');
    assert.equal(saved.p_request_id, valid.request_id);
    assert.match(saved.p_ip_hash, /^[a-f0-9]{64}$/);
    assert(!options.body.includes('192.0.2.1'));
    return Response.json({ reference: 'LB-123456ABCDEF', preferred_date: valid.preferred_date });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { reference: 'LB-123456ABCDEF', preferred_date: valid.preferred_date, status: 'requested' });
});

test('permits preflight and rejects unsupported methods', async () => {
  assert.equal((await handleRequest(makeRequest(null, {}, 'OPTIONS'), env, mustNotSave)).status, 204);
  assert.equal((await handleRequest(makeRequest(null, {}, 'GET'), env, mustNotSave)).status, 405);
});

test('rejects unapproved, missing and null origins', async () => {
  for (const origin of ['https://attacker.example', '', 'null']) {
    const response = await handleRequest(makeRequest(valid, { origin }), env, mustNotSave);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
});

test('checks the public application key and fails closed without server configuration', async () => {
  assert.equal((await handleRequest(makeRequest(valid, { apikey: 'wrong' }), env, mustNotSave)).status, 401);
  assert.equal((await handleRequest(makeRequest(), { ...env, SUPABASE_SECRET_KEYS: '{}' }, mustNotSave)).status, 503);
  assert.equal((await handleRequest(makeRequest(), { ...env, SUPABASE_SECRET_KEYS: 'invalid-json' }, mustNotSave)).status, 503);
});

test('rejects incorrect content type, oversized bodies and invalid JSON', async () => {
  assert.equal((await handleRequest(makeRequest(valid, { 'content-type': 'text/plain' }), env, mustNotSave)).status, 415);
  assert.equal((await handleRequest(makeRequest(valid, { 'content-length': '9000' }), env, mustNotSave)).status, 413);
  assert.equal((await handleRequest(makeRequest('x'.repeat(9000)), env, mustNotSave)).status, 413);
  for (const body of ['{', 'null', '[]', '"hello"']) assert.equal((await handleRequest(makeRequest(body), env, mustNotSave)).status, 400);
});

test('validates all fields on the server', async () => {
  for (const [key, value] of [
    ['name', 'A'], ['name', 'x'.repeat(101)], ['phone', '1234567890'],
    ['address', 'short'], ['address', 'x'.repeat(1001)], ['item_type', 'unsupported'],
    ['preferred_date', '2099-02-30'], ['preferred_date', '2020-01-01'],
    ['notes', 'x'.repeat(1001)], ['notes', 123],
  ]) {
    const response = await handleRequest(makeRequest({ ...valid, [key]: value }), env, mustNotSave);
    assert.equal(response.status, 422, key);
    assert((await response.json()).errors[key], key);
  }
  assert.equal((await handleRequest(makeRequest({ ...valid, request_id: 'not-a-uuid' }), env, mustNotSave)).status, 400);
  assert.equal((await handleRequest(makeRequest({ ...valid, website: 'spam' }), env, mustNotSave)).status, 400);
});

test('uses tomorrow in India, including UTC evening', async t => {
  t.mock.method(Date, 'now', () => new Date('2026-10-28T19:00:00Z').getTime());
  const response = await handleRequest(makeRequest({ ...valid, preferred_date: '2026-10-29' }), env, mustNotSave);
  assert.equal(response.status, 422);
  assert((await response.json()).errors.preferred_date);
});

test('maps database rate limits and changed retry payloads without exposing database errors', async () => {
  const limited = await handleRequest(makeRequest(), env, async () => Response.json({ code: 'PT429' }, { status: 429 }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '3600');
  const conflict = await handleRequest(makeRequest(), env, async () => Response.json({ code: '22023' }, { status: 400 }));
  assert.equal(conflict.status, 409);
  const failed = await handleRequest(makeRequest(), env, async () => Response.json({ message: 'private database detail' }, { status: 500 }));
  assert.equal(failed.status, 503);
  assert(!(await failed.text()).includes('private database detail'));
});

test('never reports success for network errors or malformed database confirmations', async () => {
  const network = await handleRequest(makeRequest(), env, async () => { throw new Error('network down'); });
  assert.equal(network.status, 503);
  for (const result of [{}, { reference: 'bad', preferred_date: valid.preferred_date }, { reference: 'LB-123456ABCDEF', preferred_date: '2099-01-03' }]) {
    const response = await handleRequest(makeRequest(), env, async () => Response.json(result));
    assert.equal(response.status, 503);
  }
});
