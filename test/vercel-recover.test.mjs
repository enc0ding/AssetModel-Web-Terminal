import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, safeRelativePath, resolveUnder, flattenTree, createClient, recover, verify, UsageError } from '../tools/vercel-recover/vercel-recover.mjs';

const TOKEN = 'test-token-123';
const DEPLOYMENT = 'dpl_test123';

/** Minimal fake of the three Vercel endpoints the tool uses. */
function fakeVercel({ flakyOnce = false } = {}) {
  const calls = [];
  let flaked = false;
  const tree = [
    { name: 'package.json', type: 'file', uid: 'u-pkg', mode: 33188 },
    { name: 'src', type: 'directory', children: [
      { name: 'index.ts', type: 'file', uid: 'u-index', mode: 33188 },
      { name: 'nested', type: 'directory', children: [{ name: 'a.txt', type: 'file', uid: 'u-a' }] },
    ] },
    { name: 'node_modules', type: 'directory', children: [{ name: 'evil', type: 'directory', children: [{ name: 'index.js', type: 'file', uid: 'u-evil' }] }] },
    { name: '..', type: 'file', uid: 'u-dotdot' },
    { name: 'bad/slash', type: 'file', uid: 'u-slash' },
    { name: 'link', type: 'symlink', uid: 'u-link', link: '/etc/passwd' },
    { name: 'binary.png', type: 'file', uid: 'u-bin' },
    { name: 'json-envelope.txt', type: 'file', uid: 'u-env' },
  ];
  const contents = {
    'u-pkg': { body: '{"name":"x"}', type: 'application/json' }, // raw JSON that is NOT the envelope
    'u-index': { body: 'export const x = 1;\n', type: 'text/plain' },
    'u-a': { body: 'hello', type: 'text/plain' },
    'u-evil': { body: 'nope', type: 'text/plain' },
    'u-bin': { body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]), type: 'application/octet-stream' },
    'u-env': { body: JSON.stringify({ data: Buffer.from('decoded!').toString('base64') }), type: 'application/json' },
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    calls.push({ path: url.pathname, team: url.searchParams.get('teamId'), auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(403); res.end('{"error":{"code":"forbidden"}}'); return; }
    if (url.pathname === `/v13/deployments/${DEPLOYMENT}`) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: DEPLOYMENT, url: 'x.vercel.app', name: 'x', target: 'production', meta: { githubCommitSha: 'abc' } })); return; }
    if (url.pathname === `/v6/deployments/${DEPLOYMENT}/files`) {
      if (flakyOnce && !flaked) { flaked = true; res.writeHead(429, { 'retry-after': '0' }); res.end('slow down'); return; }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(tree)); return;
    }
    const m = url.pathname.match(new RegExp(`^/v8/deployments/${DEPLOYMENT}/files/(.+)$`));
    if (m && contents[m[1]]) { const c = contents[m[1]]; res.setHeader('content-type', c.type); res.end(c.body); return; }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolveP) => server.listen(0, '127.0.0.1', () => resolveP({ server, calls, api: `http://127.0.0.1:${server.address().port}` })));
}

test('parseArgs validates input', () => {
  assert.deepEqual(parseArgs(['--deployment', 'dpl_1', '--team', 't', '--out', 'o']).deployment, 'dpl_1');
  assert.throws(() => parseArgs(['--deployment']), UsageError);
  assert.throws(() => parseArgs(['--bogus']), UsageError);
  assert.throws(() => parseArgs(['--concurrency', '0']), UsageError);
  assert.throws(() => parseArgs(['--concurrency', '99']), UsageError);
});

test('safeRelativePath rejects traversal and separators', () => {
  assert.equal(safeRelativePath(['a', 'b.txt']), 'a/b.txt');
  for (const bad of [['..'], ['a', '..', 'b'], ['.'], ['a/b'], ['a\\b'], ['a\0b'], [''], []]) assert.throws(() => safeRelativePath(bad), `should reject ${JSON.stringify(bad)}`);
});

test('resolveUnder never escapes the output directory', () => {
  assert.ok(resolveUnder('/tmp/out', 'a/b').startsWith('/tmp/out/'));
  assert.throws(() => resolveUnder('/tmp/out', '../x'));
  assert.throws(() => resolveUnder('/tmp/out', '/etc/passwd'));
});

test('flattenTree skips node_modules, symlinks and hostile names', () => {
  const { files, symlinks, skipped } = flattenTree([
    { name: 'ok.js', type: 'file', uid: '1' },
    { name: 'node_modules', type: 'directory', children: [{ name: 'x.js', type: 'file', uid: '2' }] },
    { name: '..', type: 'file', uid: '3' },
    { name: 'l', type: 'symlink', link: '/etc/passwd' },
    { name: 'nouid', type: 'file' },
  ]);
  assert.deepEqual(files.map((f) => f.path), ['ok.js']);
  assert.equal(symlinks.length, 1);
  assert.equal(skipped.length, 3);
});

test('client refuses to run without a token', () => {
  assert.throws(() => createClient({ token: '' }), UsageError);
});

test('end-to-end recovery against a fake API', async () => {
  const { server, calls, api } = await fakeVercel({ flakyOnce: true });
  try {
    const out = await mkdtemp(join(tmpdir(), 'vr-'));
    const { manifest, written } = await recover({ deployment: DEPLOYMENT, team: 'team_1', out, token: TOKEN, api, concurrency: 3, quiet: true });
    assert.equal(written, 5, 'package.json, src/index.ts, src/nested/a.txt, binary.png, json-envelope.txt');
    assert.equal(manifest.errors.length, 0);
    assert.equal(await readFile(join(out, 'src', 'nested', 'a.txt'), 'utf8'), 'hello');
    assert.equal(await readFile(join(out, 'package.json'), 'utf8'), '{"name":"x"}', 'raw JSON files are not mistaken for the base64 envelope');
    assert.equal(await readFile(join(out, 'json-envelope.txt'), 'utf8'), 'decoded!', 'base64 envelope is decoded');
    assert.deepEqual([...await readFile(join(out, 'binary.png'))], [0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await assert.rejects(stat(join(out, 'node_modules')), 'node_modules is skipped');
    await assert.rejects(stat(join(out, 'link')), 'symlinks are not materialised');
    assert.equal(manifest.symlinks[0].target, '/etc/passwd');
    assert.ok(manifest.skipped.some((s) => s.reason.includes('illegal')), 'hostile names are recorded');
    const m = JSON.parse(await readFile(join(out, '.vercel-recovery', 'manifest.json'), 'utf8'));
    assert.equal(m.files.length, 5);
    assert.ok(m.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.ok(calls.every((c) => c.team === 'team_1'), 'teamId is sent on every request');
    assert.ok(calls.filter((c) => c.path.endsWith('/files')).length === 2, '429 is retried once');
    assert.deepEqual(await verify(out), [], 'verify passes on a fresh recovery');
  } finally { server.close(); }
});

test('auth failure surfaces as an API error, not a partial tree', async () => {
  const { server, api } = await fakeVercel();
  try {
    const out = await mkdtemp(join(tmpdir(), 'vr-'));
    await assert.rejects(recover({ deployment: DEPLOYMENT, out, token: 'wrong', api, concurrency: 1, quiet: true }), /HTTP 403/);
  } finally { server.close(); }
});

test('dry run downloads nothing', async () => {
  const { server, calls, api } = await fakeVercel();
  try {
    const out = await mkdtemp(join(tmpdir(), 'vr-'));
    const { written } = await recover({ deployment: DEPLOYMENT, out, token: TOKEN, api, concurrency: 1, quiet: true, dryRun: true });
    assert.equal(written, 0);
    assert.ok(!calls.some((c) => c.path.includes('/v8/')));
  } finally { server.close(); }
});
