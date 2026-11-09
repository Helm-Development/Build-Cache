'use strict';

// The four steps the action offers:
//
//   restore(..., {mode: 'main'})         main step of Helm-Development/Build-Cache
//   save(...,    {mode: 'post'})         its post step
//   restore(..., {mode: 'restore-only'}) Helm-Development/Build-Cache/restore
//   save(...,    {mode: 'save-only'})    Helm-Development/Build-Cache/save
//
// They behave like actions/cache, actions/cache/restore and
// actions/cache/save. A failure to reach or use the cache never fails the
// job; it is logged as a warning and the job builds without the cache. The
// exceptions, as in actions/cache, are an invalid key or path input and
// fail-on-cache-miss.

const fs = require('node:fs');
const path = require('node:path');
const core = require('@actions/core');

const config = require('./config');
const { CacheClient, ServiceError } = require('./client');
const archive = require('./archive');
const { describe, formatBytes } = require('./messages');

const State = {
  PrimaryKey: 'HELM_CACHE_PRIMARY_KEY',
  MatchedKey: 'HELM_CACHE_MATCHED_KEY',
};

const Outputs = {
  CacheHit: 'cache-hit',
  PrimaryKey: 'cache-primary-key',
  MatchedKey: 'cache-matched-key',
};

const NOT_CONFIGURED =
  'HELM_CACHE_URL or HELM_CACHE_TOKEN is not set, so the Helm build cache is skipped. ' +
  'This is expected on GitHub-hosted runners and for jobs that get no cache token, such as ones from forked pull requests.';

function defaultIO() {
  return {
    getInput: (name, opts) => core.getInput(name, opts),
    getBooleanInput: (name) => {
      const v = core.getInput(name).trim().toLowerCase();
      if (v === '' || v === 'false') return false;
      if (v === 'true') return true;
      throw new config.ValidationError(`The input ${name} must be "true" or "false", not "${v}".`);
    },
    setOutput: (k, v) => core.setOutput(k, v),
    saveState: (k, v) => core.saveState(k, v),
    getState: (k) => core.getState(k),
    setSecret: (s) => core.setSecret(s),
    info: (m) => core.info(m),
    notice: (m) => core.notice(m),
    warning: (m) => core.warning(m),
    setFailed: (m) => core.setFailed(m),
  };
}

function makeTempDir(env) {
  const root = config.tempRoot(env);
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, 'helm-build-cache-'));
}

function service(io, env) {
  const svc = config.readService(env);
  if (svc) {
    io.setSecret(svc.token);
  }
  return svc;
}

// restore runs the main step (mode "main") or the restore sub-action
// (mode "restore-only").
async function restore({ io = defaultIO(), env = process.env, clientOptions = {} } = {}) {
  try {
    const svc = service(io, env);
    const key = io.getInput('key', { required: true }).trim();
    const restoreKeys = config.splitLines(io.getInput('restore-keys'));
    const paths = config.splitLines(io.getInput('path', { required: true }));
    const failOnMiss = io.getBooleanInput('fail-on-cache-miss');
    const lookupOnly = io.getBooleanInput('lookup-only');
    if (paths.length === 0) {
      throw new config.ValidationError('The path input must name at least one path.');
    }
    config.validateKeys(key, restoreKeys);

    io.saveState(State.PrimaryKey, key);
    io.setOutput(Outputs.PrimaryKey, key);

    if (!svc) {
      io.notice(NOT_CONFIGURED);
      io.setOutput(Outputs.CacheHit, 'false');
      return { result: 'not-configured' };
    }

    const scope = config.readScope(env);
    const miss = (why) => {
      io.setOutput(Outputs.CacheHit, 'false');
      if (failOnMiss) {
        io.setFailed(`No cache entry was restored, and fail-on-cache-miss is set. Key: ${key}${why ? `. ${why}` : ''}`);
      } else {
        io.info(`No cache entry was found for the key ${key}${restoreKeys.length ? ` or the restore keys ${restoreKeys.join(', ')}` : ''}.`);
      }
      return { result: 'miss' };
    };

    if (!scope.repository || !scope.branch) {
      io.warning('GITHUB_REPOSITORY or the branch (GITHUB_HEAD_REF or GITHUB_REF_NAME) is not set, so the build cache is skipped.');
      return miss('The repository or branch is unknown.');
    }

    const client = new CacheClient({ url: svc.url, token: svc.token, ...clientOptions });
    const context = { url: svc.url, repository: scope.repository, branch: scope.branch };

    let answer;
    try {
      answer = await client.lookup({ repository: scope.repository, branch: scope.branch, key, restoreKeys });
    } catch (err) {
      io.warning(`${describe(err, context)} The job continues without the cache.`);
      return miss(describe(err, context));
    }
    if (!answer.hit) {
      return miss('');
    }
    const entry = answer.entry;
    const where = `saved on branch ${entry.branch}, ${formatBytes(entry.size_bytes)}`;

    if (lookupOnly) {
      io.saveState(State.MatchedKey, entry.key);
      io.setOutput(Outputs.MatchedKey, entry.key);
      io.setOutput(Outputs.CacheHit, String(answer.exact === true));
      io.info(`A cache entry exists for the key ${entry.key} (${where}). It was not downloaded because lookup-only is set.`);
      return { result: answer.exact ? 'exact' : 'partial', entry, downloaded: false };
    }

    const tempDir = makeTempDir(env);
    try {
      const file = path.join(tempDir, 'cache.archive');
      const started = Date.now();
      try {
        await client.download(entry, file);
      } catch (err) {
        io.warning(`${describe(err, context)} The job continues without the cache.`);
        return miss(describe(err, context));
      }
      const downloadedIn = ((Date.now() - started) / 1000).toFixed(1);
      try {
        await archive.extractArchive({ file, workspace: config.workspaceDir(env), env });
      } catch (err) {
        io.warning(`The cache entry for the key ${entry.key} could not be unpacked: ${err.message}. The job continues without the cache.`);
        return miss(err.message);
      }
      io.saveState(State.MatchedKey, entry.key);
      io.setOutput(Outputs.MatchedKey, entry.key);
      io.setOutput(Outputs.CacheHit, String(answer.exact === true));
      io.info(`Cache restored from the key ${entry.key} (${where}, downloaded in ${downloadedIn} s).`);
      return { result: answer.exact ? 'exact' : 'partial', entry, downloaded: true };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    io.setFailed(err.message);
    return { result: 'failed', error: err };
  }
}

// save runs the post step (mode "post") or the save sub-action (mode
// "save-only").
async function save({ mode = 'post', io = defaultIO(), env = process.env, clientOptions = {} } = {}) {
  try {
    const svc = service(io, env);
    let key;
    if (mode === 'post') {
      key = io.getState(State.PrimaryKey);
      if (!key) {
        io.info('The restore step recorded no key, so nothing is saved.');
        return { result: 'skipped' };
      }
      const matched = io.getState(State.MatchedKey);
      if (matched && matched === key) {
        io.info(`The cache was restored from its exact key ${key}, so it is not saved again.`);
        return { result: 'skipped' };
      }
    } else {
      key = io.getInput('key', { required: true }).trim();
      config.validateKey(key, 'key');
    }
    const patterns = config.splitLines(io.getInput('path', { required: true }));
    if (patterns.length === 0) {
      throw new config.ValidationError('The path input must name at least one path.');
    }

    if (!svc) {
      if (mode === 'post') {
        io.info(NOT_CONFIGURED);
      } else {
        io.notice(NOT_CONFIGURED);
      }
      return { result: 'not-configured' };
    }

    const scope = config.readScope(env);
    if (!scope.repository || !scope.branch) {
      io.warning('GITHUB_REPOSITORY or the branch (GITHUB_HEAD_REF or GITHUB_REF_NAME) is not set, so the cache is not saved.');
      return { result: 'skipped' };
    }

    const workspace = config.workspaceDir(env);
    const { relPaths, recursive } = await archive.resolvePaths(patterns, workspace);
    if (relPaths.length === 0) {
      io.warning(`None of the paths exist, so nothing was saved. Paths: ${patterns.join(', ')}`);
      return { result: 'no-files' };
    }

    const client = new CacheClient({ url: svc.url, token: svc.token, ...clientOptions });
    const tempDir = makeTempDir(env);
    try {
      const file = path.join(tempDir, 'cache.archive');
      const compression = archive.chooseCompression(env);
      let made;
      try {
        made = await archive.createArchive({ relPaths, workspace, file, compression, tempDir, recursive });
      } catch (err) {
        io.warning(`The cache archive could not be made, so nothing was saved: ${err.message}`);
        return { result: 'failed' };
      }
      if (made.warning) {
        io.warning(made.warning);
      }
      io.info(`Cache archive: ${formatBytes(made.sizeBytes)}, ${made.compression}.`);
      const context = { url: svc.url, repository: scope.repository, branch: scope.branch, sizeBytes: made.sizeBytes };
      try {
        const entry = await client.save({
          repository: scope.repository,
          branch: scope.branch,
          key,
          file,
          sizeBytes: made.sizeBytes,
          sha256: made.sha256,
        });
        io.info(`Cache saved with the key ${key} on branch ${entry.branch || scope.branch}.`);
        return { result: 'saved', entry };
      } catch (err) {
        if (err instanceof ServiceError && err.status === 409) {
          io.info(`An entry with the key ${key} already exists on branch ${scope.branch}. Entries are never replaced, so it was not saved again.`);
          return { result: 'exists' };
        }
        io.warning(`The cache was not saved. ${describe(err, context)}`);
        return { result: 'failed', error: err };
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    if (err instanceof config.ValidationError) {
      io.setFailed(err.message);
    } else {
      io.warning(`The cache was not saved: ${err.message}`);
    }
    return { result: 'failed', error: err };
  }
}

module.exports = { restore, save, State, Outputs, NOT_CONFIGURED };
