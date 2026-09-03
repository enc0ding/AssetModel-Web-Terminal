#!/usr/bin/env node
/**
 * scan-source.mjs — static triage scanner for a recovered or untrusted source tree.
 *
 * It codifies the checks an incident responder runs by hand on a web codebase
 * that may have been tampered with:
 *
 *   obfuscation      eval/new Function/atob chains, long base64 blobs, hex/unicode-escaped strings
 *   exfil            fetch/XHR/beacon to webhook.site, discord/telegram webhooks, ngrok, pastebin, .onion
 *   shells           child_process/exec/spawn in app code, curl|sh, reverse-shell idioms, web shells
 *   prompt-injection instructions aimed at AI agents in source, docs, HTML comments, hidden DOM, llms.txt,
 *                    CLAUDE.md / AGENTS.md / .cursor / .claude / copilot-instructions
 *   hidden-content   display:none / font-size:0 / off-screen containers carrying long text
 *   supply-chain     install scripts in package.json, .npmrc registry overrides, git/tarball/http deps,
 *                    typosquat-looking names, lockfile resolved URLs off the public registry
 *   ci               pull_request_target with PR-head checkout, unpinned third-party actions,
 *                    curl|bash in workflows, write-all permissions
 *   secrets          AWS/GitHub/Vercel/Stripe/Clerk/Anthropic/OpenAI key shapes, private key blocks
 *   unicode          zero-width, bidi override, tag characters (invisible-code attacks)
 *   config           vercel.json rewrites/redirects to external hosts, middleware fetching external hosts
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage: node scan-source.mjs <dir> [--json out.json] [--md out.md] [--fail-on high|medium|low|none]
 *                                [--max-bytes 2000000] [--ignore <glob-ish substring>]...
 * Exit: 0 clean at threshold, 1 findings at/above threshold, 2 usage error.
 *
 * This is a triage tool, not proof of cleanliness: read every HIGH finding.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname, basename, sep } from 'node:path';

const SEVERITY = { high: 3, medium: 2, low: 1, none: 0 };
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json', '.html', '.htm', '.css', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.xml', '.svg', '.sh', '.bash', '.zsh', '.ps1', '.py', '.rb', '.php', '.env', '.example', '.sql', '.vue', '.svelte', '.astro', '.graphql', '.gql', '.conf', '.ini', '.cfg', '.lock', '.npmrc', '.yarnrc', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', '.turbo', '.vercel', 'dist', 'build', 'coverage', '.cache']);
const MINIFIED_HINT = /\.min\.(js|css)$/i;
// The scanner's own source and its test file carry rule patterns and planted
// malicious fixtures by design; scanning them is pure noise.
const SELF_FILES = new Set(['scan-source.mjs', 'scan-source.test.mjs']);

const externalHost = (s) => {
  try { const u = new URL(s); return u.hostname; } catch { return null; }
};

/** rule: { id, category, severity, description, test(ctx) -> findings[] } */
const RULES = [];
const rx = (id, category, severity, description, regex, opts = {}) => RULES.push({
  id, category, severity, description,
  test: ({ text, path, lines }) => {
    if (opts.paths && !opts.paths.test(path)) return [];
    if (opts.notPaths && opts.notPaths.test(path)) return [];
    const out = [];
    const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
    let m; let n = 0;
    while ((m = re.exec(text)) && n < 20) {
      n += 1;
      const line = lineOf(lines, m.index);
      out.push({ line, excerpt: excerpt(text, m.index) });
      if (m[0].length === 0) re.lastIndex += 1;
    }
    return out;
  },
});

function lineOf(lineStarts, idx) {
  let lo = 0; let hi = lineStarts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
function excerpt(text, idx) {
  const s = Math.max(0, text.lastIndexOf('\n', idx) + 1);
  const e = text.indexOf('\n', idx);
  return text.slice(s, e === -1 ? undefined : e).trim().slice(0, 160);
}

const CODE = /\.(m?[jt]sx?|c[jt]s|vue|svelte|astro|html?)$/i;
const APP_CODE = /\.(m?[jt]sx?|c[jt]s)$/i;
const NOT_TESTS = /(\.test\.|\.spec\.|__tests__|(^|\/)(tests?|scripts|tools|bin)\/)/i;
const DOCS = /\.(md|mdx|txt)$/i;
const HTML = /\.html?$/i;
const WORKFLOW = /\.github\/workflows\/.*\.ya?ml$/i;

// --- obfuscation
rx('obf.eval', 'obfuscation', 'high', 'eval() / new Function() with dynamic input', /\b(eval|Function)\s*\(\s*(?!['"`]use strict)[^)]*?(atob|unescape|decodeURIComponent|fromCharCode|\+|\[)/, { paths: CODE });
rx('obf.atob-exec', 'obfuscation', 'high', 'decoded base64 fed into eval/Function/script', /(eval|Function|\.innerHTML|document\.write|src\s*=)\s*[\(=]\s*[^;]*atob\(/, { paths: CODE });
rx('obf.fromcharcode', 'obfuscation', 'medium', 'String.fromCharCode used to assemble strings', /String\.fromCharCode\s*\(\s*(\d+\s*,\s*){8,}/, { paths: CODE });
rx('obf.hexstring', 'obfuscation', 'medium', 'long run of hex-escaped characters', /(\\x[0-9a-fA-F]{2}){24,}/, { paths: CODE });
rx('obf.unicode-escapes', 'obfuscation', 'medium', 'long run of unicode-escaped characters', /(\\u[0-9a-fA-F]{4}){24,}/, { paths: CODE });
rx('obf.base64-blob', 'obfuscation', 'low', 'long base64-looking blob (verify it is an asset, not code)', /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{400,}={0,2}(?![A-Za-z0-9+/])/, { notPaths: /\.(svg|lock|json|css)$|package-lock|pnpm-lock|yarn\.lock|woff|\.map$/i });
rx('obf.hidden-js-in-svg', 'obfuscation', 'high', '<script> inside SVG', /<script[\s>]/i, { paths: /\.svg$/i });

// --- exfil / C2
rx('exfil.webhook-host', 'exfil', 'high', 'known exfiltration/C2 host', /https?:\/\/[^\s"'`]*(webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app|dev)|burpcollaborator|interact\.sh|oast\.(pro|live|fun|site|online|me)|pastebin\.com|paste\.ee|transfer\.sh|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|hooks\.slack\.com\/services)/i);
rx('exfil.onion', 'exfil', 'high', '.onion address', /[a-z2-7]{16,56}\.onion\b/i);
rx('exfil.raw-ip-url', 'exfil', 'medium', 'URL to a raw IP address', /https?:\/\/(?!127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}(:\d+)?\//, { notPaths: /\.(md|txt)$/i });
rx('exfil.sendbeacon-external', 'exfil', 'medium', 'navigator.sendBeacon to external URL', /sendBeacon\s*\(\s*['"`]https?:\/\//, { paths: CODE });
rx('exfil.env-dump', 'exfil', 'high', 'process.env serialised and sent over the network', /JSON\.stringify\s*\(\s*process\.env\s*\)/, { paths: APP_CODE });
rx('exfil.cookie-to-url', 'exfil', 'high', 'document.cookie concatenated into a URL', /https?:\/\/[^'"`\s]*['"`]\s*\+\s*[^;]*document\.cookie|document\.cookie[^;]*['"`]\s*\+\s*['"`]https?:/, { paths: CODE });
rx('exfil.crypto-wallet', 'exfil', 'medium', 'wallet/seed-phrase harvesting strings', /\b(seed ?phrase|mnemonic phrase|metamask|wallet[_-]?drain|private[_ ]key\s*[:=])/i, { paths: CODE });
rx('exfil.miner', 'exfil', 'high', 'cryptomining library or pool', /(coinhive|cryptonight|stratum\+tcp|xmrig|minero\.cc|coin-?imp|webminer)/i);

// --- shells
rx('shell.child-process-app', 'shells', 'medium', 'child_process / exec / spawn in application code', /\b(require\(['"]child_process['"]\)|from\s+['"](node:)?child_process['"]|\bexecSync\s*\(|\bspawnSync\s*\(|\bexec\s*\(\s*(req|request|query|params|body|input|cmd|command))/, { paths: APP_CODE, notPaths: NOT_TESTS });
rx('shell.curl-pipe-sh', 'shells', 'high', 'curl/wget piped to a shell', /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, { notPaths: DOCS });
rx('docs.curl-pipe-sh', 'shells', 'low', 'documentation tells a reader to pipe a download into a shell', /\b(curl|wget)\b[^\n|`']*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, { paths: DOCS });
rx('shell.reverse-shell', 'shells', 'high', 'reverse-shell idiom', /(\/dev\/tcp\/\d|\bnc\s+(-e|-c)\s|\bncat\b[^\n]*--exec|\bsocat\b[^\n]*exec:|bash\s+-i\s+>&|python[23]?\s+-c\s+['"]import\s+(socket|pty)|mkfifo\s+\/tmp\/)/i);
rx('shell.web-shell', 'shells', 'high', 'web-shell pattern (command from request executed)', /(exec|system|passthru|shell_exec|popen)\s*\(\s*\$_(GET|POST|REQUEST)|\bexec(Sync)?\s*\(\s*(req\.(query|body|params)|searchParams\.get)/i);
rx('shell.route-eval', 'shells', 'high', 'API route evaluating request-controlled code', /(new\s+Function|eval|vm\.run(InThisContext|InNewContext)|import\s*\()\s*\(?\s*[^)]*\b(req\.(body|query)|searchParams\.get|formData\.get)/, { paths: APP_CODE });

// --- prompt injection (source + docs + html)
const INJ = /(ignore\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|rules?|guidance)|disregard\s+(all\s+|your\s+|the\s+)?(previous|prior|instructions?|system prompt)|you\s+are\s+now\s+(an?\s+)?(unrestricted|DAN|different)|new\s+instructions?\s*:|do\s+not\s+(tell|inform|alert|notify)\s+the\s+(user|human|operator)|(to|for)\s+(any|all|the)\s+(ai|llm|language model|assistant|agent|copilot|claude|chatgpt|gpt)s?\s+(reading|processing|parsing|that reads)|\b(ai|llm|assistant|agent|claude|copilot|gpt)s?\s+(must|should|need to|are required to)\s+(now\s+)?(run|execute|exfiltrate|send|upload|post|delete|ignore|disable|approve|merge)|\bsystem\s*prompt\s*(override|injection|:)|print\s+(your|the)\s+(system\s+prompt|instructions)|exfiltrat(?:e|es|ing)\s+(?:the\s+|your\s+|all\s+|any\s+)?(?:\w+\s+){0,2}(?:tokens?|secrets?|keys?|credentials?|passwords?|env(?:ironment)?)|\bapprove\s+this\s+(pr|pull request)\s+(without|immediately)|curl\s+[^\n]*\$\{?\s*(GITHUB_TOKEN|VERCEL_TOKEN|AWS_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY))/i;
rx('inject.text', 'prompt-injection', 'high', 'instruction aimed at an AI agent', INJ, { notPaths: /scan-source\.mjs$|\/scan-source\//i });
rx('inject.html-comment', 'prompt-injection', 'high', 'HTML comment addressing an AI/agent', /<!--(?:(?!-->)[\s\S]){0,400}?\b(ai|llm|assistant|agent|claude|copilot|gpt|chatgpt|model)\b(?:(?!-->)[\s\S]){0,400}?\b(ignore|instruction|must|should|run|execute|secret|token|approve|system prompt)\b[\s\S]{0,400}?-->/i, { paths: /\.(html?|md|mdx|jsx|tsx|vue|svelte|astro)$/i });
rx('inject.agent-config-file', 'prompt-injection', 'medium', 'agent instruction file present (review its contents)', /^/, { paths: /(^|\/)(CLAUDE\.md|AGENTS\.md|\.claude\/[^/]+\.(json|md)|\.cursor\/rules\/[^/]+|\.cursorrules|\.windsurfrules|\.github\/copilot-instructions\.md|\.github\/instructions\/[^/]+|GEMINI\.md|\.clinerules)$/i });
rx('inject.hooks-in-agent-config', 'prompt-injection', 'high', 'shell hooks defined in agent settings', /"hooks"\s*:|"command"\s*:\s*"[^"]*(curl|wget|sh -c|bash|powershell|node -e)/i, { paths: /\.claude\/settings(\.local)?\.json$|\.cursor\/|\.vscode\/tasks\.json$/i });
rx('inject.plugin-marketplace', 'prompt-injection', 'medium', 'agent plugin/marketplace enabled from settings', /"(enabledPlugins|extraKnownMarketplaces|mcpServers)"\s*:/, { paths: /\.claude\/settings(\.local)?\.json$|\.mcp\.json$|\.cursor\/mcp\.json$/i });
rx('inject.llms-txt', 'prompt-injection', 'low', 'llms.txt / robots directives for AI crawlers (review wording)', /^/, { paths: /(^|\/)(llms(-full)?\.txt)$/i });

// --- hidden content
rx('hidden.dom-text', 'hidden-content', 'high', 'hidden element carrying a long text payload', /<[a-z][^>]*(?:\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|em|rem)?\b|opacity\s*:\s*0(?:\.0+)?\b|position\s*:\s*absolute;\s*left\s*:\s*-\d{3,}|color\s*:\s*(?:#fff\b|white|transparent))[^"']*["']|(?<![\w-])hidden(?=[\s>=]))[^>]*>((?:[^<]|<(?:b|i|em|strong|span|br|p|small)\b[^>]*>|<\/(?:b|i|em|strong|span|p|small)>){200,})/i, { paths: HTML });
rx('hidden.aria-hidden-text', 'hidden-content', 'medium', 'aria-hidden element with a long text payload', /aria-hidden\s*=\s*["']true["'][^>]*>(?:(?!<\/)[^<]){300,}/i, { paths: HTML });
rx('hidden.data-uri-html', 'hidden-content', 'high', 'data:text/html payload', /data:text\/html[;,]/i, { paths: /\.(html?|m?[jt]sx?|css|svg)$/i });
rx('hidden.external-iframe', 'hidden-content', 'medium', 'iframe to an external origin', /<iframe[^>]+src\s*=\s*["']https?:\/\//i, { paths: CODE });
rx('hidden.meta-refresh-external', 'hidden-content', 'high', 'meta refresh redirect to external URL', /<meta[^>]+http-equiv\s*=\s*["']refresh["'][^>]*url\s*=\s*https?:\/\//i, { paths: HTML });

// --- supply chain
RULES.push({
  id: 'supply.install-scripts', category: 'supply-chain', severity: 'high',
  description: 'package.json lifecycle install script',
  test: ({ path, text }) => {
    if (!/(^|\/)package\.json$/.test(path)) return [];
    let pkg; try { pkg = JSON.parse(text); } catch { return []; }
    const out = [];
    for (const k of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
      const v = pkg.scripts?.[k];
      if (typeof v === 'string' && !/^(husky(\s+install)?|husky\s*$)$/.test(v.trim())) out.push({ line: 1, excerpt: `${k}: ${v.slice(0, 140)}` });
    }
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] || {})) {
        if (typeof spec === 'string' && /^(https?:|git(\+|:)|github:|file:|link:|[^@]+\/[^@]+$)/.test(spec) && !/^workspace:|^npm:/.test(spec)) out.push({ line: 1, excerpt: `${field}.${name}: ${spec}` });
      }
    }
    return out;
  },
});
rx('supply.npmrc-registry', 'supply-chain', 'high', 'registry override / auth token in .npmrc or .yarnrc', /^(registry|@[^:]+:registry|always-auth|_auth(Token)?|\/\/[^\s]+:_authToken)\s*=/mi, { paths: /(^|\/)\.(npmrc|yarnrc(\.yml)?)$/i });
rx('supply.lock-nonregistry', 'supply-chain', 'high', 'lockfile entry resolved outside the public npm registry', /"resolved"\s*:\s*"(?!https:\/\/registry\.npmjs\.org\/)https?:\/\/[^"]+"|resolution:\s*\{?\s*tarball:\s*(?!https:\/\/registry\.npmjs\.org\/)/i, { paths: /package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$/i });
rx('supply.pkg-exec-in-scripts', 'supply-chain', 'medium', 'npm script downloads and executes remote code', /"(pre|post)?(build|dev|start|test|lint)"\s*:\s*"[^"]*(curl|wget|npx\s+[^\s"]+@latest|node\s+-e)/i, { paths: /(^|\/)package\.json$/ });

// --- CI
rx('ci.prt-checkout-head', 'ci', 'high', 'pull_request_target with checkout of PR head (pwn request)', /pull_request_target[\s\S]{0,4000}?ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/i, { paths: WORKFLOW });
rx('ci.write-all', 'ci', 'medium', 'workflow requests write-all permissions', /permissions:\s*write-all/i, { paths: WORKFLOW });
rx('ci.unpinned-action', 'ci', 'low', 'third-party action not pinned to a commit SHA', /uses:\s*(?!actions\/|github\/|\.\/|docker:\/\/)[\w.-]+\/[\w.-]+(\/[\w.-]+)?@(?![0-9a-f]{40}\b)[\w.\/-]+/i, { paths: WORKFLOW });
rx('ci.curl-bash', 'ci', 'high', 'workflow pipes a download into a shell', /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b/i, { paths: WORKFLOW });
rx('ci.secrets-echo', 'ci', 'high', 'secret echoed / sent in workflow', /(echo|curl|wget|printf)[^\n]*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}/i, { paths: WORKFLOW });
rx('ci.expression-injection', 'ci', 'medium', 'untrusted event data interpolated into run:', /run:[^\n]*\$\{\{\s*github\.event\.(issue|pull_request|comment|review|head_commit)\.(title|body|head\.ref|message|label\.name)/i, { paths: WORKFLOW });

// --- secrets
rx('secret.aws', 'secrets', 'high', 'AWS access key id', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/);
rx('secret.github', 'secrets', 'high', 'GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/);
rx('secret.vercel', 'secrets', 'high', 'Vercel token / OIDC', /\bvercel_[A-Za-z0-9]{20,}\b|\bvcp_[A-Za-z0-9]{20,}\b/);
rx('secret.stripe', 'secrets', 'high', 'Stripe live secret key', /\b(sk|rk)_live_[A-Za-z0-9]{20,}\b/);
rx('secret.clerk', 'secrets', 'high', 'Clerk secret key', /\bsk_(live|test)_[A-Za-z0-9]{20,}\b/);
rx('secret.anthropic', 'secrets', 'high', 'Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{30,}\b/);
rx('secret.openai', 'secrets', 'high', 'OpenAI API key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/);
rx('secret.private-key', 'secrets', 'high', 'private key block', /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/);
rx('secret.db-url', 'secrets', 'high', 'database URL with embedded password', /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^:\s/]+:[^@\s/]{4,}@[^\s"'`]+/i, { notPaths: /\.example$|README|\.md$/i });
rx('secret.jwt', 'secrets', 'medium', 'JWT literal', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, { notPaths: /\.test\.|fixtures?/i });

// --- unicode
rx('unicode.invisible', 'unicode', 'high', 'invisible / bidi-control characters in source', /[​‌‍⁠﻿‪-‮⁦-⁩]|\uDB40[\uDC00-\uDC7F]/, { notPaths: /\.(woff2?|ttf|png|jpg|gif|svg)$/i });
rx('unicode.homoglyph-ident', 'unicode', 'medium', 'Cyrillic/Greek letters inside an ASCII identifier', /[A-Za-z_$][A-Za-z0-9_$]*[Ѐ-ӿͰ-Ͽ][A-Za-z0-9_$]*/, { paths: APP_CODE });

// --- config
RULES.push({
  id: 'config.vercel-external', category: 'config', severity: 'high',
  description: 'vercel.json rewrite/redirect to an external host',
  test: ({ path, text }) => {
    if (!/(^|\/)vercel\.json$/.test(path)) return [];
    let cfg; try { cfg = JSON.parse(text); } catch { return []; }
    const out = [];
    for (const key of ['rewrites', 'redirects']) {
      for (const r of cfg[key] || []) {
        const dest = r?.destination;
        const host = typeof dest === 'string' ? externalHost(dest) : null;
        if (host) out.push({ line: 1, excerpt: `${key}: ${r.source} -> ${dest}` });
      }
    }
    for (const h of cfg.headers || []) {
      for (const hh of h.headers || []) {
        if (/^content-security-policy$/i.test(hh.key) && /unsafe-eval/.test(hh.value)) out.push({ line: 1, excerpt: `CSP allows unsafe-eval on ${h.source}` });
      }
    }
    return out;
  },
});
rx('config.middleware-external-fetch', 'config', 'medium', 'middleware/proxy fetches an external host', /fetch\s*\(\s*['"`]https?:\/\/(?!localhost)[^'"`]+/, { paths: /(^|\/)(middleware|proxy)\.(m?[jt]s)$/i });
rx('config.next-external-script', 'config', 'medium', '<Script>/<script> from an external origin', /<(Script|script)[^>]+src\s*=\s*["'{]\s*["']?https?:\/\/(?!(www\.)?(google(tagmanager)?\.com|googleapis\.com|gstatic\.com|vercel\.com|vercel-scripts\.com|vercel-insights\.com|clerk\.[a-z0-9.-]+|js\.stripe\.com|cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|plausible\.io))/i, { paths: CODE });

function classify(findings) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

async function* walk(root, ignore) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      if (ignore.some((s) => rel.includes(s))) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(full); continue; }
      if (e.isFile() && !SELF_FILES.has(e.name)) yield { full, rel };
    }
  }
}

function isText(rel, buf) {
  const ext = extname(rel).toLowerCase();
  const base = basename(rel);
  if (TEXT_EXT.has(ext) || /^\.(npmrc|yarnrc|env|cursorrules|windsurfrules|clinerules)/.test(base) || base === 'CODEOWNERS' || base === 'Dockerfile') {
    const sample = buf.subarray(0, 8000);
    let nul = 0; for (const b of sample) if (b === 0) nul += 1;
    return nul === 0;
  }
  return false;
}

export async function scan(root, { ignore = [], maxBytes = 2_000_000 } = {}) {
  const findings = [];
  let filesScanned = 0; let filesSkipped = 0;
  for await (const { full, rel } of walk(root, ignore)) {
    let s; try { s = await stat(full); } catch { continue; }
    if (s.size > maxBytes) { filesSkipped += 1; continue; }
    const buf = await readFile(full);
    if (!isText(rel, buf)) { filesSkipped += 1; continue; }
    filesScanned += 1;
    const text = buf.toString('utf8');
    const lines = [0]; for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lines.push(i + 1);
    const minified = MINIFIED_HINT.test(rel) || (text.length > 5000 && lines.length < 5);
    const ctx = { text, path: rel, lines, minified };
    for (const rule of RULES) {
      let hits;
      try { hits = rule.test(ctx); } catch { hits = []; }
      for (const h of hits) findings.push({ rule: rule.id, category: rule.category, severity: rule.severity, description: rule.description, file: rel, line: h.line, excerpt: h.excerpt, minified });
    }
  }
  findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  return { root, scannedAt: new Date().toISOString(), filesScanned, filesSkipped, counts: classify(findings), findings, rules: RULES.map((r) => ({ id: r.id, category: r.category, severity: r.severity })) };
}

export function renderMarkdown(report) {
  const { counts } = report;
  const lines = [`# Source scan report`, '', `- Root: \`${report.root}\``, `- Scanned: ${report.scannedAt}`, `- Files scanned: ${report.filesScanned} (skipped ${report.filesSkipped} binary/large)`, `- Findings: **${counts.high} high**, ${counts.medium} medium, ${counts.low} low`, ''];
  if (!report.findings.length) { lines.push('No findings.'); return lines.join('\n') + '\n'; }
  let cur = '';
  for (const f of report.findings) {
    if (f.severity !== cur) { cur = f.severity; lines.push(`## ${cur.toUpperCase()}`, ''); }
    lines.push(`- \`${f.file}:${f.line}\` **${f.rule}** ${f.description}${f.minified ? ' _(minified file)_' : ''}`);
    if (f.excerpt) lines.push(`  \`${f.excerpt.replace(/`/g, "'")}\``);
  }
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(sep).join('/').replace(/^.*\//, '/') ) || (process.argv[1] && process.argv[1].endsWith('scan-source.mjs'));
if (isMain) {
  const argv = process.argv.slice(2);
  const opts = { ignore: [], failOn: 'high', maxBytes: 2_000_000 };
  let root;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') opts.json = argv[++i];
    else if (a === '--md') opts.md = argv[++i];
    else if (a === '--fail-on') opts.failOn = argv[++i];
    else if (a === '--max-bytes') opts.maxBytes = Number(argv[++i]);
    else if (a === '--ignore') opts.ignore.push(argv[++i]);
    else if (a.startsWith('--')) { process.stderr.write(`unknown option ${a}\n`); process.exit(2); }
    else root = a;
  }
  if (!root || !(opts.failOn in SEVERITY)) { process.stderr.write('usage: scan-source.mjs <dir> [--json f] [--md f] [--fail-on high|medium|low|none]\n'); process.exit(2); }
  const report = await scan(root, opts);
  const { writeFile } = await import('node:fs/promises');
  if (opts.json) await writeFile(opts.json, JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  if (opts.md) await writeFile(opts.md, md); else process.stdout.write(md);
  const threshold = SEVERITY[opts.failOn];
  const worst = report.findings.reduce((m, f) => Math.max(m, SEVERITY[f.severity]), 0);
  process.exit(threshold > 0 && worst >= threshold ? 1 : 0);
}
