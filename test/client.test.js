'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CacheClient, ServiceError, IntegrityError, NetworkError } = require('../src/client');
const { startMockService } = require('./helpers/mock-service');

const scope = { repository: 'Helm-Development/Example', branch: 'feature/x' };

test('lookup sends the token, repository, branch and keys', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  svc.addEntry('main', 'gradle-1', Buffer.from('data'));
  const c = new CacheClient({ url: svc.url, token: svc.token });
  const a = await c.lookup({ ...scope, key: 'gradle-2', restoreKeys: ['gradle-'] });
  assert.equal(a.hit, true);
  assert.equal(a.exact, false);
  assert.equal(a.entry.key, 'gradle-1');
  const r = svc.requests[0];
  assert.equal(r.headers.authorization, `Bearer ${svc.token}`);
  assert.deepEqual(JSON.parse(r.body), { ...scope, key: 'gradle-2', restore_keys: ['gradle-'] });
});

test('a wrong branch gets 403 scope_denied', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  const c = new CacheClient({ url: svc.url, token: svc.token });
  await assert.rejects(c.lookup({ ...scope, branch: 'other', key: 'k', restoreKeys: [] }),
    (e) => e instanceof ServiceError && e.status === 403 && e.code === 'scope_denied');
});

test('lookup is retried after 503 and after a dropped connection', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  svc.fail('POST', '/v1/cache/lookup', 503);
  svc.fail('POST', '/v1/cache/lookup', 0, { destroy: true });
  const c = new CacheClient({ url: svc.url, token: svc.token, retryDelayMs: 1 });
  const a = await c.lookup({ ...scope, key: 'k', restoreKeys: [] });
  assert.equal(a.hit, false);
  assert.equal(svc.requests.length, 3);
});

test('a 500 is not retried', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  svc.fail('POST', '/v1/cache/lookup', 500, { error: 'store_error' });
  const c = new CacheClient({ url: svc.url, token: svc.token, retryDelayMs: 1 });
  await assert.rejects(c.lookup({ ...scope, key: 'k', restoreKeys: [] }), (e) => e.status === 500);
  assert.equal(svc.requests.length, 1);
});

test('an unreachable service gives a NetworkError', async () => {
  const c = new CacheClient({ url: 'http://127.0.0.1:1', token: 't', retryDelayMs: 1, attempts: 2 });
  await assert.rejects(c.lookup({ ...scope, key: 'k', restoreKeys: [] }), (e) => e instanceof NetworkError && e.code === 'ECONNREFUSED');
});

test('download checks the digest and discards a mismatch', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const e = svc.addEntry('feature/x', 'k', Buffer.from('hello'));
  const c = new CacheClient({ url: svc.url, token: svc.token });
  const lookup = await c.lookup({ ...scope, key: 'k', restoreKeys: [] });
  const file = path.join(dir, 'a');
  await c.download(lookup.entry, file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');

  e.corrupt = true;
  const file2 = path.join(dir, 'b');
  await assert.rejects(c.download(lookup.entry, file2), IntegrityError);
  assert.equal(fs.existsSync(file2), false);
});

test('save sends the size and digest; a second save gets 409', async (t) => {
  const svc = await startMockService();
  t.after(() => svc.close());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a');
  fs.writeFileSync(file, 'payload');
  const sha256 = require('node:crypto').createHash('sha256').update('payload').digest('hex');
  const c = new CacheClient({ url: svc.url, token: svc.token });
  const entry = await c.save({ ...scope, key: 'k', file, sizeBytes: 7, sha256 });
  assert.equal(entry.key, 'k');
  const r = svc.requests[0];
  assert.equal(r.headers['content-length'], '7');
  assert.equal(r.headers['x-helm-cache-sha256'], sha256);
  assert.deepEqual(r.query, { ...scope, key: 'k' });
  await assert.rejects(c.save({ ...scope, key: 'k', file, sizeBytes: 7, sha256 }), (e) => e.status === 409 && e.code === 'already_exists');
});
