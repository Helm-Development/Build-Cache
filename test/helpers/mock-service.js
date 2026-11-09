'use strict';

// A small stand-in for helm-cache that keeps entries in memory. It follows
// the API in Fleet-Orchestrator's cache/README.md closely enough for the
// action's tests: bearer token check, repository and branch scope, exact
// key then restore-key prefixes (own branch before the default branch),
// SHA-256 digests, 409 for an existing key and 413 above a size limit.

const crypto = require('node:crypto');
const http = require('node:http');

function startMockService({ token = 'test-token', repository = 'helm-development/example', branch = 'feature/x', defaultBranch = 'main', capBytes = 50 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const requests = [];
  const failures = []; // {method, path, status, error, times}
  let clock = 0;

  const idFor = (b, key) => crypto.createHash('sha256').update(`${repository}\n${b}\n${key}`).digest('hex');

  function addEntry(b, key, data) {
    const id = idFor(b, key);
    const e = {
      id,
      project_id: 'github-1',
      repository,
      branch: b,
      key,
      size_bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      created_at: new Date(Date.UTC(2026, 10, 9, 0, 0, clock++)).toISOString(),
      data,
    };
    entries.set(id, e);
    return e;
  }

  const view = (e) => {
    const { data, ...rest } = e;
    return { ...rest, download_path: `/v1/cache/entries/${e.id}` };
  };

  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    const f = failures.find((x) => x.method === req.method && url.pathname.startsWith(x.path) && x.times > 0);
    if (f) {
      f.times--;
      if (f.destroy) {
        req.socket.destroy();
        return;
      }
      send(res, f.status, { error: f.error || 'forced', message: f.message || 'forced failure' });
      return;
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: 'token_invalid', message: 'token signature does not match the orchestrator\'s key' });
      return;
    }
    const inScope = (r, b) => String(r).toLowerCase() === repository && b === branch;
    const readBranches = branch === defaultBranch ? [branch] : [branch, defaultBranch];

    if (req.method === 'POST' && url.pathname === '/v1/cache/lookup') {
      const q = JSON.parse(body.toString());
      if (!inScope(q.repository, q.branch)) {
        send(res, 403, { error: 'scope_denied', message: 'the token is for another branch' });
        return;
      }
      for (const b of readBranches) {
        const e = entries.get(idFor(b, q.key));
        if (e) {
          send(res, 200, { hit: true, exact: true, entry: view(e) });
          return;
        }
      }
      for (const prefix of q.restore_keys || []) {
        for (const b of readBranches) {
          const found = [...entries.values()].filter((e) => e.branch === b && e.key.startsWith(prefix))
            .sort((a, c) => c.created_at.localeCompare(a.created_at));
          if (found.length) {
            send(res, 200, { hit: true, exact: false, entry: view(found[0]) });
            return;
          }
        }
      }
      send(res, 200, { hit: false, exact: false });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/v1/cache/entries/')) {
      const e = entries.get(url.pathname.split('/').pop());
      if (!e || !readBranches.includes(e.branch)) {
        send(res, 404, { error: 'not_found', message: 'no such entry for this token' });
        return;
      }
      const data = e.corrupt ? Buffer.concat([e.data, Buffer.from('x')]) : e.data;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length, 'X-Helm-Cache-Sha256': e.sha256 });
      res.end(data);
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/v1/cache/save') {
      const q = Object.fromEntries(url.searchParams);
      if (!inScope(q.repository, q.branch)) {
        send(res, 403, { error: 'scope_denied', message: 'the token is for another branch' });
        return;
      }
      if (entries.has(idFor(branch, q.key))) {
        send(res, 409, { error: 'already_exists', message: 'an entry with this key already exists' });
        return;
      }
      if (body.length > capBytes) {
        send(res, 413, { error: 'too_large', message: 'the entry is larger than the project cap' });
        return;
      }
      const digest = crypto.createHash('sha256').update(body).digest('hex');
      if (digest !== req.headers['x-helm-cache-sha256']) {
        send(res, 400, { error: 'digest_mismatch', message: 'digest mismatch' });
        return;
      }
      send(res, 201, view(addEntry(branch, q.key, body)));
      return;
    }
    send(res, 404, { error: 'not_found', message: 'no route' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        token,
        entries,
        requests,
        addEntry,
        fail: (method, path, status, opts = {}) => failures.push({ method, path, status, times: 1, ...opts }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockService };
