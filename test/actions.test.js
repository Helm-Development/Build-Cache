'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { restore, save, State, NOT_CONFIGURED } = require('../src/actions');
const { startMockService } = require('./helpers/mock-service');
const { fakeIO } = require('./helpers/fake-io');

const clientOptions = { retryDelayMs: 1 };

async function setup(t, serviceOptions = {}) {
  const svc = await startMockService(serviceOptions);
  t.after(() => svc.close());
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work', 'repo');
  const gradle = path.join(root, 'home', '.gradle', 'caches');
  fs.mkdirSync(path.join(workspace, '.build'), { recursive: true });
  fs.mkdirSync(gradle, { recursive: true });
  fs.writeFileSync(path.join(workspace, '.build', 'out.o'), 'object');
  fs.writeFileSync(path.join(gradle, 'dep.jar'), 'jar');
  const env = {
    PATH: process.env.PATH,
    HELM_CACHE_URL: svc.url,
    HELM_CACHE_TOKEN: svc.token,
    GITHUB_REPOSITORY: 'Helm-Development/Example',
    GITHUB_REF_NAME: '7/merge',
    GITHUB_HEAD_REF: 'feature/x',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: path.join(root, 'runner-temp'),
  };
  const paths = `.build\n${gradle}`;
  const wipe = () => {
    fs.rmSync(path.join(workspace, '.build'), { recursive: true, force: true });
    fs.rmSync(gradle, { recursive: true, force: true });
  };
  const restored = () => fs.existsSync(path.join(workspace, '.build', 'out.o')) && fs.existsSync(path.join(gradle, 'dep.jar'));
  return { svc, env, paths, wipe, restored, workspace, gradle };
}

test('a miss, then the post step saves, then the next run restores the exact key', async (t) => {
  const s = await setup(t);
  const inputs = { path: s.paths, key: 'deps-abc', 'restore-keys': 'deps-' };

  const io1 = fakeIO(inputs);
  assert.equal((await restore({ io: io1, env: s.env, clientOptions })).result, 'miss');
  assert.equal(io1.log.outputs['cache-hit'], 'false');
  assert.deepEqual(io1.log.secrets, [s.svc.token]);

  const post = fakeIO(inputs, io1.log.state);
  const saved = await save({ mode: 'post', io: post, env: s.env, clientOptions });
  assert.equal(saved.result, 'saved', post.all());
  const put = s.svc.requests.find((r) => r.method === 'PUT');
  assert.equal(put.query.branch, 'feature/x', 'a pull request saves to its head branch');
  assert.equal(put.query.repository, 'Helm-Development/Example');

  s.wipe();
  const io2 = fakeIO(inputs);
  assert.equal((await restore({ io: io2, env: s.env, clientOptions })).result, 'exact');
  assert.equal(io2.log.outputs['cache-hit'], 'true');
  assert.equal(io2.log.outputs['cache-matched-key'], 'deps-abc');
  assert.ok(s.restored());

  const post2 = fakeIO(inputs, io2.log.state);
  assert.equal((await save({ mode: 'post', io: post2, env: s.env, clientOptions })).result, 'skipped');
  assert.match(post2.all(), /exact key/);
});

test('a restore key restores the newest match from the default branch, and cache-hit is false', async (t) => {
  const s = await setup(t);
  // Save on main first, as a push to main would.
  const mainEnv = { ...s.env, GITHUB_HEAD_REF: '', GITHUB_REF_NAME: 'main' };
  const svcMain = await startMockService({ token: s.svc.token, branch: 'main' });
  t.after(() => svcMain.close());
  await save({ mode: 'save-only', io: fakeIO({ path: s.paths, key: 'deps-old' }), env: { ...mainEnv, HELM_CACHE_URL: svcMain.url }, clientOptions });
  const old = [...svcMain.entries.values()][0];
  s.svc.addEntry('main', 'deps-old', old.data);

  s.wipe();
  const io = fakeIO({ path: s.paths, key: 'deps-new', 'restore-keys': 'deps-' });
  assert.equal((await restore({ io, env: s.env, clientOptions })).result, 'partial');
  assert.equal(io.log.outputs['cache-hit'], 'false');
  assert.equal(io.log.outputs['cache-matched-key'], 'deps-old');
  assert.ok(s.restored());
  assert.match(io.all(), /saved on branch main/);

  // The post step saves under the new key, because the hit was not exact.
  const post = fakeIO({ path: s.paths, key: 'deps-new' }, io.log.state);
  assert.equal((await save({ mode: 'post', io: post, env: s.env, clientOptions })).result, 'saved');
});

test('without HELM_CACHE_URL and HELM_CACHE_TOKEN the action logs a notice and does nothing', async (t) => {
  const s = await setup(t);
  const env = { ...s.env, HELM_CACHE_URL: '', HELM_CACHE_TOKEN: '' };
  const io = fakeIO({ path: s.paths, key: 'k', 'fail-on-cache-miss': 'true' });
  assert.equal((await restore({ io, env, clientOptions })).result, 'not-configured');
  assert.deepEqual(io.log.notice, [NOT_CONFIGURED]);
  assert.deepEqual(io.log.failed, []);
  assert.equal(io.log.outputs['cache-hit'], 'false');
  const post = fakeIO({ path: s.paths }, io.log.state);
  assert.equal((await save({ mode: 'post', io: post, env, clientOptions })).result, 'not-configured');
  const only = fakeIO({ path: s.paths, key: 'k' });
  assert.equal((await save({ mode: 'save-only', io: only, env, clientOptions })).result, 'not-configured');
  assert.equal(s.svc.requests.length, 0);
});

test('an invalid key fails the step even without a cache service', async (t) => {
  const s = await setup(t);
  const io = fakeIO({ path: s.paths, key: 'bad\tkey' });
  await restore({ io, env: { ...s.env, HELM_CACHE_URL: '' }, clientOptions });
  assert.match(io.log.failed[0], /control character/);
});

test('fail-on-cache-miss fails the step on a miss', async (t) => {
  const s = await setup(t);
  const io = fakeIO({ path: s.paths, key: 'k', 'fail-on-cache-miss': 'true' });
  await restore({ io, env: s.env, clientOptions });
  assert.match(io.log.failed[0], /fail-on-cache-miss/);
});

test('lookup-only reports a hit without downloading', async (t) => {
  const s = await setup(t);
  await save({ mode: 'save-only', io: fakeIO({ path: s.paths, key: 'k' }), env: s.env, clientOptions });
  s.wipe();
  const io = fakeIO({ path: s.paths, key: 'k', 'lookup-only': 'true' });
  assert.equal((await restore({ io, env: s.env, clientOptions })).downloaded, false);
  assert.equal(io.log.outputs['cache-hit'], 'true');
  assert.equal(s.restored(), false);
  assert.equal(s.svc.requests.filter((r) => r.method === 'GET').length, 0);
});

test('a refused token is a warning, the job goes on, and the token is never logged', async (t) => {
  const s = await setup(t);
  const env = { ...s.env, HELM_CACHE_TOKEN: 'a-wrong-secret-token' };
  const io = fakeIO({ path: s.paths, key: 'k' });
  assert.equal((await restore({ io, env, clientOptions })).result, 'miss');
  assert.deepEqual(io.log.failed, []);
  assert.match(io.log.warning[0], /refused the job's token/);
  const post = fakeIO({ path: s.paths }, io.log.state);
  await save({ mode: 'post', io: post, env, clientOptions });
  assert.match(post.log.warning[0], /not saved/);
  assert.ok(!io.all().includes('a-wrong-secret-token'));
  assert.ok(!post.all().includes('a-wrong-secret-token'));
});

test('a branch other than the token\'s is explained', async (t) => {
  const s = await setup(t);
  const env = { ...s.env, GITHUB_HEAD_REF: 'someone-else' };
  const io = fakeIO({ path: s.paths, key: 'k' });
  await restore({ io, env, clientOptions });
  assert.match(io.log.warning[0], /different repository or branch/);
  assert.match(io.log.warning[0], /branch "someone-else"/);
});

test('409 on save is not a failure', async (t) => {
  const s = await setup(t);
  await save({ mode: 'save-only', io: fakeIO({ path: s.paths, key: 'k' }), env: s.env, clientOptions });
  const io = fakeIO({ path: s.paths, key: 'k' });
  assert.equal((await save({ mode: 'save-only', io, env: s.env, clientOptions })).result, 'exists');
  assert.deepEqual(io.log.warning, []);
  assert.deepEqual(io.log.failed, []);
});

test('413 on save explains the project limit', async (t) => {
  const s = await setup(t, { capBytes: 10 });
  const io = fakeIO({ path: s.paths, key: 'k' });
  assert.equal((await save({ mode: 'save-only', io, env: s.env, clientOptions })).result, 'failed');
  assert.match(io.log.warning[0], /larger than the cache limit/);
  assert.deepEqual(io.log.failed, []);
});

test('a 5xx on lookup is a warning, and a corrupt download is discarded', async (t) => {
  const s = await setup(t);
  s.svc.fail('POST', '/v1/cache/lookup', 500, { error: 'store_error', message: 'disk on fire' });
  const io = fakeIO({ path: s.paths, key: 'k' });
  await restore({ io, env: s.env, clientOptions });
  assert.match(io.log.warning[0], /server error: HTTP 500 store_error/);

  await save({ mode: 'save-only', io: fakeIO({ path: s.paths, key: 'k' }), env: s.env, clientOptions });
  [...s.svc.entries.values()][0].corrupt = true;
  s.wipe();
  const io2 = fakeIO({ path: s.paths, key: 'k' });
  assert.equal((await restore({ io: io2, env: s.env, clientOptions })).result, 'miss');
  assert.match(io2.log.warning[0], /integrity check/);
  assert.equal(s.restored(), false);
});

test('an unreachable service is a warning', async (t) => {
  const s = await setup(t);
  const io = fakeIO({ path: s.paths, key: 'k' });
  await restore({ io, env: { ...s.env, HELM_CACHE_URL: 'http://127.0.0.1:1' }, clientOptions: { ...clientOptions, attempts: 1 } });
  assert.match(io.log.warning[0], /could not reach the Helm build cache at http:\/\/127.0.0.1:1 \(ECONNREFUSED\)/);
});

test('paths that do not exist save nothing', async (t) => {
  const s = await setup(t);
  const io = fakeIO({ path: 'nothing-here', key: 'k' });
  assert.equal((await save({ mode: 'save-only', io, env: s.env, clientOptions })).result, 'no-files');
  assert.equal(s.svc.requests.length, 0);
});

test('the post step without a recorded key does nothing', async (t) => {
  const s = await setup(t);
  const io = fakeIO({ path: s.paths });
  assert.equal((await save({ mode: 'post', io, env: s.env, clientOptions })).result, 'skipped');
  assert.equal(io.log.state[State.PrimaryKey], undefined);
});
