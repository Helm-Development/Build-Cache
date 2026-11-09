'use strict';

// Runs the action against a real helm-cache binary on this machine, with a
// key pair made by `helm-cache keygen` and tokens signed here the way the
// orchestrator signs them (JWT, EdDSA). Set HELM_CACHE_BIN to the binary:
//
//   HELM_CACHE_BIN=/path/to/helm-cache npm run test:integration
//
// Without HELM_CACHE_BIN the tests are skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { restore, save } = require('../../src/actions');
const { fakeIO } = require('../helpers/fake-io');

const BIN = process.env.HELM_CACHE_BIN;
const skip = !BIN && 'HELM_CACHE_BIN is not set';
const CAP = 2 * 1024 * 1024;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function signer(seedB64) {
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedB64, 'base64')]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return (claims) => {
    const now = Math.floor(Date.now() / 1000);
    const payload = { iss: 'helm-orchestrator', aud: 'helm-cache', iat: now, exp: now + 600, ...claims };
    const input = `${b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${b64url(crypto.sign(null, Buffer.from(input), key))}`;
  };
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitHealthy(url) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${url}/healthz`);
      if (r.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('helm-cache did not start');
}

test('the action against a real helm-cache', { skip }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-int-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const keys = execFileSync(BIN, ['keygen']).toString();
  const seed = /HELM_CACHE_SIGNING_KEY=(\S+)/.exec(keys)[1];
  const pub = /HELM_CACHE_PUBLIC_KEY=(\S+)/.exec(keys)[1];
  const sign = signer(seed);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    listen_address: `127.0.0.1:${port}`,
    data_dir: path.join(root, 'data'),
    project_cap_bytes: CAP,
    evict_at_disk_used_percent: 99,
    evict_unused_after_seconds: 0,
    token_public_key_ed25519: pub,
    allowed_clients: ['127.0.0.1'],
  }));
  fs.mkdirSync(path.join(root, 'data'));
  const proc = spawn(BIN, ['--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serviceLog = '';
  proc.stdout.on('data', (d) => { serviceLog += d; });
  proc.stderr.on('data', (d) => { serviceLog += d; });
  t.after(() => proc.kill());
  await waitHealthy(url);

  const repo = 'Helm-Development/Example';
  const jobToken = (branch) => sign({ kind: 'job', project_id: 'github-1', repository: repo, branch, default_branch: 'main', job_id: `job-${branch}`, triggered_by: 'octocat' });

  const workspace = path.join(root, 'work', 'repo');
  const gradle = path.join(root, 'home', '.gradle', 'caches');
  const reset = () => {
    fs.rmSync(path.join(root, 'work'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'home'), { recursive: true, force: true });
  };
  const populate = () => {
    fs.mkdirSync(path.join(workspace, 'Pods', 'Lib'), { recursive: true });
    fs.mkdirSync(gradle, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'Pods', 'Lib', 'lib.swift'), 'struct Lib {}\n');
    fs.writeFileSync(path.join(gradle, 'dep.jar'), 'jar bytes');
  };
  const paths = `Pods\n${gradle}`;
  const env = (branch, extra = {}) => ({
    PATH: process.env.PATH,
    HELM_CACHE_URL: url,
    HELM_CACHE_TOKEN: jobToken(branch),
    GITHUB_REPOSITORY: repo,
    GITHUB_REF_NAME: branch,
    GITHUB_HEAD_REF: '',
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: path.join(root, 'tmp'),
    ...extra,
  });

  await t.test('main saves with gzip; a pull request restores it from the default branch', async () => {
    reset(); populate();
    const s = fakeIO({ path: paths, key: 'deps-main-1' });
    const r = await save({ mode: 'save-only', io: s, env: env('main', { HELM_CACHE_COMPRESSION: 'gzip' }) });
    assert.equal(r.result, 'saved', s.all());
    reset();
    const prEnv = env('feature/a', { GITHUB_REF_NAME: '5/merge', GITHUB_HEAD_REF: 'feature/a' });
    const io = fakeIO({ path: paths, key: 'deps-feature-1', 'restore-keys': 'deps-' });
    const res = await restore({ io, env: prEnv });
    assert.equal(res.result, 'partial', io.all());
    assert.equal(io.log.outputs['cache-matched-key'], 'deps-main-1');
    assert.equal(fs.readFileSync(path.join(workspace, 'Pods', 'Lib', 'lib.swift'), 'utf8'), 'struct Lib {}\n');
    assert.equal(fs.readFileSync(path.join(gradle, 'dep.jar'), 'utf8'), 'jar bytes');

    // The post step saves to the pull request's own branch.
    const post = fakeIO({ path: paths }, io.log.state);
    assert.equal((await save({ mode: 'post', io: post, env: prEnv })).result, 'saved', post.all());
    const io2 = fakeIO({ path: paths, key: 'deps-feature-1' });
    assert.equal((await restore({ io: io2, env: prEnv })).result, 'exact');
    assert.match(io2.all(), /saved on branch feature\/a/);
  });

  await t.test('zstd archives round-trip', { skip: !require('../../src/archive').findProgram('zstd') }, async () => {
    reset(); populate();
    const s = fakeIO({ path: paths, key: 'deps-zstd' });
    assert.equal((await save({ mode: 'save-only', io: s, env: env('main', { HELM_CACHE_COMPRESSION: 'zstd' }) })).result, 'saved', s.all());
    assert.match(s.all(), /zstd/);
    reset();
    const io = fakeIO({ path: paths, key: 'deps-zstd' });
    assert.equal((await restore({ io, env: env('main') })).result, 'exact', io.all());
    assert.equal(fs.readFileSync(path.join(gradle, 'dep.jar'), 'utf8'), 'jar bytes');
  });

  await t.test('saving the same key again is 409 and not a failure', async () => {
    reset(); populate();
    const s = fakeIO({ path: paths, key: 'deps-main-1' });
    assert.equal((await save({ mode: 'save-only', io: s, env: env('main') })).result, 'exists', s.all());
  });

  await t.test('a token for another branch is refused with 403 scope_denied', async () => {
    reset(); populate();
    const e = env('main', { HELM_CACHE_TOKEN: jobToken('feature/b') });
    const io = fakeIO({ path: paths, key: 'deps-main-1' });
    assert.equal((await restore({ io, env: e })).result, 'miss');
    assert.match(io.log.warning[0], /different repository or branch \(the token is for another branch\)/);
    const s = fakeIO({ path: paths, key: 'x' });
    await save({ mode: 'save-only', io: s, env: e });
    assert.match(s.log.warning[0], /different repository or branch/);
  });

  await t.test('an expired token and a token signed with another key get 401', async () => {
    reset(); populate();
    const now = Math.floor(Date.now() / 1000);
    const expired = sign({ kind: 'job', project_id: 'github-1', repository: repo, branch: 'main', default_branch: 'main', job_id: 'j', iat: now - 7200, exp: now - 3600 });
    const io = fakeIO({ path: paths, key: 'deps-main-1' });
    await restore({ io, env: env('main', { HELM_CACHE_TOKEN: expired }) });
    assert.match(io.log.warning[0], /has expired/);

    const other = signer(crypto.randomBytes(32).toString('base64'));
    const forged = other({ kind: 'job', project_id: 'github-1', repository: repo, branch: 'main', default_branch: 'main', job_id: 'j' });
    const io2 = fakeIO({ path: paths, key: 'deps-main-1' });
    await restore({ io: io2, env: env('main', { HELM_CACHE_TOKEN: forged }) });
    assert.match(io2.log.warning[0], /refused the job's token/);
    assert.ok(!io2.all().includes(forged));
  });

  await t.test('a host token on the job paths gets 403 wrong_token_kind', async () => {
    const host = sign({ kind: 'host', host_id: 'h1', site_id: 's1' });
    const io = fakeIO({ path: paths, key: 'k' });
    await restore({ io, env: env('main', { HELM_CACHE_TOKEN: host }) });
    assert.match(io.log.warning[0], /wrong kind/);
  });

  await t.test('an archive larger than the project cap gets 413', async () => {
    reset(); populate();
    fs.writeFileSync(path.join(workspace, 'Pods', 'big.bin'), crypto.randomBytes(CAP + 512 * 1024));
    const s = fakeIO({ path: paths, key: 'deps-big' });
    assert.equal((await save({ mode: 'save-only', io: s, env: env('main') })).result, 'failed');
    assert.match(s.log.warning[0], /larger than the cache limit/, s.all());
  });

  await t.test('the service records what the action saved', async () => {
    const host = sign({ kind: 'host', host_id: 'h1', site_id: 's1' });
    const usage = await (await fetch(`${url}/v1/usage`, { headers: { Authorization: `Bearer ${host}` } })).json();
    const entries = usage.projects[0].repositories[0].entries;
    const keys = entries.map((e) => `${e.branch}:${e.key}`).sort();
    assert.deepEqual(keys, ['feature/a:deps-feature-1', 'main:deps-main-1', ...(entries.length === 3 ? ['main:deps-zstd'] : [])].sort());
    assert.equal(usage.projects[0].repositories[0].repository, 'helm-development/example');
  });

  // The service log must never contain a token.
  assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(serviceLog), 'a token appeared in the helm-cache log');
});
