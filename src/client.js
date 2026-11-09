'use strict';

// HTTP client for the Helm build cache service (helm-cache). The API is
// described in Fleet-Orchestrator's cache/README.md:
//
//   POST /v1/cache/lookup                      find the entry to restore
//   GET  /v1/cache/entries/{id}                download an entry
//   PUT  /v1/cache/save?repository&branch&key  upload a new entry
//
// The token is sent only in the Authorization header. It never appears in
// an error message, a log line or a URL.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const DIGEST_HEADER = 'x-helm-cache-sha256';
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_ATTEMPTS = 3;
const MAX_ERROR_BODY = 64 * 1024;

// Network errors worth another try. A refused or reset connection often
// means the service is restarting.
const RETRY_NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'IDLE_TIMEOUT',
]);
const RETRY_STATUSES = new Set([502, 503, 504]);

// ServiceError is an answer from the service other than the one expected.
class ServiceError extends Error {
  constructor(status, code, message) {
    super(`HTTP ${status}${code ? ` ${code}` : ''}: ${message || 'no message'}`);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code || '';
    this.serviceMessage = message || '';
  }
}

// NetworkError means no answer arrived.
class NetworkError extends Error {
  constructor(cause) {
    super(cause.message);
    this.name = 'NetworkError';
    this.code = cause.code || '';
  }
}

// IntegrityError means a download did not match its digest or size.
class IntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IntegrityError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CacheClient {
  constructor({ url, token, attempts = DEFAULT_ATTEMPTS, idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, retryDelayMs = 1000, userAgent = 'helm-build-cache' }) {
    this.base = new URL(url.endsWith('/') ? url : `${url}/`);
    this.token = token;
    this.attempts = attempts;
    this.idleTimeoutMs = idleTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.userAgent = userAgent;
  }

  // send makes one request. body is a function that returns a fresh
  // readable stream, a Buffer, or undefined. It resolves with the response
  // stream still unread.
  send(method, path, { headers = {}, body } = {}) {
    const target = new URL(path.replace(/^\//, ''), this.base);
    const lib = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(target, {
        method,
        headers: {
          'User-Agent': this.userAgent,
          Accept: 'application/json',
          Authorization: `Bearer ${this.token}`,
          ...headers,
        },
      });
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(new NetworkError(err));
        }
      };
      req.setTimeout(this.idleTimeoutMs, () => {
        const err = new Error(`no data for ${Math.round(this.idleTimeoutMs / 1000)} seconds`);
        err.code = 'IDLE_TIMEOUT';
        req.destroy(err);
      });
      req.on('error', fail);
      req.on('response', (res) => {
        settled = true;
        res.setTimeout(this.idleTimeoutMs, () => {
          const err = new Error(`no data for ${Math.round(this.idleTimeoutMs / 1000)} seconds`);
          err.code = 'IDLE_TIMEOUT';
          res.destroy(err);
        });
        resolve(res);
      });
      const b = typeof body === 'function' ? body() : body;
      if (b === undefined) {
        req.end();
      } else if (Buffer.isBuffer(b) || typeof b === 'string') {
        req.end(b);
      } else {
        b.on('error', (err) => req.destroy(err));
        b.pipe(req);
      }
    });
  }

  // request retries send on network errors and on 502, 503 and 504.
  async request(method, path, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const res = await this.send(method, path, options);
        if (RETRY_STATUSES.has(res.statusCode) && attempt < this.attempts) {
          lastError = await errorFrom(res);
          await sleep(this.retryDelayMs * attempt);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        if (!(err instanceof NetworkError) || !RETRY_NETWORK_CODES.has(err.code) || attempt >= this.attempts) {
          throw err;
        }
        await sleep(this.retryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  // lookup asks for the entry to restore. It resolves with
  // {hit, exact, entry}; entry is absent on a miss.
  async lookup({ repository, branch, key, restoreKeys }) {
    const body = Buffer.from(JSON.stringify({ repository, branch, key, restore_keys: restoreKeys }));
    const res = await this.request('POST', '/v1/cache/lookup', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length) },
      body,
    });
    if (res.statusCode !== 200) {
      throw await errorFrom(res);
    }
    const answer = await readJSON(res);
    if (typeof answer.hit !== 'boolean') {
      throw new ServiceError(res.statusCode, 'bad_response', 'the lookup answer has no "hit" field');
    }
    if (answer.hit && (!answer.entry || typeof answer.entry.id !== 'string')) {
      throw new ServiceError(res.statusCode, 'bad_response', 'the lookup answer is a hit without an entry');
    }
    return answer;
  }

  // download writes the entry's bytes to file and checks them against the
  // entry's SHA-256 digest and size. A mismatch deletes the file and throws
  // IntegrityError.
  async download(entry, file) {
    const path = entry.download_path || `/v1/cache/entries/${entry.id}`;
    const res = await this.request('GET', path);
    if (res.statusCode !== 200) {
      throw await errorFrom(res);
    }
    const expected = String(res.headers[DIGEST_HEADER] || entry.sha256 || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      res.resume();
      throw new IntegrityError('the service sent no SHA-256 digest for the entry');
    }
    const hash = crypto.createHash('sha256');
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(res, tap, fs.createWriteStream(file));
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err.name === 'NetworkError' ? err : new NetworkError(err);
    }
    const actual = hash.digest('hex');
    const declared = res.headers['content-length'];
    if (declared !== undefined && Number(declared) !== size) {
      fs.rmSync(file, { force: true });
      throw new IntegrityError(`the download stopped after ${size} of ${declared} bytes`);
    }
    if (actual !== expected) {
      fs.rmSync(file, { force: true });
      throw new IntegrityError(`the download's SHA-256 (${actual}) differs from the entry's (${expected}); it was discarded`);
    }
    if (entry.sha256 && String(entry.sha256).toLowerCase() !== expected) {
      fs.rmSync(file, { force: true });
      throw new IntegrityError('the digest in the download header differs from the one in the lookup answer; the download was discarded');
    }
    return { sizeBytes: size, sha256: actual };
  }

  // save uploads file as a new entry. It resolves with the saved entry, or
  // throws ServiceError (409 already_exists when the key exists on this
  // branch, 413 too_large when the entry is larger than the project cap).
  async save({ repository, branch, key, file, sizeBytes, sha256 }) {
    const query = new URLSearchParams({ repository, branch, key }).toString();
    const res = await this.request('PUT', `/v1/cache/save?${query}`, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(sizeBytes),
        'X-Helm-Cache-Sha256': sha256,
      },
      body: () => fs.createReadStream(file),
    });
    if (res.statusCode !== 201) {
      throw await errorFrom(res);
    }
    return readJSON(res);
  }
}

async function readBody(res, limit = MAX_ERROR_BODY) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    if (total < limit) {
      chunks.push(chunk);
    }
    total += chunk.length;
  }
  return Buffer.concat(chunks).subarray(0, limit).toString('utf8');
}

async function readJSON(res) {
  const text = await readBody(res, 16 * 1024 * 1024);
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(res.statusCode, 'bad_response', 'the answer is not JSON');
  }
}

// errorFrom turns an error answer into a ServiceError. The service answers
// errors as {"error": "<code>", "message": "<text>"}.
async function errorFrom(res) {
  let text = '';
  try {
    text = await readBody(res);
  } catch {
    // The status code alone is enough.
  }
  let code = '';
  let message = text.trim().slice(0, 300);
  try {
    const body = JSON.parse(text);
    code = typeof body.error === 'string' ? body.error : '';
    message = typeof body.message === 'string' ? body.message : message;
  } catch {
    // Not JSON, for example a proxy's HTML page.
  }
  return new ServiceError(res.statusCode, code, message);
}

module.exports = {
  CacheClient,
  ServiceError,
  NetworkError,
  IntegrityError,
  DIGEST_HEADER,
};
