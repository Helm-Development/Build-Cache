'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');

test('readService needs both variables, and empty ones count as missing', () => {
  assert.equal(config.readService({}), null);
  assert.equal(config.readService({ HELM_CACHE_URL: 'http://cache.example.internal:8484' }), null);
  assert.equal(config.readService({ HELM_CACHE_URL: '', HELM_CACHE_TOKEN: '' }), null);
  assert.deepEqual(config.readService({ HELM_CACHE_URL: 'http://cache.example.internal:8484/', HELM_CACHE_TOKEN: 't' }),
    { url: 'http://cache.example.internal:8484', token: 't' });
  assert.throws(() => config.readService({ HELM_CACHE_URL: 'ftp://x', HELM_CACHE_TOKEN: 't' }), /http/);
});

test('readScope uses the pull request head branch when there is one', () => {
  assert.deepEqual(config.readScope({ GITHUB_REPOSITORY: 'o/r', GITHUB_REF_NAME: '12/merge', GITHUB_HEAD_REF: 'feature/a' }),
    { repository: 'o/r', branch: 'feature/a' });
  assert.deepEqual(config.readScope({ GITHUB_REPOSITORY: 'o/r', GITHUB_REF_NAME: 'main', GITHUB_HEAD_REF: '' }),
    { repository: 'o/r', branch: 'main' });
});

test('keys follow the service rules', () => {
  config.validateKey('gradle-Linux-abc');
  assert.throws(() => config.validateKey(''), /empty/);
  assert.throws(() => config.validateKey('..'), /empty/);
  assert.throws(() => config.validateKey('a\tb'), /control/);
  assert.throws(() => config.validateKey('x'.repeat(513)), /513 bytes/);
  config.validateKey('é'.repeat(256)); // 512 bytes
  assert.throws(() => config.validateKeys('k', Array.from({ length: 21 }, (_, i) => `p${i}`)), /21 restore keys/);
});

test('splitLines drops blank lines and spaces', () => {
  assert.deepEqual(config.splitLines(' a \n\n b\n'), ['a', 'b']);
});
