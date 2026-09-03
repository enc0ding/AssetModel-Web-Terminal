#!/usr/bin/env node
/**
 * vercel-recover.mjs — download the source tree of a Vercel deployment.
 *
 * Vercel keeps the source files of every deployment (git or CLI) and exposes
 * them through the REST API. This tool walks that tree and writes a
 * byte-exact copy to disk, plus a manifest with SHA-256 hashes so the recovery
 * can be verified and re-run idempotently.
 *
 * Zero dependencies. Node >= 18 (global fetch).
 *
 * Usage:
 *   VERCEL_TOKEN=... node vercel-recover.mjs --deployment dpl_xxx --team team_xxx --out ./recovered
 *
 * Options:
 *   --deployment <id|url>   Deployment id (dpl_...) or hostname. Required.
 *   --team <teamId>         Team id (team_...) or slug. Optional for personal scope.
 *   --out <dir>             Output directory (created). Default: ./recovered/<deploymentId>
 *   --token <token>         Vercel access token. Prefer VERCEL_TOKEN env var.
 *   --api <baseUrl>         API base (default https://api.vercel.com). Used by tests.
 *   --concurrency <n>       Parallel file downloads (default 6).
 *   --include-node-modules  Do not skip node_modules (skipped by default).
 *   --dry-run               List the tree, download nothing.
 *   --quiet                 Less output.
 *
 * Exit codes: 0 ok, 1 usage error, 2 API/auth error, 3 partial download (see manifest.errors).
 *
 * Security notes:
 *   - Every path from the API is validated: no absolute paths, no "..", no NUL,
 *     no backslashes; files are only ever written beneath --out.
 *   - Symlink entries are recorded in the manifest and NOT materialised.
 *   - The token is only ever sent to --api (default api.vercel.com) over HTTPS.
 *   - Downloaded content is treated as untrusted data. Run scan-source.mjs on it
 *     before installing dependencies or executing anything.
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';

const DEFAULT_API = 'https://api.vercel.com';
const SKIP_DIRS_DEFAULT = new Set(['node_modules', '.git']);

export function parseArgs(argv) {
  const args = { concurrency: 6, api: DEFAULT_API, includeNodeModules: false, dryRun: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--deployment': args.deployment = next(); break;
      case '--team': args.team = next(); break;
      case '--out': args.out = next(); break;
      case '--token': args.token = next(); break;
      case '--api': args.api = next(); break;
      case '--concurrency': args.concurrency = Number(next()); break;
      case '--include-node-modules': args.includeNodeModules = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--quiet': args.quiet = true; break;
      case '--help': case '-h': args.help = true; break;
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1 || args.concurrency > 32) {
    throw new UsageError('--concurrency must be an integer between 1 and 32');
  }
  return args;
}

export class UsageError extends Error {}
export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

/** Reject any path segment that could escape the output directory. */
export function safeRelativePath(segments) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('empty path');
  for (const s of segments) {
    if (typeof s !== 'string' || s.length === 0) throw new Error('empty path segment');
    if (s === '.' || s === '..') throw new Error(`illegal path segment: ${s}`);
    if (s.includes('/') || s.includes('\\') || s.includes('\0')) throw new Error(`illegal characters in segment: ${JSON.stringify(s)}`);
    if (s.length > 255) throw new Error('path segment too long');
  }
  return segments.join('/');
}

export function resolveUnder(outDir, relPath) {
  const base = resolve(outDir);
  const full = resolve(base, relPath);
  if (full !== base && !full.startsWith(base + sep)) throw new Error(`path escapes output directory: ${relPath}`);
  return full;
}

/**
 * Flatten the Vercel file tree into a list of {path, uid, type, mode, size}.
 * The API returns an array of entries; directories carry `children`.
 */
export function flattenTree(entries, { skipDirs = SKIP_DIRS_DEFAULT } = {}) {
  const files = [];
  const symlinks = [];
  const skipped = [];
  const walk = (list, prefix) => {
    if (!Array.isArray(list)) return;
    for (const e of list) {
      if (!e || typeof e.name !== 'string') continue;
      const segs = [...prefix, e.name];
      let rel;
      try { rel = safeRelativePath(segs); } catch (err) { skipped.push({ name: e.name, reason: err.message }); continue; }
      const type = e.type || (Array.isArray(e.children) ? 'directory' : 'file');
      if (type === 'directory') {
        if (skipDirs.has(e.name)) { skipped.push({ path: rel, reason: 'skipped directory' }); continue; }
        walk(e.children || [], segs);
      } else if (type === 'symlink' || type === 'link') {
        symlinks.push({ path: rel, target: e.link ?? e.target ?? null });
      } else if (type === 'file') {
        if (typeof e.uid !== 'string' || e.uid.length === 0) { skipped.push({ path: rel, reason: 'file without uid' }); continue; }
        files.push({ path: rel, uid: e.uid, mode: e.mode ?? null, size: e.size ?? null, contentType: e.contentType ?? null });
      } else {
        skipped.push({ path: rel, reason: `unknown entry type ${type}` });
      }
    }
  };
  walk(entries, []);
  return { files, symlinks, skipped };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function createClient({ api = DEFAULT_API, token, team, fetchImpl = fetch, maxRetries = 5, log = () => {} }) {
  if (!token) throw new UsageError('missing token: set VERCEL_TOKEN or pass --token');
  const base = api.replace(/\/+$/, '');
  const withTeam = (path) => {
    const url = new URL(base + path);
    if (team) url.searchParams.set('teamId', team);
    return url;
  };
  async function request(path, { raw = false } = {}) {
    const url = withTeam(path);
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'vercel-recover/1.0' } });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt > maxRetries) throw new ApiError(`${res.status} after ${maxRetries} retries: ${url.pathname}`, res.status, await res.text().catch(() => ''));
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 500 * 2 ** attempt);
        log(`retry ${attempt}/${maxRetries} in ${delay}ms (${res.status}) ${url.pathname}`);
        await sleep(delay);
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ApiError(`HTTP ${res.status} for ${url.pathname}: ${body.slice(0, 300)}`, res.status, body);
      }
      if (raw) return res;
      return res.json();
    }
  }
  return {
    getDeployment: (id) => request(`/v13/deployments/${encodeURIComponent(id)}`),
    listFiles: (id) => request(`/v6/deployments/${encodeURIComponent(id)}/files`),
    /** Returns a Buffer with the file bytes. Handles both raw and {data: base64} responses. */
    async getFile(id, uid) {
      const res = await request(`/v8/deployments/${encodeURIComponent(id)}/files/${encodeURIComponent(uid)}`, { raw: true });
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      const buf = Buffer.from(await res.arrayBuffer());
      if (ct.includes('application/json')) {
        try {
          const parsed = JSON.parse(buf.toString('utf8'));
          if (parsed && typeof parsed.data === 'string') {
            const enc = parsed.encoding === 'utf-8' || parsed.encoding === 'utf8' ? 'utf8' : 'base64';
            return Buffer.from(parsed.data, enc);
          }
        } catch { /* not the envelope; fall through and treat as raw JSON file */ }
      }
      return buf;
    },
  };
}

export async function recover(opts) {
  const { deployment, team, out, token, api, concurrency, includeNodeModules, dryRun, quiet, fetchImpl } = opts;
  const log = quiet ? () => {} : (m) => process.stderr.write(`${m}\n`);
  if (!deployment) throw new UsageError('--deployment is required');
  const client = createClient({ api, token, team, fetchImpl, log });

  log(`fetching deployment ${deployment}`);
  const meta = await client.getDeployment(deployment);
  const id = meta.id || meta.uid || deployment;
  const outDir = resolve(out || join('recovered', id));
  const skipDirs = includeNodeModules ? new Set(['.git']) : SKIP_DIRS_DEFAULT;

  log(`listing files for ${id}`);
  const tree = await client.listFiles(id);
  const { files, symlinks, skipped } = flattenTree(tree, { skipDirs });
  log(`${files.length} files, ${symlinks.length} symlinks, ${skipped.length} skipped entries`);

  const manifest = {
    tool: 'vercel-recover/1.0',
    recoveredAt: new Date().toISOString(),
    deployment: {
      id, url: meta.url ?? null, name: meta.name ?? null, target: meta.target ?? null, createdAt: meta.createdAt ?? null,
      readyState: meta.readyState ?? null, source: meta.source ?? null, gitSource: meta.gitSource ?? null, meta: meta.meta ?? null,
      projectId: meta.projectId ?? meta.project?.id ?? null,
    },
    files: [], symlinks, skipped, errors: [],
  };

  if (dryRun) {
    for (const f of files) process.stdout.write(`${f.path}\n`);
    return { manifest, outDir, written: 0 };
  }

  await mkdir(join(outDir, '.vercel-recovery'), { recursive: true });
  await writeFile(join(outDir, '.vercel-recovery', 'deployment.json'), JSON.stringify(meta, null, 2));

  let written = 0;
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor; cursor += 1;
      if (i >= files.length) return;
      const f = files[i];
      try {
        const dest = resolveUnder(outDir, f.path);
        const bytes = await client.getFile(id, f.uid);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        manifest.files.push({ path: f.path, uid: f.uid, bytes: bytes.length, sha256, mode: f.mode });
        written += 1;
        if (written % 50 === 0) log(`  ${written}/${files.length}`);
      } catch (err) {
        manifest.errors.push({ path: f.path, uid: f.uid, error: String(err && err.message ? err.message : err) });
        log(`  ERROR ${f.path}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(files.length, 1)) }, worker));
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(join(outDir, '.vercel-recovery', 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`done: ${written} files written to ${outDir}${manifest.errors.length ? `, ${manifest.errors.length} errors` : ''}`);
  return { manifest, outDir, written };
}

/** Verify an existing recovery against its manifest. Returns list of mismatches. */
export async function verify(outDir) {
  const manifest = JSON.parse(await readFile(join(outDir, '.vercel-recovery', 'manifest.json'), 'utf8'));
  const problems = [];
  for (const f of manifest.files) {
    const full = resolveUnder(outDir, f.path);
    try {
      const bytes = await readFile(full);
      const sha = createHash('sha256').update(bytes).digest('hex');
      if (sha !== f.sha256) problems.push({ path: f.path, problem: 'hash mismatch' });
    } catch {
      problems.push({ path: f.path, problem: 'missing' });
    }
  }
  return problems;
}

const isMain = process.argv[1] && (await stat(process.argv[1]).catch(() => null)) && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  if (args.help) {
    process.stdout.write((await readFile(new URL(import.meta.url), 'utf8')).split('*/')[0].replace(/^\/\*\*?/, '') + '\n');
    process.exit(0);
  }
  const token = args.token || process.env.VERCEL_TOKEN;
  try {
    const { manifest } = await recover({ ...args, token });
    if (manifest.errors.length) process.exit(3);
  } catch (err) {
    if (err instanceof UsageError) { process.stderr.write(`${err.message}\n`); process.exit(1); }
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}
