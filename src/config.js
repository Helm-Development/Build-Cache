'use strict';

// Reads what the action needs from the environment and from the step's
// inputs, and checks keys before anything is sent to the cache service.

// The cache service accepts keys of 1 to 512 bytes with no control
// characters, and at most 20 restore keys (cache/README.md in
// Fleet-Orchestrator).
const MAX_KEY_BYTES = 512;
const MAX_RESTORE_KEYS = 20;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// readService returns the cache service's address and the job's token, or
// null when either variable is missing or empty. A Helm build VM's guest
// bootstrap sets both; a GitHub-hosted runner sets neither, and a Helm job
// that got no token (for example, one from a forked pull request) has both
// set to empty strings.
function readService(env = process.env) {
  const url = (env.HELM_CACHE_URL || '').trim();
  const token = (env.HELM_CACHE_TOKEN || '').trim();
  if (!url || !token) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError(`HELM_CACHE_URL is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError(`HELM_CACHE_URL must start with http:// or https://, not ${parsed.protocol}`);
  }
  return { url: url.replace(/\/+$/, ''), token };
}

// readScope returns the repository and branch this job builds, which the
// service compares with its token. For a pull request the branch is the
// pull request's head branch (GITHUB_HEAD_REF); otherwise it is
// GITHUB_REF_NAME. This is the rule in cache/README.md, and it matches the
// branch the orchestrator puts in the token (workflow_job.head_branch).
function readScope(env = process.env) {
  const repository = (env.GITHUB_REPOSITORY || '').trim();
  const branch = ((env.GITHUB_HEAD_REF || '').trim()) || (env.GITHUB_REF_NAME || '').trim();
  return { repository, branch };
}

function workspaceDir(env = process.env) {
  return env.GITHUB_WORKSPACE || process.cwd();
}

function tempRoot(env = process.env) {
  return env.RUNNER_TEMP || require('node:os').tmpdir();
}

// splitLines turns a multi-line input into its non-empty, trimmed lines,
// as actions/cache does.
function splitLines(value) {
  return String(value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function validateKey(key, what = 'key') {
  if (key === '' || key === '.' || key === '..') {
    throw new ValidationError(`The ${what} must not be empty, "." or "..".`);
  }
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_KEY_BYTES) {
    throw new ValidationError(`The ${what} is ${bytes} bytes long; the most the cache allows is ${MAX_KEY_BYTES}. Key: ${key}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(key)) {
    throw new ValidationError(`The ${what} contains a control character (for example a tab or a line break). Key: ${JSON.stringify(key)}`);
  }
}

function validateKeys(key, restoreKeys) {
  validateKey(key, 'key');
  if (restoreKeys.length > MAX_RESTORE_KEYS) {
    throw new ValidationError(`There are ${restoreKeys.length} restore keys; the most the cache allows is ${MAX_RESTORE_KEYS}.`);
  }
  for (const k of restoreKeys) {
    validateKey(k, 'restore key');
  }
}

module.exports = {
  MAX_KEY_BYTES,
  MAX_RESTORE_KEYS,
  ValidationError,
  readService,
  readScope,
  workspaceDir,
  tempRoot,
  splitLines,
  validateKey,
  validateKeys,
};
