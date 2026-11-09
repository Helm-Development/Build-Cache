'use strict';

// Turns errors from the cache service into sentences for the job log. None
// of them contains the token.

const { ServiceError, NetworkError, IntegrityError } = require('./client');

function formatBytes(n) {
  if (!Number.isFinite(n)) {
    return 'an unknown size';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(1)} ${units[i]} (${n} B)`;
}

// describe explains err. context holds the service URL and, where they
// apply, the repository, branch and archive size the action sent.
function describe(err, context = {}) {
  const where = context.url ? ` at ${context.url}` : '';
  if (err instanceof NetworkError) {
    return `The action could not reach the Helm build cache${where} (${err.code || err.message}). ` +
      'Check that this machine may reach the cache service.';
  }
  if (err instanceof IntegrityError) {
    return `The cache entry failed its integrity check: ${err.message}.`;
  }
  if (!(err instanceof ServiceError)) {
    return err && err.message ? err.message : String(err);
  }
  const detail = err.serviceMessage ? ` (${err.serviceMessage})` : '';
  switch (err.status) {
    case 401:
      if (err.code === 'token_expired') {
        return 'The build cache refused the job\'s token because it has expired. A token lasts as long as the job\'s time limit.';
      }
      if (err.code === 'token_missing') {
        return 'The build cache received no token.';
      }
      return `The build cache refused the job's token${detail}. The token in HELM_CACHE_TOKEN was not signed by this site's orchestrator key, or is damaged.`;
    case 403:
      if (err.code === 'client_not_allowed') {
        return 'The build cache does not accept connections from this machine\'s address. Only Helm CI builders may use it.';
      }
      if (err.code === 'scope_denied') {
        return `The build cache refused the request because the job's token is for a different repository or branch${detail}. ` +
          `The action sent repository "${context.repository || ''}" and branch "${context.branch || ''}". ` +
          'This happens when a runner picks up a different job than the one its token was issued for.';
      }
      if (err.code === 'wrong_token_kind') {
        return `HELM_CACHE_TOKEN holds a token of the wrong kind for saving or restoring${detail}. Only a job token works here.`;
      }
      return `The build cache refused the request: HTTP 403${err.code ? ` ${err.code}` : ''}${detail}.`;
    case 404:
      return 'The cache entry no longer exists. It was probably deleted to make room, or purged, after the lookup.';
    case 409:
      return 'An entry with this key already exists on this branch. Entries are never replaced, so nothing was saved.';
    case 411:
      return 'The build cache needs the upload size in advance (HTTP 411). This is a bug in the action.';
    case 413:
      return `The cache archive (${formatBytes(context.sizeBytes)}) is larger than the cache limit of this project${detail}. ` +
        'Cache fewer or smaller paths, or split them over several keys.';
    default:
      if (err.status >= 500) {
        return `The build cache had a server error: HTTP ${err.status}${err.code ? ` ${err.code}` : ''}${detail}. Try again later; if it keeps happening, check the helm-cache service on the registry machine.`;
      }
      return `The build cache refused the request: HTTP ${err.status}${err.code ? ` ${err.code}` : ''}${detail}.`;
  }
}

module.exports = { describe, formatBytes };
