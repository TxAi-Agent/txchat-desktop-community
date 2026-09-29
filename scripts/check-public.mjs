import { readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// A generic guardrail, not a substitute for human review before publication.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, 'public-files.json'), 'utf8'));
const allowed = new Set(manifest.files);
if (allowed.size !== manifest.files.length || !allowed.has('public-files.json')) throw Error('Invalid public file manifest');
const ignored = new Set(['.git', 'node_modules', '.build', 'dist', 'coverage']);
const actual = [];
async function walk(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!prefix && ignored.has(entry.name)) continue;
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw Error('Symbolic links are not allowed');
    if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative + '/');
    else if (entry.isFile()) actual.push(relative);
    else throw Error('Unsupported file type');
  }
}
await walk(root);
if (actual.length !== allowed.size || actual.some(file => !allowed.has(file))) throw Error('Public file manifest does not match source tree');
const patterns = [
  ['personal filesystem path', /(?:\/Users\/|\/home\/|[A-Z]:[\\/]Users[\\/])[^\s/\\]+/i],
  ['email address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['access credential', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{24,})\b/],
  ['literal IPv4 address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['credential URL', /https?:\/\/[^\s/]+:[^\s/]+@/i],
];
const allowedHosts = new Set(['registry.npmjs.org', 'github.com', 'docs.github.com', 'www.apache.org', 'www.apple.com', 'www.w3.org', 'opencollective.com', 'feross.org', 'www.patreon.com']);
for (const file of actual) {
  if (file.includes('..') || path.isAbsolute(file)) throw Error('Invalid public path');
  const bytes = await readFile(path.join(root, file));
  const approvedImage = manifest.reviewedImages?.[file];
  if (approvedImage) {
    if (!file.endsWith('.png') || createHash('sha256').update(bytes).digest('hex') !== approvedImage) throw Error('Reviewed image changed');
    continue;
  }
  if (bytes.includes(0)) throw Error(`Binary file is not allowed: ${file}`);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (const [label, pattern] of patterns) {
    // The unmodified official license is checked by digest below.
    if (file === 'LICENSE') continue;
    if (pattern.test(file === 'public-files.json' ? text.replaceAll('resources/trayTemplate' + '@2x.png', '') : text) || pattern.test(file)) throw Error(`Review required (${label}): ${file}`);
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)]+/g)) {
    const address = new URL(match[0]);
    if (address.hostname === '*') continue; // Network-denial filters.
    const synthetic = file.startsWith('tests/') && address.hostname.endsWith('.invalid');
    if ((!allowedHosts.has(address.hostname) && !synthetic) || address.port || address.username || address.password) throw Error(`Review required (external URL): ${file}`);
  }
}
const license = await readFile(path.join(root, 'LICENSE'));
if (createHash('sha256').update(license).digest('hex') !== 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30') throw Error('Official license differs');
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
for (const [name, item] of Object.entries(lock.packages)) {
  if (!name) continue;
  if (!item.resolved?.startsWith('https://registry.npmjs.org/') || !item.integrity?.startsWith('sha512-') || item.link) throw Error('Dependency source or integrity is not approved');
}
try {
  await lstat(path.join(root, '.git'));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (tracked.length !== allowed.size || tracked.some(file => !allowed.has(file))) throw Error('Tracked files differ from public manifest');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
console.log(`Public source guardrails passed for ${actual.length} reviewed files.`);
