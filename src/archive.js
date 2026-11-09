'use strict';

// Makes and unpacks cache archives: a tar archive compressed with zstd when
// the zstd program is installed, and with gzip otherwise. Paths are stored
// relative to the workspace, as actions/cache stores them, so "~/.gradle"
// becomes something like "../../../.gradle". Restoring reads the first bytes
// of the archive to tell zstd from gzip, so an entry restores on any
// machine that has the program it needs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { Transform, PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const glob = require('@actions/glob');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

// findProgram returns the full path of an executable on PATH, or null.
function findProgram(name, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not here.
    }
  }
  return null;
}

// chooseCompression picks zstd when its program is installed. The
// environment variable HELM_CACHE_COMPRESSION ("zstd" or "gzip") overrides
// the choice, which the tests use.
function chooseCompression(env = process.env) {
  const forced = (env.HELM_CACHE_COMPRESSION || '').trim().toLowerCase();
  if (forced === 'gzip') return 'gzip';
  if (forced === 'zstd') return 'zstd';
  return findProgram('zstd', env.PATH) ? 'zstd' : 'gzip';
}

// resolvePaths expands the path input (globs, "~", and "!" exclusions, as
// in actions/cache) and returns {relPaths, recursive}: the matching paths
// relative to workspace, with "/" as the separator, and whether tar must
// descend into directories itself.
//
// Without exclusions, a matched directory is archived with everything in
// it, and a path inside an already listed directory is dropped. With an
// exclusion, every file is listed one by one and tar is told not to
// descend, so that excluded files really stay out of the archive.
async function resolvePaths(patterns, workspace) {
  const hasExclusion = patterns.some((p) => p.startsWith('!'));
  const anchored = patterns.map((p) => {
    const negate = p.startsWith('!');
    const body = negate ? p.slice(1) : p;
    if (path.isAbsolute(body) || body === '~' || body.startsWith('~/')) {
      return p;
    }
    return (negate ? '!' : '') + path.join(workspace, body);
  });
  const globber = await glob.create(anchored.join('\n'), { implicitDescendants: hasExclusion });
  const found = (await globber.glob()).sort();
  const rel = [];
  const seen = new Set();
  let lastDir = null;
  for (const p of found) {
    if (!hasExclusion && lastDir !== null && p.startsWith(lastDir + path.sep)) {
      continue;
    }
    let r = path.relative(workspace, p).split(path.sep).join('/');
    if (r === '') r = '.';
    if (seen.has(r)) continue;
    seen.add(r);
    rel.push(r);
    if (!hasExclusion) {
      lastDir = p;
    }
  }
  return { relPaths: rel, recursive: !hasExclusion };
}

// run starts a program and returns its child process and a promise that
// resolves with its exit code and the end of its standard error.
function run(cmd, args, options = {}) {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 20000) stderr = stderr.slice(-20000);
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stderr }));
  });
  return { child, done };
}

function hashingTap() {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  return { tap, result: () => ({ sha256: hash.digest('hex'), sizeBytes: size }) };
}

// GNU tar exits with 1 when a file changed while it was read (for example,
// a Gradle daemon still writing). The archive is still usable, so that is
// reported as a warning, not a failure.
function onlyChangedWhileRead(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /file changed as we read it|socket ignored/.test(l));
}

// createArchive writes the archive of relPaths (relative to workspace) to
// file and returns its compression, size, SHA-256 digest and any warning.
async function createArchive({ relPaths, workspace, file, compression, tempDir, recursive = true }) {
  const list = path.join(tempDir, 'manifest.txt');
  fs.writeFileSync(list, relPaths.join('\n') + '\n');
  const tar = run('tar', ['-c', '-f', '-', '-P', ...(recursive ? [] : ['--no-recursion']), '-C', workspace, '-T', list]);
  const { tap, result } = hashingTap();
  const out = fs.createWriteStream(file);

  let compressor;
  let compressorDone = Promise.resolve({ code: 0, stderr: '' });
  if (compression === 'zstd') {
    const z = run('zstd', ['-T0', '-3', '-q', '-c']);
    compressor = z.child;
    compressorDone = z.done;
    tar.child.stdout.pipe(z.child.stdin);
    z.child.stdin.on('error', () => {});
  } else {
    compressor = null;
  }
  const source = compressor ? compressor.stdout : tar.child.stdout.pipe(zlib.createGzip({ level: 6 }));
  const written = pipeline(source, tap, out);

  const [tarResult, compResult] = await Promise.all([tar.done, compressorDone, written]);
  let warning = '';
  if (tarResult.code !== 0) {
    if (tarResult.code === 1 && onlyChangedWhileRead(tarResult.stderr)) {
      warning = `tar reported files that changed while they were archived:\n${tarResult.stderr.trim()}`;
    } else {
      throw new Error(`tar failed with exit code ${tarResult.code}: ${tarResult.stderr.trim()}`);
    }
  }
  if (compResult.code !== 0) {
    throw new Error(`zstd failed with exit code ${compResult.code}: ${compResult.stderr.trim()}`);
  }
  return { compression, ...result(), warning };
}

// detectCompression reads the archive's first bytes.
function detectCompression(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4);
    const n = fs.readSync(fd, head, 0, 4, 0);
    if (n >= 4 && head.equals(ZSTD_MAGIC)) return 'zstd';
    if (n >= 2 && head.subarray(0, 2).equals(GZIP_MAGIC)) return 'gzip';
    return 'unknown';
  } finally {
    fs.closeSync(fd);
  }
}

class MissingProgramError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingProgramError';
  }
}

// extractArchive unpacks file into workspace (paths outside the workspace,
// such as "~/.gradle", land where they were archived from).
async function extractArchive({ file, workspace, env = process.env }) {
  const compression = detectCompression(file);
  if (compression === 'unknown') {
    throw new Error('the cache entry is neither a zstd nor a gzip archive');
  }
  fs.mkdirSync(workspace, { recursive: true });
  const tar = run('tar', ['-x', '-f', '-', '-P', '-C', workspace]);
  tar.child.stdin.on('error', () => {});
  let decompressDone = Promise.resolve({ code: 0, stderr: '' });
  let feed;
  if (compression === 'zstd') {
    if (!findProgram('zstd', env.PATH)) {
      tar.child.stdin.end();
      await tar.done;
      throw new MissingProgramError('the cache entry is compressed with zstd, and the zstd program is not installed on this machine');
    }
    const z = run('zstd', ['-d', '-q', '-c', file]);
    z.child.stdin.end();
    decompressDone = z.done;
    feed = pipeline(z.child.stdout, tar.child.stdin);
  } else {
    feed = pipeline(fs.createReadStream(file), zlib.createGunzip(), new PassThrough(), tar.child.stdin);
  }
  const results = await Promise.allSettled([feed, decompressDone, tar.done]);
  const tarResult = results[2].status === 'fulfilled' ? results[2].value : null;
  const zResult = results[1].status === 'fulfilled' ? results[1].value : null;
  if (!tarResult) {
    throw results[2].reason;
  }
  if (tarResult.code !== 0) {
    const z = zResult && zResult.code !== 0 && zResult.stderr.trim() ? ` (zstd: ${zResult.stderr.trim()})` : '';
    const feedError = results[0].status === 'rejected' ? ` (reading the archive: ${results[0].reason.message})` : '';
    throw new Error(`tar failed with exit code ${tarResult.code}: ${tarResult.stderr.trim()}${z}${feedError}`);
  }
  // tar succeeded, so it read a complete archive up to its end marker. The
  // macOS tar (bsdtar) stops reading there and closes its input before the
  // zero padding that follows, so writing the rest can fail with EPIPE and
  // zstd can stop early. Neither matters: the archive's SHA-256 digest was
  // checked before extraction, and a truncated archive makes tar fail.
  return { compression };
}

module.exports = {
  findProgram,
  chooseCompression,
  resolvePaths,
  createArchive,
  extractArchive,
  detectCompression,
  MissingProgramError,
};
