'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('../src/archive');

function layout(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hbc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work', 'repo');
  const outside = path.join(root, 'home', '.gradle', 'caches');
  fs.mkdirSync(path.join(workspace, 'Pods', 'A'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'Pods', 'A', 'a.txt'), 'pod');
  fs.writeFileSync(path.join(workspace, 'Pods', 'skip.log'), 'log');
  fs.writeFileSync(path.join(outside, 'dep.jar'), 'jar');
  const tempDir = path.join(root, 'tmp');
  fs.mkdirSync(tempDir);
  return { root, workspace, outside, tempDir };
}

test('resolvePaths stores paths relative to the workspace and honours "!"', async (t) => {
  const { workspace, outside } = layout(t);
  const { relPaths, recursive } = await archive.resolvePaths(['Pods/**', '!Pods/*.log', outside], workspace);
  assert.equal(recursive, false);
  assert.ok(relPaths.includes('Pods/A/a.txt'));
  assert.ok(!relPaths.some((p) => p.endsWith('skip.log')));
  assert.ok(relPaths.includes('../../home/.gradle/caches/dep.jar'));
});

test('without exclusions a directory is listed once, not with its contents', async (t) => {
  const { workspace, outside } = layout(t);
  const { relPaths, recursive } = await archive.resolvePaths(['Pods/**', outside], workspace);
  assert.equal(recursive, true);
  assert.deepEqual(relPaths.sort(), ['../../home/.gradle/caches', 'Pods'].sort());
});

test('an excluded file stays out of the archive', async (t) => {
  const { workspace, tempDir } = layout(t);
  const file = path.join(tempDir, 'cache.archive');
  const r = await archive.resolvePaths(['Pods', '!Pods/*.log'], workspace);
  await archive.createArchive({ ...r, workspace, file, compression: 'gzip', tempDir });
  fs.rmSync(path.join(workspace, 'Pods'), { recursive: true });
  await archive.extractArchive({ file, workspace });
  assert.equal(fs.existsSync(path.join(workspace, 'Pods', 'A', 'a.txt')), true);
  assert.equal(fs.existsSync(path.join(workspace, 'Pods', 'skip.log')), false);
});

test('resolvePaths returns nothing for paths that do not exist', async (t) => {
  const { workspace } = layout(t);
  assert.deepEqual((await archive.resolvePaths(['does-not-exist'], workspace)).relPaths, []);
});

for (const compression of ['gzip', 'zstd']) {
  test(`a ${compression} archive restores files inside and outside the workspace`, { skip: compression === 'zstd' && !archive.findProgram('zstd') }, async (t) => {
    const { workspace, outside, tempDir } = layout(t);
    const file = path.join(tempDir, 'cache.archive');
    const made = await archive.createArchive({ relPaths: ['Pods', '../../home/.gradle/caches'], workspace, file, compression, tempDir });
    assert.equal(made.compression, compression);
    assert.equal(made.sizeBytes, fs.statSync(file).size);
    assert.match(made.sha256, /^[0-9a-f]{64}$/);
    assert.equal(archive.detectCompression(file), compression);

    fs.rmSync(path.join(workspace, 'Pods'), { recursive: true });
    fs.rmSync(outside, { recursive: true });
    await archive.extractArchive({ file, workspace });
    assert.equal(fs.readFileSync(path.join(workspace, 'Pods', 'A', 'a.txt'), 'utf8'), 'pod');
    assert.equal(fs.readFileSync(path.join(outside, 'dep.jar'), 'utf8'), 'jar');
  });
}

test('a zstd archive on a machine without zstd is refused clearly', { skip: !archive.findProgram('zstd') }, async (t) => {
  const { workspace, tempDir } = layout(t);
  const file = path.join(tempDir, 'cache.archive');
  await archive.createArchive({ relPaths: ['Pods'], workspace, file, compression: 'zstd', tempDir });
  // findProgram looks only at env.PATH, so an empty directory stands for a
  // machine without zstd.
  const empty = path.join(tempDir, 'empty');
  fs.mkdirSync(empty);
  await assert.rejects(archive.extractArchive({ file, workspace, env: { PATH: empty } }), archive.MissingProgramError);
});

test('chooseCompression can be forced', () => {
  assert.equal(archive.chooseCompression({ HELM_CACHE_COMPRESSION: 'gzip', PATH: process.env.PATH }), 'gzip');
  assert.equal(archive.chooseCompression({ PATH: '' }), 'gzip');
});

// bsdtar stops reading at the end-of-archive marker, so a large zero
// padding after it makes the writer see EPIPE. That must not count as a
// failure.
for (const compression of ['gzip', 'zstd']) {
  test(`a ${compression} archive with long padding after its end marker extracts`, { skip: compression === 'zstd' && !archive.findProgram('zstd') }, async (t) => {
    const { workspace, tempDir } = layout(t);
    const { execFileSync } = require('node:child_process');
    const tarFile = path.join(tempDir, 'padded.tar');
    execFileSync('tar', ['-c', '-b', '2048', '-f', tarFile, '-C', workspace, 'Pods']);
    const file = path.join(tempDir, 'cache.archive');
    if (compression === 'gzip') {
      fs.writeFileSync(file, require('node:zlib').gzipSync(fs.readFileSync(tarFile)));
    } else {
      execFileSync('zstd', ['-q', '-o', file, tarFile]);
    }
    fs.rmSync(path.join(workspace, 'Pods'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      await archive.extractArchive({ file, workspace });
    }
    assert.equal(fs.readFileSync(path.join(workspace, 'Pods', 'A', 'a.txt'), 'utf8'), 'pod');
  });
}
