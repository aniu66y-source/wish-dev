#!/usr/bin/env node
// Collect review material for one task without touching the working tree.
//
// Model: (1) baseline identity and per-layer snapshot state, (2) candidates are the union
// of baseline files, current status paths and committed paths, (3) per-layer before/after
// comparison, (4) attribution task/pre-existing/mixed/unknown decided against the matching
// baseline state, (5) scope classification on each path, (6) content and digest
// availability, (7) one record per change drives both the JSON summary and the Markdown.
//
// A clean `git status` is not evidence that nothing changed: a file the user had modified
// before the task can be reverted to HEAD and disappear from status while still being a
// task change. Candidates are therefore re-compared against the baseline instead of being
// copied as "unchanged".
//
// The tool never stages, commits, resets, cleans or checks out. Output paths that resolve
// inside the repository (including `..name` directories and symlinked parents) are refused
// before anything is created.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const TOOL = 'review-material';
const FORMAT = 2;
const CONTENT_LIMIT = 200 * 1024;
const BLOB_LIMIT = 20 * 1024 * 1024;
const CHUNK = 1024 * 1024;
// Fallback only: the real empty tree is derived from the repository's hash algorithm
// (SHA-256 repositories have a different id), so an empty baseline still diffs there.
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Streaming digest: large files are never fully buffered, so a digest stays available and a
// big file does not become "unknown" merely because it is big.
function hashFile(file) {
  const descriptor = fs.openSync(file, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK);
  let size = 0;
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, size);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {sha256: hash.digest('hex'), size};
}

function run(cwd, command, args, encoding = 'utf8', input = undefined) {
  const result = spawnSync(command, args, {cwd, encoding, maxBuffer: 256 * 1024 * 1024, input,
    env: {...process.env, GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'}});
  // spawnSync reports "could not start" (ENOENT, EACCES, too long argv) through error and
  // leaves status null; silently returning that produced a bare "failed: null" far away
  // from the cause.
  if (result.error) throw new Error('failed to run ' + command + ': ' + result.error.message);
  return {
    status: result.status,
    stdout: result.stdout ?? (encoding ? '' : Buffer.alloc(0)),
    stderr: result.stderr ?? '',
  };
}

// --literal-pathspecs keeps a file name containing `*` or `?` from being read as a
// pathspec pattern; core.quotePath=false keeps non-ASCII paths readable without touching
// the user's Git configuration. Pass encoding=null for raw Buffer output.
function git(cwd, args, encoding = 'utf8', input = undefined) {
  const safeArgs = args[0] === 'diff' ? [args[0], '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
  return run(cwd, 'git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false',
    '--literal-pathspecs', ...safeArgs], encoding, input);
}

// Trust boundary: Git executable, configuration, attributes, index and worktree must not
// be changed concurrently during collection. This is not a sandbox for a hostile Git
// executable/configuration; preflight prevents configured content filters from running.
// Include ignored files: a path removed from the index or retained only in an older
// snapshot can still be hashed later. Do this before status, diff or worktree hashing.
// Inspect every directory, including ignored paths, before Git can traverse the worktree.
// No link is traversed. Windows attributes expose reparse points that Node's lstat may
// not classify; PowerShell inspects the entries themselves, not their target contents.
function scanWorktree(repo) {
  if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; $todo=[System.Collections.Generic.Stack[string]]::new(); $todo.Push($env:REVIEW_SCAN_ROOT); while ($todo.Count) { $dir=$todo.Pop(); foreach ($item in [System.IO.Directory]::EnumerateFileSystemEntries($dir)) { if ([System.IO.Path]::GetFileName($item) -ieq '.git') { continue }; $attr=[System.IO.File]::GetAttributes($item); if ($attr -band [System.IO.FileAttributes]::ReparsePoint) { $entry=Get-Item -Force -LiteralPath $item; if (($attr -band [System.IO.FileAttributes]::Directory) -or $entry.LinkType -ne 'SymbolicLink') { throw 'directory link or unrecognized reparse point: ' + $item }; continue }; if ($attr -band [System.IO.FileAttributes]::Directory) { $todo.Push($item) } } }";
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8', env: {...process.env, REVIEW_SCAN_ROOT: repo}, maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('worktree reparse safety scan failed: ' + (result.error?.message ?? result.stderr));
  }
  const files = [];
  const pending = [''];
  while (pending.length) {
    const dir = pending.pop();
    for (const name of fs.readdirSync(path.join(repo, dir))) {
      if (name.toLowerCase() === '.git') continue;
      const relative = dir ? dir + '/' + name : name;
      const full = path.join(repo, relative);
      const info = fs.lstatSync(full);
      if (info.isSymbolicLink()) {
        // Only metadata is queried; never enumerate or read the target. An unknown
        // target (including a dangling link or permission error) fails closed.
        if (!fs.statSync(full).isFile()) throw new Error('directory link or unsafe symlink: ' + relative);
        files.push(relative);
      } else if (info.isDirectory()) pending.push(relative);
      else if (info.isFile()) files.push(relative);
      else throw new Error('unsupported worktree entry: ' + relative);
    }
  }
  return files;
}

function assertRelativePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.posix.isAbsolute(file)
      || path.win32.isAbsolute(file) || (process.platform === 'win32' && file.includes('\\'))
      || file.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('unsafe repository path: ' + String(file));
  }
}

function assertNoContentFilters(repo) {
  const scannedFiles = scanWorktree(repo);
  // Older Git versions ignore GIT_NO_LAZY_FETCH. Require the corresponding global
  // option as a capability check before any command that could read missing objects.
  const capability = run(repo, 'git', ['--no-lazy-fetch', '--version']);
  if (capability.status !== 0) throw new Error('Git lacks --no-lazy-fetch support');
  const listing = git(repo, ['ls-files', '--cached', '--others', '-z'], null);
  if (listing.status !== 0) throw new Error('git ls-files filter preflight failed');
  const names = listing.stdout.toString('utf8');
  if (!Buffer.from(names).equals(listing.stdout)) throw new Error('non-UTF-8 path in filter preflight');
  const paths = [...new Set([...names.split('\0').filter(Boolean), ...scannedFiles])];
  // An untracked nested repository is reported as a directory, not its files.
  // Historical snapshot/tree paths can nevertheless cause Git to hash files inside it.
  if (paths.some(file => file.endsWith('/'))) {
    throw new Error('nested Git repository is not supported by Git filter safety preflight');
  }
  for (const file of paths) assertRelativePath(file);
  const stages = git(repo, ['ls-files', '--stage', '-z']);
  if (stages.status !== 0) throw new Error('git index filter preflight failed');
  // Git status can recurse into a submodule and invoke its own filters. Refuse rather
  // than silently omit submodule changes or claim to have inspected its configuration.
  if (stages.stdout.split('\0').some(record => record.startsWith('160000 '))) {
    throw new Error('submodules are not supported by Git filter safety preflight');
  }
  if (!paths.length) return;
  const result = git(repo, ['check-attr', '-z', '--stdin', '--all'], null, Buffer.from(paths.join('\0') + '\0'));
  if (result.status !== 0) throw new Error('git check-attr filter preflight failed');
  const output = result.stdout.toString('utf8');
  if (!Buffer.from(output).equals(result.stdout)) throw new Error('non-UTF-8 attribute in filter preflight');
  const fields = output.split('\0');
  if (fields.pop() !== '' || fields.length % 3 !== 0) throw new Error('invalid git check-attr output');
  // --all distinguishes no attribute from literal values such as "unspecified".
  // Refusing even an explicit -filter is conservative and avoids ambiguous values.
  for (let i = 0; i < fields.length; i += 3) {
    if (fields[i + 1] === 'filter') throw new Error('custom Git filter not allowed: ' + fields[i]);
  }
}

function gitValue(cwd, args) {
  let result;
  try {
    result = git(cwd, args);
  } catch {
    return null;
  }
  return result.status === 0 ? result.stdout.trim() : null;
}

// Missing Git is a supported mode, not an error: a spawn failure here means "no Git", the
// caller falls back to the file-manifest path.
function isRepo(repo) {
  try {
    const probe = git(repo, ['rev-parse', '--is-inside-work-tree']);
    return probe.status === 0 && probe.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

function head(repo) {
  return gitValue(repo, ['rev-parse', 'HEAD']);
}

function branch(repo) {
  return gitValue(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function normalizePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalRepo(repo, gitMode) {
  if (gitMode) {
    const top = gitValue(repo, ['rev-parse', '--show-toplevel']);
    if (top) return path.resolve(top);
  }
  try {
    return resolveReal(repo);
  } catch {
    return path.resolve(repo);
  }
}

// fs.realpathSync leaves Windows 8.3 short names (C:\PROGRA~1) unexpanded, while
// fs.realpathSync.native (GetFinalPathNameByHandle) resolves them — and so does Git's
// --show-toplevel. A repository reached through a short-named TMP (CI runners use
// C:\Users\RUNNER~1) would compare unequal to the same path spelled in full, and the
// output guard would fail open. Every side of a comparison therefore resolves through
// the expanding resolver so the spellings agree.
function realPath(file) {
  const real = process.platform === 'win32' ? fs.realpathSync.native(file) : fs.realpathSync(file);
  // Drop the extended-length prefix realpathSync.native may keep, so plain
  // path.relative / startsWith logic stays correct.
  return real.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
}

// Resolve symlinks (and Windows 8.3 short names) for the deepest existing ancestor and
// append the not-yet-existing tail, so a link pointing back into the repository is
// detected even before the target exists.
function resolveReal(target) {
  let current = path.resolve(target);
  const pending = [];
  for (;;) {
    try {
      return path.join(realPath(current), ...pending.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

// Component-based containment: a directory literally named `..internal` is inside the
// repository; only a `..` component (or an absolute path) escapes.
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== '..' && !relative.startsWith('..' + path.sep);
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

// Git for Windows enumerates junctions as ordinary directories, so an entry path can
// leave the repository through a link component before the leaf. Return the first link
// component (or null) instead of a boolean: its own target is what identifies the link.
function linkComponent(root, rel) {
  let current = root;
  for (const part of String(rel).split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return null;
    }
  }
  return null;
}

// A link is fingerprinted by its own target string: enough to notice that it changed,
// without reading a single byte of whatever the target contains.
function linkFingerprint(file) {
  let digest = null;
  try {
    digest = sha256(fs.readlinkSync(file));
  } catch {
    digest = null;
  }
  return {status: 'link', sha256: digest, size: null};
}

function fingerprintPath(root, rel) {
  assertRelativePath(rel);
  const link = linkComponent(root, rel);
  if (link) return linkFingerprint(link);
  return fingerprintFile(path.join(root, rel));
}

function fingerprintFile(file) {
  let stat;
  try {
    // lstat, not stat: a symlink/junction is fingerprinted as itself. Reading the target
    // could hash (and later display) content that lives outside the repository.
    stat = fs.lstatSync(file);
  } catch (error) {
    return {status: error?.code === 'ENOENT' ? 'missing' : 'unreadable', sha256: null, size: null};
  }
  if (stat.isSymbolicLink()) return linkFingerprint(file);
  if (!stat.isFile()) return {status: 'unreadable', sha256: null, size: stat.size};
  try {
    const {sha256: digest, size} = hashFile(file);
    return {status: 'ok', sha256: digest, size};
  } catch {
    return {status: 'unreadable', sha256: null, size: stat.size};
  }
}

const blobCache = new Map();
// Small LRU of recent blob bodies: fingerprinting and viewing the same blob share one
// `cat-file -p` read even when other blobs are processed in between. Only bodies up to
// BODY_CACHE_LIMIT bytes are kept and at most BODY_CACHE_ENTRIES at a time, so a few
// huge blobs cannot balloon memory (they are simply re-read when needed).
const BODY_CACHE_LIMIT = 4 * 1024 * 1024;
const BODY_CACHE_ENTRIES = 8;
const blobBodyCache = new Map();

function blobBody(repo, sha) {
  if (blobBodyCache.has(sha)) {
    const buffer = blobBodyCache.get(sha);
    blobBodyCache.delete(sha);
    blobBodyCache.set(sha, buffer);  // refresh LRU position
    return buffer;
  }
  const result = git(repo, ['cat-file', '-p', sha], null);
  if (result.status !== 0) return null;
  if (result.stdout.length <= BODY_CACHE_LIMIT) {
    blobBodyCache.set(sha, result.stdout);
    if (blobBodyCache.size > BODY_CACHE_ENTRIES) {
      blobBodyCache.delete(blobBodyCache.keys().next().value);  // evict the least recent
    }
  }
  return result.stdout;
}

function blobFingerprint(repo, sha) {
  if (sha && typeof sha === 'object') return {...blobFingerprint(repo, sha.blob), mode: sha.mode};
  if (!sha) return {status: 'missing', sha256: null, size: null, blob: null};
  if (blobCache.has(sha)) return blobCache.get(sha);
  const sizeText = gitValue(repo, ['cat-file', '-s', sha]);
  if (sizeText === null) {
    const absent = {status: 'unreadable', sha256: null, size: null, blob: sha};
    blobCache.set(sha, absent);
    return absent;
  }
  const size = Number(sizeText);
  if (Number.isFinite(size) && size > BLOB_LIMIT) {
    const large = {status: 'toolarge', sha256: null, size, blob: sha};
    blobCache.set(sha, large);
    return large;
  }
  const buffer = blobBody(repo, sha);
  const value = buffer !== null
    ? {status: 'ok', sha256: sha256(buffer), size: buffer.length, blob: sha}
    : {status: 'unreadable', sha256: null, size, blob: sha};
  blobCache.set(sha, value);
  return value;
}

// Git's content id for a worktree file: clean filters (core.autocrlf, .gitattributes,
// eol conversions) are applied, so a checkout that only spells the same content with CRLF
// hashes equal to the HEAD blob instead of looking like a task change.
function worktreeContentId(repo, file) {
  // Under the stable-worktree boundary, never let Git follow a link or read a non-file.
  if (fingerprintPath(repo, file).status !== 'ok') return null;
  const result = git(repo, ['hash-object', '--', file]);
  return result.status === 0 ? result.stdout.trim() || null : null;
}

// Content view is the single place that decides "can this be shown completely?".
// `complete` is false for binary, oversized, truncated and unreadable content, and the
// caller records exactly one integrity entry for it.
// Text is only shown when the bytes round-trip through UTF-8 unchanged. Otherwise the
// decoder would silently substitute U+FFFD and the material would present characters the
// file does not contain; such content is reported as undecodable instead.
function decodesAsUtf8(slice) {
  return Buffer.from(slice.toString('utf8'), 'utf8').equals(slice);
}

// Blank lines are collapsed only outside fenced blocks: inside a fence the bytes belong to
// quoted file content and must survive verbatim, however many blank lines it carries.
function collapseBlankLines(text) {
  const out = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      out.push(line);
      continue;
    }
    if (line.trim() === '' && out.length && out[out.length - 1].trim() === '') continue;
    out.push(line);
  }
  return out.join('\n');
}

function worktreeView(repo, file) {
  const fingerprint = fingerprintPath(repo, file);
  if (fingerprint.status !== 'ok') {
    const kind = fingerprint.status === 'missing' ? 'missing'
      : fingerprint.status === 'link' ? 'link' : 'unreadable';
    return {kind, complete: false, fingerprint, ref: file, text: null,
      bytes: fingerprint.size, truncated: false};
  }
  if (fingerprint.size > BLOB_LIMIT) {
    return {kind: 'toolarge', complete: false, fingerprint, ref: file, text: null,
      bytes: fingerprint.size, truncated: true};
  }
  let descriptor;
  try {
    descriptor = fs.openSync(path.join(repo, file), 'r');
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(CONTENT_LIMIT, fingerprint.size === 0 ? 1 : fingerprint.size)));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, read);
    if (slice.includes(0)) {
      return {kind: 'binary', complete: false, fingerprint, ref: file, text: null,
        bytes: fingerprint.size, truncated: false};
    }
    const truncated = fingerprint.size > read;
    // A truncated slice may end mid-codepoint, so only complete reads are judged.
    if (!truncated && !decodesAsUtf8(slice)) {
      return {kind: 'undecodable', complete: false, fingerprint, ref: file, text: null,
        bytes: fingerprint.size, truncated: false};
    }
    return {kind: 'text', complete: !truncated, fingerprint, ref: file,
      text: slice.toString('utf8'), bytes: fingerprint.size, truncated};
  } catch {
    return {kind: 'unreadable', complete: false, fingerprint, ref: file, text: null,
      bytes: fingerprint.size, truncated: false};
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function blobView(repo, sha) {
  if (sha && typeof sha === 'object') {
    const view = blobView(repo, sha.blob);
    return {...view, fingerprint: {...view.fingerprint, mode: sha.mode}};
  }
  if (!sha) {
    return {kind: 'missing', complete: false, fingerprint: {status: 'missing', sha256: null, size: null, blob: null},
      ref: null, text: null, bytes: null, truncated: false};
  }
  const fingerprint = blobFingerprint(repo, sha);
  if (fingerprint.status === 'toolarge') {
    return {kind: 'toolarge', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: fingerprint.size, truncated: true};
  }
  if (fingerprint.status !== 'ok') {
    return {kind: 'unreadable', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: fingerprint.size, truncated: false};
  }
  const buffer = blobBody(repo, sha);
  if (buffer === null) {
    return {kind: 'unreadable', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: null, truncated: false};
  }
  const slice = buffer.subarray(0, Math.min(CONTENT_LIMIT, buffer.length));
  if (slice.includes(0)) {
    return {kind: 'binary', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: buffer.length, truncated: false};
  }
  const truncated = buffer.length > CONTENT_LIMIT;
  if (!truncated && !decodesAsUtf8(slice)) {
    return {kind: 'undecodable', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: buffer.length, truncated: false};
  }
  return {kind: 'text', complete: !truncated, fingerprint, ref: 'blob:' + sha,
    text: slice.toString('utf8'), bytes: buffer.length, truncated};
}

// Git identity includes metadata: equal bytes alone do not explain a mode-only change.
// A legacy SHA string lacks mode evidence and must never prove unchanged.
function sameGitEntry(left, right) {
  if (!left || !right) return left === right;
  return Boolean(left.blob && right.blob && left.mode && right.mode
    && left.blob === right.blob && left.mode === right.mode);
}

function sameFingerprint(left, right) {
  if (!left || !right || left.sha256 === null || left.sha256 !== right.sha256) return false;
  // Two links are the same when their recorded target strings match; two readable files
  // when their content digests match. Nothing else is proven equal.
  if (left.status === 'link' || right.status === 'link') return left.status === right.status;
  return left.status === 'ok' && right.status === 'ok';
}

// "Both absent" is a real state comparison, not a null coincidence; everything else needs
// two readable digests.
function sameState(left, right) {
  if (left?.status === 'missing' && right?.status === 'missing') return true;
  return sameFingerprint(left, right);
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

// Supported glob syntax: `?` one character inside a segment, `*` inside a segment, a `**`
// segment zero or more complete directories, a trailing `**` or `/` everything below.
function globToRegExp(glob) {
  let pattern = String(glob).replaceAll('\\', '/').replace(/^\.\//, '');
  if (pattern.endsWith('/')) pattern += '**';
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^/]+/)*';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

function scopeMatcher(patterns) {
  const regExps = patterns.map(globToRegExp);
  return file => regExps.some(re => re.test(file));
}

function parseScope(value) {
  if (value === undefined || value === null) return [];
  return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

// `git status --porcelain=v1 -z`: "XY<space>path", renames carry the original path next.
function statusEntries(repo) {
  const result = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (result.status !== 0) throw new Error('git status failed: ' + (result.stderr.trim() || result.status));
  const tokens = result.stdout.split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const x = token[0];
    const y = token[1];
    const file = token.slice(3);
    const renamedOrCopied = x === 'R' || x === 'C';
    entries.push({x, y, file, from: renamedOrCopied ? tokens[(i += 1)] ?? '' : null});
  }
  return entries;
}

// `git diff --name-status -z`: "STATUS\0path\0", renames add "STATUS\0old\0new\0".
function nameStatusZ(repo, args) {
  const result = git(repo, ['diff', '--name-status', '-z', '--no-color', ...args]);
  if (result.status !== 0) throw new Error('git diff --name-status failed: ' + (result.stderr.trim() || result.status));
  const tokens = result.stdout.split('\0');
  const items = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      items.push({kind, from: tokens[i + 1] ?? '', file: tokens[i + 2] ?? ''});
      i += 2;
    } else {
      items.push({kind, file: tokens[i + 1] ?? ''});
      i += 1;
    }
  }
  return items;
}

function indexBlobs(repo) {
  const result = git(repo, ['ls-files', '-s', '-z']);
  if (result.status !== 0) throw new Error('git ls-files failed: ' + (result.stderr.trim() || result.status));
  const blobs = new Map();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha] = record.slice(0, tab).split(' ');
    blobs.set(record.slice(tab + 1), {blob: sha, mode});
  }
  return blobs;
}

function treeBlobs(repo, revision) {
  const result = git(repo, ['ls-tree', '-r', '-z', revision]);
  // A failed listing used to look like "this revision has no files", which quietly turned
  // every committed file into an addition; fail loudly and let the caller record a limit.
  if (result.status !== 0) {
    throw new Error('git ls-tree failed for ' + revision + ': ' + (result.stderr.trim() || result.status));
  }
  const blobs = new Map();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(record.slice(tab + 1), {blob: sha, mode});
  }
  return blobs;
}

function resolveBlob(repo, revision, file) {
  if (!revision) return null;
  return gitValue(repo, ['rev-parse', '--verify', '--quiet', `${revision}:${file}`]) || null;
}

function manifest(repo, {skipGit}) {
  const files = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      if (skipGit && entry.name === '.git') continue;
      // Symlinks (to files or directories) and Windows junctions are reparse points, not
      // regular entries. They are listed with their own target digest (never followed,
      // never recursed into), so a link that appears, disappears or retargets is visible
      // as a change instead of silently vanishing from the comparison.
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        files[toPosix(path.relative(repo, full))] = linkFingerprint(full);
        continue;
      }
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[toPosix(path.relative(repo, full))] = fingerprintFile(full);
    }
  };
  walk(repo);
  return files;
}

function publishExclusive(file, content) {
  const output = path.resolve(file);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, {recursive: true});
  // Publish with an exclusive hard link: on Windows, wx alone can follow a dangling symlink.
  // The parent and its ancestors must be protected from concurrent replacement.
  const temporary = path.join(parent, `.review-material-${crypto.randomBytes(16).toString('hex')}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  let failure;
  try { fs.writeFileSync(fd, content, 'utf8'); } catch (error) { failure = error; }
  try { fs.closeSync(fd); } catch (error) {
    failure = failure ? new Error(failure.message + '; close failed: ' + error.message) : error;
  }
  if (!failure) {
    try { fs.linkSync(temporary, output); } catch (error) { failure = error; }
  }
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    const status = failure ? 'output not published: ' + failure.message : 'output published';
    throw new Error(status + '; temporary file cleanup failed: ' + temporary + ': ' + error.message);
  }
  if (failure) throw failure;
}

function assertDirectory(repo) {
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new Error('repository not found: ' + repo);
}

// The collector is advertised as read-only. Refuse any output that resolves inside the
// repository or onto the baseline, before mkdir/write, so existing bytes never change.
function assertSafeOutput(out, repo, snapshotPath) {
  const target = resolveReal(out);
  const repoReal = resolveReal(repo);
  if (snapshotPath && samePath(target, resolveReal(snapshotPath))) {
    throw new Error('--out must not overwrite the baseline snapshot: ' + path.resolve(out));
  }
  if (isInside(target, repoReal) || isInside(path.resolve(out), path.resolve(repo))) {
    throw new Error('--out must stay outside the repository (use the runtime root): ' + path.resolve(out));
  }
  // A hard link is the same inode under another name, so the resolved path looks innocent
  // while the write would land inside the repository (or on the baseline).
  try {
    const stat = fs.lstatSync(out);
    if (stat.isFile() && stat.nlink > 1) {
      throw new Error('--out is a hard link (nlink ' + stat.nlink + '); refusing to write through it: '
        + path.resolve(out));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function fingerprintSummary(fingerprint) {
  if (!fingerprint) return '（无）';
  const mode = fingerprint.mode ? '，Git mode ' + fingerprint.mode : '';
  if (fingerprint.status === 'ok') return fingerprint.sha256.slice(0, 12) + '…（' + fingerprint.size + ' 字节' + mode + '）';
  const detail = fingerprint.size === null ? '' : '，' + fingerprint.size + ' 字节';
  return '（' + fingerprint.status + detail + mode + '）';
}

function fenced(content, info = '') {
  const runs = content.match(/`{3,}/g) ?? [];
  const ticks = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)));
  return ticks + info + '\n' + content.replace(/\n$/, '') + '\n' + ticks + '\n';
}

function snapshot(repo, options) {
  const requested = path.resolve(repo);
  assertDirectory(requested);
  const gitMode = isRepo(requested);
  const root = canonicalRepo(requested, gitMode);
  assertSafeOutput(options.out, root, null);
  // Accepting these silently is worse than refusing: the flags cannot do anything here, and
  // a user who passed --base believes the snapshot records that base.
  if (options.base) throw new Error('snapshot does not accept --base: the baseline commit is read from HEAD');
  if (options.snapshot) throw new Error('snapshot does not accept --snapshot: it creates the baseline');
  // A re-snapshot over the same file would silently replace the recorded baseline with
  // the current state — work done between the two snapshots would then be attributed
  // to "pre-existing". Refuse instead: use a new --out path or delete the old baseline.
  if (fs.existsSync(options.out)) {
    throw new Error('baseline snapshot already exists: ' + path.resolve(options.out)
      + ' (use a new --out path or delete the old baseline; a silent overwrite would misattribute changes)');
  }
  if (gitMode) assertNoContentFilters(root);
  const base = gitMode ? head(root) : null;
  const state = {
    tool: TOOL,
    format: FORMAT,
    mode: gitMode ? 'git' : 'snapshot',
    repo: root,
    created_at: new Date().toISOString(),
    base,
    branch: gitMode ? branch(root) : null,
    scope: options.scope,
    scope_mode: options.scopeProvided ? (options.scope.length ? 'declared' : 'empty') : 'unspecified',
    dirty: {},
    untracked: {},
    files: {},
  };
  if (gitMode) {
    const index = indexBlobs(root);
    const tree = base ? treeBlobs(root, base) : new Map();
    for (const entry of statusEntries(root)) {
      if (entry.x === '?') {
        state.untracked[entry.file] = fingerprintPath(root, entry.file);
        continue;
      }
      state.dirty[entry.file] = {
        index: index.get(entry.file) ?? null,
        head: tree.get(entry.file) ?? (base ? resolveBlob(root, base, entry.file) : null),
        worktree: fingerprintPath(root, entry.file),
      };
      // A rename/copy reports only the new path. The old path is already absent from the
      // index and worktree at snapshot time, so without its own record collect would read the
      // old path back from the commit tree and charge the user's deletion to the task.
      if (entry.from && !Object.hasOwn(state.dirty, entry.from)) {
        state.dirty[entry.from] = {
          index: index.get(entry.from) ?? null,
          head: tree.get(entry.from) ?? (base ? resolveBlob(root, base, entry.from) : null),
          worktree: fingerprintPath(root, entry.from),
        };
      }
    }
  } else {
    state.files = manifest(root, {skipGit: true});
  }
  publishExclusive(options.out, JSON.stringify(state, null, 2) + '\n');
  return {
    ok: true,
    mode: state.mode,
    snapshot: path.resolve(options.out),
    repo: state.repo,
    base: state.base,
    branch: state.branch,
    scope: state.scope,
    scope_mode: state.scope_mode,
    dirty_files: Object.keys(state.dirty).sort(),
    untracked_files: Object.keys(state.untracked).sort(),
    tracked_files: Object.keys(state.files).length,
  };
}

function readSnapshot(file, {repo, mode, options}) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error('baseline snapshot not found: ' + file);
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('baseline snapshot is unreadable: ' + file + ' (' + (error?.message ?? error) + ')');
  }
  if (state?.tool !== TOOL || state?.format !== FORMAT) throw new Error('unsupported snapshot format: ' + file);
  if (state.mode !== mode) {
    throw new Error(`snapshot mode ${state.mode} does not match the current ${mode} mode for ${repo}`);
  }
  if (!state.repo || !samePath(state.repo, repo)) {
    throw new Error('snapshot belongs to another repository: ' + (state.repo ?? '(unknown)') + ' != ' + repo);
  }
  for (const field of ['dirty', 'untracked', 'files']) {
    if (state[field] != null && (typeof state[field] !== 'object' || Array.isArray(state[field]))) {
      throw new Error('invalid snapshot paths: ' + field);
    }
    for (const name of Object.keys(state[field] ?? {})) assertRelativePath(name);
  }
  if (options.scopeProvided) {
    const left = [...options.scope].sort();
    const right = [...(state.scope ?? [])].sort();
    if (left.join('\n') !== right.join('\n')) {
      throw new Error('collect scope differs from the baseline snapshot scope; take a new snapshot instead of changing the scope silently: '
        + JSON.stringify(right) + ' -> ' + JSON.stringify(left));
    }
  }
  if (options.base && state.base && options.base !== state.base) {
    throw new Error('--base conflicts with the snapshot baseline: ' + options.base + ' != ' + state.base);
  }
  if (options.base && !state.base) {
    throw new Error('--base was given but the snapshot recorded no baseline commit');
  }
  return state;
}

function resolveScope(options, state) {
  if (options.scopeProvided) {
    return {mode: options.scope.length ? 'declared' : 'empty', patterns: options.scope};
  }
  if (state && Array.isArray(state.scope)) {
    if (state.scope_mode === 'declared') return {mode: 'declared', patterns: state.scope};
    if (state.scope_mode === 'empty') return {mode: 'empty', patterns: []};
  }
  return {mode: 'unspecified', patterns: []};
}

function scopeOf(file, scope) {
  if (scope.mode === 'unspecified') return 'unscoped';
  if (scope.mode === 'empty') return 'out';
  return scopeMatcher(scope.patterns)(file) ? 'in' : 'out';
}

// A snapshot with `base: null` recorded "no commit existed"; that is different from "no
// snapshot". Compare against the empty tree so the first commit is fully visible.
function resolveBase(root, options, state, currentHead) {
  if (options.base) return {kind: 'commit', sha: options.base};
  if (state) {
    if (state.base) return {kind: 'commit', sha: state.base};
    return {kind: 'empty', sha: emptyTree(root)};
  }
  if (currentHead) return {kind: 'commit', sha: currentHead};
  return {kind: 'none', sha: null};
}

// The empty tree id depends on the repository's object format (SHA-1 vs SHA-256). Ask Git
// for the id of an empty tree instead of hard-coding a SHA-1 value.
function emptyTree(repo) {
  try {
    const result = git(repo, ['hash-object', '-t', 'tree', '--stdin'], 'utf8', '');
    const sha = result.status === 0 ? result.stdout.trim() : '';
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) return sha;
  } catch {}
  return EMPTY_TREE_SHA1;
}

function hasDiff(repo, args, file) {
  const result = git(repo, ['diff', '--quiet', '--no-color', ...args, '--', file]);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error('git diff --quiet failed: ' + (result.stderr.trim() || result.status));
}

// Diff in bounded batches: a large change set used to be handed to Git in one argv, which
// on Windows dies at the command-line length limit (ENAMETOOLONG) before any diff exists.
const DIFF_BATCH = 200;

function diffFor(repo, args, files) {
  if (!files.length) return '';
  const parts = [];
  for (let index = 0; index < files.length; index += DIFF_BATCH) {
    const batch = files.slice(index, index + DIFF_BATCH);
    const result = git(repo, ['diff', '--no-color', ...args, '--', ...batch]);
    if (result.status !== 0) throw new Error('git diff failed: ' + (result.stderr.trim() || result.status));
    if (result.stdout.trim()) parts.push(result.stdout.trim());
  }
  return parts.length ? fenced(parts.join('\n') + '\n', 'diff') : '';
}

// Markdown rendering of the collected records: pure presentation, no collection
// semantics. It may still append integrity limits it discovers while rendering (for
// example an unshowable baseline body in section 5), which collect() folds back into
// the summary so the header line and the JSON never disagree.
function renderMaterial({root, requested, options, gitMode, baseInfo, currentHead, scope, state, summary, changes, limits, notes, baselineOf, undetectable}) {
  const inScope = entry => entry.scope === 'in';
  const layerLabel = {committed: '提交', index: '暂存', worktree: '工作区', untracked: '未跟踪', baseline: '任务开始时'};
  const lines = [];
  lines.push(`# ${options.label ? options.label + ' ' : ''}评审材料`, '');
  lines.push(`- 仓库：${root}`);
  if (!samePath(requested, root)) lines.push(`- 采集入口：${requested}（已规范化为仓库根）`);
  lines.push(`- 模式：${gitMode ? 'git' : '无 Git（文件清单与指纹）'}`);
  lines.push(`- 分支：${gitMode ? branch(root) ?? '（未知）' : '不适用'}`);
  lines.push(gitMode
    ? `- BASE：${baseInfo.kind === 'empty' ? '空树（快照记录当时无提交）' : baseInfo.sha ?? '（无）'}`
    : '- BASE：不适用（无 Git，按前后文件清单与指纹比较）');
  lines.push(`- HEAD：${currentHead ?? '（无提交）'}`);
  lines.push(`- 任务写入范围（scope）：${scope.mode === 'declared' ? scope.patterns.join('、') : scope.mode === 'empty' ? '（显式空：本任务不写产品文件）' : '（未声明：材料按未归属列示）'}`);
  lines.push(`- 基线快照：${state ? state.created_at + '（' + state.mode + '，基线 ' + (state.base ?? (gitMode ? '无提交' : '无 Git')) + '）' : '未提供'}`);
  lines.push(`- 完整性：${summary.integrity.status}${limits.length ? '（' + limits.length + ' 项见第 8 节）' : ''}`);
  lines.push(`- 采集时间：${new Date().toISOString()}`, '');
  lines.push('## 机器已核对 / 须协调者核对', '');
  if (state) {
    lines.push(`- 已核对：基线快照属于本仓库且模式一致（${state.mode}）；候选集合 = 基线文件 ∪ 当前 Git 变化 ∪ 提交变化。`);
    lines.push('- 已核对：每条变化的归属用对应层的基线内容比较；工作区摘要相同不会覆盖索引或提交层的判断。');
    lines.push('- 已核对：只有实际比较成立的文件才写入“本次未变化”。');
  } else {
    lines.push('- 未核对：没有基线快照，任务前归属标为 unknown；本材料不构成完整的归属证明。');
  }
  lines.push('- 须协调者核对：同一文件被用户与任务先后修改时只能标为「mixed」；范围外变化是否属其他并行线；材料是否与交付块一致。');
  lines.push('- 本工具不提交、不暂存、不重置工作区，也不判断验收是否通过。', '');

  // Baseline content view for a deletion: HEAD/snapshot blob when available.
  function baselineView(file) {
    const baseline = baselineOf(file);
    if (baseline.head) return blobView(root, baseline.head);
    // Non-Git snapshots store digests, not bodies: keep the digest and say the body is gone.
    if (baseline.worktree && baseline.worktree.status === 'ok') {
      return {kind: 'digest-only', complete: false, fingerprint: baseline.worktree,
        ref: file, text: null, bytes: baseline.worktree.size, truncated: false};
    }
    // A baseline that was itself a link (or unreadable) still has a recorded identity; the
    // deletion must show what was compared against instead of falling through to "（无）".
    if (baseline.worktree && baseline.worktree.status !== 'ok') {
      return {kind: baseline.worktree.status, complete: false, fingerprint: baseline.worktree,
        ref: file, text: null, bytes: baseline.worktree.size, truncated: false};
    }
    return null;
  }

  function renderView(entry) {
    if (entry.view.kind === 'text' && entry.view.text !== null) {
      const parts = [];
      if (entry.view.truncated) parts.push(`（正文截断：共 ${entry.view.bytes} 字节，仅展示前 ${CONTENT_LIMIT}）`);
      parts.push(fenced(entry.view.text));
      return parts;
    }
    return [`- 内容未展开（${entry.view.kind}）；摘要 ${fingerprintSummary(entry.view.fingerprint)}，引用 ${entry.view.ref ?? '（无）'}。`];
  }

  const renderNote = entry => {
    if (entry.attribution === 'pre-existing') {
      // A baseline record is the user's task-start content, so "only changed its state" would
      // be wrong there: nothing about the file changed during the task.
      if (entry.layer === 'baseline') return `> ${entry.file}：任务开始时已是该内容，本次未变化，不计入本任务实现内容。`;
      return `> ${entry.file}：内容与任务开始时一致，仅${layerLabel[entry.layer]}状态变化，不计入本任务实现内容。`;
    }
    if (entry.attribution === 'mixed') return `> ${entry.file}：任务开始时已有改动，当前内容与任务开始时不同（mixed），须协调者核对归属。`;
    if (entry.attribution === 'unknown') return `> ${entry.file}：归属无法证实（${entry.note ?? '缺少基线'}），差异保留供评审。`;
    return '';
  };
  // addChange already drops pre-existing worktree/untracked records, so that rule has a
  // single decision point; rendering only applies the scope filter.
  const renameSuffix = entry => (entry.oldPath ? `，重命名自 ${entry.oldPath}` : '');
  const renderable = entry => inScope(entry);
  const byLayer = layer => entry => entry.layer === layer && renderable(entry);
  const baselineFingerprint = entry => {
    const baseline = baselineOf(entry.file);
    // Attribution always compares content against the user's task-start content, so the
    // displayed baseline digest must be the same value (falling back to the layer blob
    // only when no worktree digest exists, e.g. a file that was absent).
    if (baseline.worktree && baseline.worktree.status === 'ok') {
      return {...baseline.worktree, mode: baseline.index?.mode};
    }
    // A clean tracked file's task-start content is the HEAD blob (Git content id, not raw
    // bytes), so that blob is the baseline digest to display.
    if (baseline.worktree && baseline.worktree.status === 'clean' && baseline.head) {
      return blobFingerprint(root, baseline.head);
    }
    if (entry.layer === 'index') return baseline.index ? blobFingerprint(root, baseline.index) : null;
    if (entry.layer === 'committed') return baseline.head ? blobFingerprint(root, baseline.head) : null;
    return baseline.worktree ?? null;
  };
  // One record per change must always yield reviewable material. `git diff --quiet` is
  // asked per file, so a layer diff that only covers some files cannot hide the others.
  const supplement = entries => {
    lines.push('（以下文件在该层没有 Git 文本差异，但相对任务基线发生变化；按摘要与当前内容补充列示）', '');
    for (const entry of entries) {
      lines.push(`### ${entry.file}（${layerLabel[entry.layer]}）`, '');
      lines.push(`- 基线指纹：${fingerprintSummary(baselineFingerprint(entry))}`);
      lines.push(`- 当前指纹：${fingerprintSummary(entry.view.fingerprint)}`);
      if (entry.view.kind === 'text' && entry.view.text !== null) {
        lines.push('- 当前内容：', '', fenced(entry.view.text));
      } else {
        lines.push(`- 当前内容未展开（${entry.view.kind}），引用 ${entry.view.ref ?? '（无）'}。`);
      }
    }
    lines.push('');
  };
  // Changes this layer holds but the declared scope excludes. They are listed in section 7,
  // never merged into the delivery, but a layer must not report "no change" when they exist:
  // that wording is what makes a reviewer conclude the task touched nothing.
  const outsideIn = layer => changes.filter(entry => entry.layer === layer && !inScope(entry)).length;
  const section = (title, layer, args, empty) => {
    const entries = changes.filter(byLayer(layer));
    const outside = outsideIn(layer);
    lines.push(title, '');
    if (!entries.length) {
      lines.push(outside
        ? `（本任务范围内无${layerLabel[layer]}变化；该层另有 ${outside} 项范围外/未声明范围变化，见第 7 节）`
        : empty, '');
      return;
    }
    const files = [...new Set(entries.map(entry => entry.file))];
    const diff = diffFor(root, args, files);
    for (const entry of entries) {
      // The old path is part of the change: without it a rename reads as a deletion plus an
      // unrelated addition.
      if (entry.oldPath) lines.push(`> ${entry.file}：重命名自 ${entry.oldPath}（旧路径的删除见第 5 节）。`);
      if (entry.note) lines.push(renderNote(entry));
    }
    if (diff) lines.push(diff, '');
    const uncovered = entries.filter(entry => !hasDiff(root, args, entry.file));
    if (uncovered.length) supplement(uncovered);
    if (!diff && !uncovered.length) lines.push(empty, '');
  };

  if (gitMode) {
    section('## 1. 本任务提交差异（BASE..HEAD）', 'committed', [`${baseInfo.sha}..HEAD`],
      baseInfo.kind === 'none' ? '（仓库尚无提交，见第 8 节限制）' : '（无提交差异）');
  } else {
    lines.push('## 1. 本任务提交差异（BASE..HEAD）', '', '（无 Git：不适用，见第 3 节文件指纹与内容）', '');
  }
  section('## 2. 暂存区差异（尚未提交）', 'index', ['--cached'], gitMode ? '（无暂存变化）' : '（无 Git：不适用）');
  if (gitMode) {
    section('## 3. 未暂存差异（工作区 vs 索引）', 'worktree', [], '（无未暂存变化）');
    // Files whose index entry differs but whose worktree still matches the task-start
    // content: the difference comes from staging, not from the task writing new content.
    const indexDifferenceOnly = summary.unstaged.filter(file => !changes.some(entry => entry.file === file && entry.layer === 'worktree'));
    if (indexDifferenceOnly.length) {
      lines.push(`> 以下文件相对索引有差异，但工作区内容与任务开始时一致，差异来自暂存/索引操作，未计入本任务实现内容：${indexDifferenceOnly.join('、')}`, '');
    }
  } else {
    const entries = changes.filter(entry => entry.scope === 'in' && entry.layer === 'worktree' && entry.kind !== 'deleted');
    lines.push('## 3. 文件变化（无 Git：前后指纹 + 当前内容）', '');
    if (undetectable) {
      lines.push('（无基线快照：无法判断任务期间是否修改，见第 8 节）', '');
    } else if (!entries.length) {
      const outsideWorktree = outsideIn('worktree');
      lines.push(outsideWorktree
        ? `（本任务范围内无修改；该层另有 ${outsideWorktree} 项范围外/未声明范围变化，见第 7 节；新增见第 4 节，删除见第 5 节）`
        : '（无修改；新增见第 4 节，删除见第 5 节）', '');
    }
    for (const entry of entries) {
      const before = state?.files?.[entry.file] ?? null;
      lines.push(`### ${entry.file}（${entry.kind === 'deleted' ? '已删除' : '修改'}）`, '');
      lines.push(`- 基线指纹：${fingerprintSummary(before)}`);
      lines.push(`- 当前指纹：${fingerprintSummary(entry.view.fingerprint)}`, '');
      if (entry.kind !== 'deleted') lines.push(...renderView(entry));
    }
    lines.push('');
  }

  const untracked = changes.filter(byLayer('untracked'));
  lines.push('## 4. 未跟踪新增文件（内容）', '');
  if (undetectable) {
    lines.push('（无基线快照：无法判断任务期间是否新增，见第 8 节）', '');
  } else if (!untracked.length) {
    const outsideUntracked = outsideIn('untracked');
    lines.push(outsideUntracked
      ? `（本任务范围内无未跟踪新增；该层另有 ${outsideUntracked} 项范围外/未声明范围变化，见第 7 节）`
      : '（无未跟踪文件）', '');
  }
  for (const entry of untracked) {
    lines.push(`### ${entry.file}`, '');
    if (entry.note) lines.push(renderNote(entry));
    lines.push(...renderView(entry));
  }
  lines.push('');

  lines.push('## 5. 删除的文件', '');
  const deletions = changes.filter(entry => entry.kind === 'deleted' && inScope(entry));
  if (undetectable) {
    lines.push('（无基线快照：无法判断任务期间是否删除，见第 8 节）', '');
  } else if (!deletions.length) {
    // Deletions span layers (a rename leaves both an index and a worktree record), so counting
    // records would overstate the files a reviewer has to look at.
    const outsideDeleted = changes.filter(entry => entry.kind === 'deleted' && !inScope(entry));
    const outsideFiles = new Set(outsideDeleted.map(entry => entry.file)).size;
    lines.push(outsideFiles
      ? `（本任务范围内无删除；另有 ${outsideFiles} 个文件的范围外/未声明范围删除，见第 7 节）`
      : '（无删除）', '');
  }
  for (const entry of deletions) {
    const reason = entry.attribution === 'pre-existing'
      ? '任务开始前已不存在，不计入本任务'
      : entry.attribution === 'mixed'
        ? '任务开始时已存在且内容并非本任务所写，须协调者核对'
        : entry.attribution === 'unknown'
          ? '归属无法证实'
          : '任务期间删除';
    lines.push(`### ${entry.file}（${layerLabel[entry.layer]}，${reason}）`, '');
    const baseline = state ? baselineOf(entry.file) : null;
    const before = state ? baselineView(entry.file) : null;
    lines.push(`- 基线指纹：${fingerprintSummary(before?.fingerprint ?? null)}`);
    if (before && before.kind === 'text' && before.text !== null) {
      const origin = baseline?.kind === 'dirty' ? '，取自基线 HEAD；任务前工作区内容未保留' : '';
      lines.push(`- 基线内容（${before.bytes} 字节${before.truncated ? '，已截断' : ''}${origin}）：`, '');
      lines.push(fenced(before.text));
      if (before.truncated) {
        limits.push({file: entry.file, layer: entry.layer, kind: 'text', reason: 'baseline content truncated',
          bytes: before.bytes, ref: before.ref, digest: before.fingerprint?.sha256 ?? null});
      }
    } else if (before && before.kind === 'digest-only') {
      lines.push(`- 基线正文不可用（快照只保存摘要，未保存旧正文）；基线指纹与大小见上，引用：${before.ref}。`);
      limits.push({file: entry.file, layer: entry.layer, kind: 'digest-only',
        reason: 'baseline body not stored', bytes: before.bytes,
        ref: before.ref, digest: before.fingerprint?.sha256 ?? null});
    } else if (before && (before.kind === 'link' || before.kind === 'unreadable')) {
      lines.push(before.kind === 'link'
        ? `- 基线记录为 link（未读取链接目标字节）；基线指纹为链接自身目标的摘要，引用：${before.ref}。`
        : `- 基线不可读（unreadable）；基线指纹与大小见上，引用：${before.ref}。`);
      limits.push({file: entry.file, layer: entry.layer, kind: before.kind,
        reason: before.kind === 'link' ? 'baseline is a link (target not read)' : 'baseline unreadable',
        bytes: before.bytes, ref: before.ref, digest: before.fingerprint?.sha256 ?? null});
    } else {
      lines.push(`- 基线内容不可完整展示（${before?.kind ?? 'unknown'}）；凭指纹与引用核对：${before?.ref ?? '（无）'}。`);
      limits.push({file: entry.file, layer: entry.layer, kind: before?.kind ?? 'missing',
        reason: 'baseline content unavailable', bytes: before?.bytes ?? null,
        ref: before?.ref ?? null, digest: before?.fingerprint?.sha256 ?? null});
    }
    lines.push('');
  }

  lines.push('## 6. 任务前已有改动（不归于本任务）', '');
  const pre = changes.filter(entry => inScope(entry) && entry.attribution === 'pre-existing');
  const mixed = changes.filter(entry => inScope(entry) && entry.attribution === 'mixed');
  const unknown = changes.filter(entry => inScope(entry) && entry.attribution === 'unknown');
  if (undetectable) {
    lines.push('（无基线快照：无法判断任务前是否已有改动，见第 8 节）', '');
  } else if (!pre.length && !mixed.length && !unknown.length) {
    // With an empty or unspecified scope nothing can be attributed, so a bare "none" would be
    // a false statement whenever the user did have task-start changes.
    const outsidePre = changes.filter(entry => !inScope(entry) && entry.attribution === 'pre-existing').length;
    lines.push(scope.mode === 'declared' || outsidePre === 0
      ? '（无）'
      : `（未声明或空范围内无法按范围归属任务前改动；第 7 节列有 ${outsidePre} 项范围外/未声明范围记录）`, '');
  }
  for (const entry of pre) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}${renameSuffix(entry)}）：${entry.layer === 'baseline' ? '任务开始时已改动，本次未变化' : '内容一致或仅位置变化'}；不计入本任务实现内容。`);
  for (const entry of mixed) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}${renameSuffix(entry)}）：${entry.note ?? '内容混合'}；须协调者核对。`);
  for (const entry of unknown) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}${renameSuffix(entry)}）：${entry.note ?? '归属无法证实'}。`);
  lines.push('');

  lines.push('## 7. 范围外 / 未声明范围的变化', '');
  const outside = changes.filter(entry => entry.scope !== 'in');
  if (undetectable) lines.push('（无基线快照：无法判断任务期间是否发生任何变化，无从按范围归属，见第 8 节）', '');
  else if (!outside.length) lines.push('（无）', '');
  if (scope.mode !== 'declared') lines.push(`> 范围状态：${scope.mode === 'empty' ? '显式空范围（只读任务不写产品文件），下列变化未并入本任务交付' : '未声明写入范围，无法按范围归属；如需整仓请显式 --scope "**"'}。`, '');
  for (const entry of outside) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}，${entry.scope === 'out' ? '范围外' : '未声明范围'}${renameSuffix(entry)}）`);
  lines.push('');
  // A declared scope leaves these as a bare list because the paths belong to other lines.
  // An empty or unspecified scope has no such owner: this is then the only material a
  // reviewer can read, so the content is shown in full while still marked as not delivered.
  if (scope.mode !== 'declared' && outside.length) {
    lines.push('### 未归属变化的内容（不计入本任务交付，供评审核对）', '');
    for (const entry of outside) {
      lines.push(`#### ${entry.file}（${layerLabel[entry.layer]}）`, '');
      if (entry.oldPath) lines.push(`- 重命名自：${entry.oldPath}`);
      lines.push(`- 基线指纹：${fingerprintSummary(baselineFingerprint(entry))}`);
      if (entry.kind === 'deleted') {
        lines.push('- 当前状态：已删除', '');
        continue;
      }
      lines.push(`- 当前指纹：${fingerprintSummary(entry.view.fingerprint)}`, '');
      if (entry.note) lines.push(renderNote(entry));
      // An unchanged record is the user's task-start content: show what it is, but do not
      // expand a body that the task never touched.
      if (entry.kind === 'unchanged') {
        lines.push('');
        continue;
      }
      lines.push(...renderView(entry));
      lines.push('');
    }
  }

  if (notes.length || limits.length) {
    lines.push('## 8. 采集限制', '');
    for (const note of notes) lines.push('- ' + note);
    for (const limit of limits) {
      if (limit.kind === 'no-snapshot') {
        lines.push(`- incomplete: ${limit.reason}（只有当前状态，缺少任务前基线，归属见第 6、7 节）`);
        continue;
      }
      lines.push(`- incomplete: ${limit.file}（${layerLabel[limit.layer] ?? limit.layer}，${limit.reason}，${limit.bytes ?? '未知'} 字节，摘要 ${limit.digest ? limit.digest.slice(0, 12) + '…' : '不可用'}，引用 ${limit.ref ?? '（无）'}）`);
    }
    lines.push('');
  }
  return lines;
}

function collect(repo, options) {
  const requested = path.resolve(repo);
  assertDirectory(requested);
  const gitMode = isRepo(requested);
  const root = canonicalRepo(requested, gitMode);
  const mode = gitMode ? 'git' : 'snapshot';
  const state = readSnapshot(options.snapshot, {repo: root, mode, options});
  // Without Git and without a snapshot nothing about task-time changes is detectable; every
  // section's empty state must then read as "undeterminable", never as "no changes".
  const undetectable = !gitMode && !state;
  assertSafeOutput(options.out, root, options.snapshot);
  const scope = resolveScope(options, state);
  if (gitMode) assertNoContentFilters(root);
  const currentHead = gitMode ? head(root) : null;
  const baseInfo = resolveBase(root, options, state, currentHead);
  const notes = [];
  const limits = [];
  const changes = [];
  const seen = new Set();
  const summary = {
    ok: true,
    mode,
    output: path.resolve(options.out),
    snapshot_used: Boolean(state),
    snapshot_repo: state?.repo ?? null,
    base: baseInfo.kind === 'empty' ? null : baseInfo.sha,
    base_kind: baseInfo.kind,
    head: currentHead,
    scope: scope.patterns,
    scope_mode: scope.mode,
    committed: [], staged: [], unstaged: [], untracked: [], deleted: [], renamed: [],
    task: [], pre_existing: [], pre_existing_also_modified: [], out_of_scope: [], unscoped: [],
    integrity: {status: 'complete', limits},
    notes,
  };

  // No baseline snapshot means task-start attribution cannot be verified at all, so the
  // material is incomplete by construction even when every body stays readable.
  if (!state) {
    limits.push({
      file: '（基线快照）', layer: 'baseline', kind: 'no-snapshot',
      reason: 'no baseline snapshot: task-start attribution unknown',
      bytes: null, ref: null, digest: null,
    });
    summary.integrity.status = 'incomplete';
  }

  const recordLimit = (change, view) => {
    if (view.complete) return;
    if (change.kind === 'deleted' && view.kind === 'missing') return;
    limits.push({
      file: change.file,
      layer: change.layer,
      kind: view.kind,
      reason: view.kind === 'text' ? 'content truncated' : view.kind,
      bytes: view.bytes,
      ref: view.ref,
      digest: view.fingerprint?.sha256 ?? null,
    });
  };

  const addChange = (change, view) => {
    const key = change.layer + ':' + change.file;
    if (seen.has(key)) return null;
    seen.add(key);
    const verdict = attribute({...change, view}, baselineOf(change.file));
    // For the worktree/untracked layers the baseline is the same layer, so an equal
    // digest means nothing changed there (a status difference can still exist because the
    // index moved). Keep the record only when the layer itself changed.
    if (verdict.attribution === 'pre-existing' && (change.layer === 'worktree' || change.layer === 'untracked')) return null;
    const entry = {...change, view, attribution: verdict.attribution, note: verdict.note,
      scope: scopeOf(change.file, scope)};
    changes.push(entry);
    recordLimit(entry, view);
    if (entry.scope === 'out') summary.out_of_scope.push({file: entry.file, layer: entry.layer, attribution: entry.attribution});
    else if (entry.scope === 'unscoped') summary.unscoped.push({file: entry.file, layer: entry.layer, attribution: entry.attribution});
    else if (entry.attribution === 'task') summary.task.push({file: entry.file, layer: entry.layer, attribution: entry.attribution});
    else if (entry.attribution === 'pre-existing') summary.pre_existing.push({file: entry.file, layer: entry.layer, attribution: entry.attribution, note: entry.note});
    else summary.pre_existing_also_modified.push({file: entry.file, layer: entry.layer, attribution: entry.attribution, note: entry.note});
    return entry;
  };

  // Baseline per path. `index` decides whether the index layer changed; `worktree` is the
  // task-start content digest used both for worktree change detection and for content
  // attribution, so an index that differs from the worktree at task start is not itself a
  // change.
  // A failed tree listing degrades attribution; it must be a recorded limit, not an empty
  // tree that silently turns every committed file into an addition.
  const safeTreeBlobs = revision => {
    try {
      return treeBlobs(root, revision);
    } catch (error) {
      notes.push('修订 ' + revision + ' 的目录树无法读取：' + error.message + '；该修订的提交层归属可能降级。');
      limits.push({
        file: '（' + revision + ' 目录树）', layer: 'committed', kind: 'unreadable',
        reason: 'git ls-tree failed: ' + error.message,
        bytes: null, ref: null, digest: null,
      });
      return new Map();
    }
  };
  const baseTree = state?.base ? safeTreeBlobs(state.base) : new Map();
  const baselineCache = new Map();
  const baselineOf = file => {
    if (baselineCache.has(file)) return baselineCache.get(file);
    let value;
    if (!state) value = {kind: 'unknown'};
    else if (state.mode === 'snapshot') {
      const before = state.files?.[file];
      value = before
        ? {kind: 'file', head: null, index: null, worktree: before}
        : {kind: 'absent'};
    } else if (Object.hasOwn(state.untracked ?? {}, file)) {
      value = {kind: 'untracked', head: null, index: null, worktree: state.untracked[file]};
    } else if (Object.hasOwn(state.dirty ?? {}, file)) {
      const entry = state.dirty[file];
      if ([entry.index, entry.head].some(value => value && !value.mode)) {
        limits.push({file, layer: 'baseline', kind: 'metadata',
          reason: 'snapshot lacks Git mode metadata; legacy blob-only baseline cannot prove mode attribution or unchanged state',
          bytes: null, ref: null, digest: null});
      }
      value = {kind: 'dirty', head: entry.head, index: entry.index, worktree: entry.worktree};
    } else {
      const headBlob = state.base ? baseTree.get(file) ?? null : null;
      // A tracked file that was clean at task start held exactly the HEAD blob content in
      // Git's own normalization; recording that as a 'clean' baseline keeps raw worktree
      // bytes (CRLF, filters) out of the comparison.
      value = headBlob
        ? {kind: 'tracked', head: headBlob, index: headBlob, worktree: {status: 'clean', sha256: headBlob.blob, size: null}}
        : {kind: 'absent'};
    }
    baselineCache.set(file, value);
    return value;
  };

  // Attribution answers "whose content is this", separately from "did this layer change".
  function attribute(change, baseline) {
    if (!state) return {attribution: 'unknown', note: '未提供基线快照，任务前归属无法判断'};
    if (baseline.kind === 'unknown') return {attribution: 'unknown', note: '基线与当前模式不一致'};
    if (baseline.kind === 'absent' || baseline.kind === 'tracked' || baseline.kind === 'file') {
      return {attribution: 'task', note: null};
    }
    const before = baseline.worktree;
    if (baseline.kind === 'dirty' && ['index', 'committed'].includes(change.layer) && change.kind !== 'deleted') {
      if (baseline.index && !baseline.index.mode) return {attribution: 'unknown', note: '旧快照缺少 Git mode，无法证实元数据归属'};
      if (baseline.index && change.view.fingerprint.mode !== baseline.index.mode) {
        return {attribution: 'mixed', note: '任务开始时已有改动，Git mode 与任务开始时不同'};
      }
    }
    if (change.kind === 'deleted') {
      if (!before || before.status === 'missing') return {attribution: 'pre-existing', note: '任务开始前已不存在'};
      // A clean tracked baseline holds the user's pre-existing committed content, so deleting
      // it removes content this task did not write.
      if (before.status === 'ok' || before.status === 'clean') {
        return {attribution: 'mixed', note: '删除的内容并非本任务所写（任务开始时已存在改动）'};
      }
      return {attribution: 'unknown', note: '基线摘要不可用（大文件或不可读）'};
    }
    // Compare in the same normalization the change detector used: a clean baseline is a Git
    // content id, never raw bytes.
    const comparable = before && before.status === 'clean'
      ? (id => (id ? {status: 'ok', sha256: id, size: null} : {status: 'unreadable', sha256: null, size: null}))(worktreeContentId(root, change.file))
      : before;
    if (sameState(comparable, change.view.fingerprint)) {
      return {attribution: 'pre-existing', note: '内容与任务开始时一致，仅位置/状态变化'};
    }
    if (!comparable || comparable.status !== 'ok' || change.view.fingerprint.status !== 'ok') {
      return {attribution: 'unknown', note: '缺少可比较的内容摘要（大文件或不可读）'};
    }
    return {attribution: 'mixed', note: '任务开始时已有改动，当前内容与任务开始时不同'};
  }

  if (gitMode) {
    const index = indexBlobs(root);
    const treeNow = currentHead ? safeTreeBlobs(currentHead) : new Map();
    const status = statusEntries(root);
    const statusByFile = new Map(status.map(entry => [entry.file, entry]));
    const committed = currentHead && (baseInfo.kind === 'commit' || baseInfo.kind === 'empty')
      ? nameStatusZ(root, [`${baseInfo.sha}..HEAD`])
      : [];
    if (baseInfo.kind === 'empty') notes.push('基线快照记录当时没有提交：以空树为 BASE 比较首次提交，不用当前 HEAD 覆盖已记录的空基线。');
    if (baseInfo.kind === 'none') notes.push('仓库没有任何提交：无法生成提交差异，改用工作区与指纹核对。');

    const committedFingerprints = new Map();
    const addCommitted = item => {
      const view = item.kind === 'D'
        ? blobView(root, resolveBlob(root, baseInfo.sha, item.file))
        : blobView(root, treeNow.get(item.file) ?? resolveBlob(root, 'HEAD', item.file));
      committedFingerprints.set(item.file, view.fingerprint);
      summary.committed.push(item.file);
      if (item.kind === 'D') summary.deleted.push(item.file);
      addChange({file: item.file, layer: 'committed', kind: item.kind === 'D' ? 'deleted' : 'modified'}, view);
    };

    for (const item of committed) {
      if (item.kind === 'R') {
        summary.renamed.push({from: item.from, file: item.file, layer: 'committed'});
        summary.deleted.push(item.from);
        addChange({file: item.from, layer: 'committed', kind: 'deleted'},
          blobView(root, resolveBlob(root, baseInfo.sha, item.from)));
        addCommitted({kind: 'A', file: item.file});
        continue;
      }
      addCommitted(item);
    }

    // Candidates are the union of baseline files, current status paths and committed paths.
    // Status only supplies candidates: whether a layer changed is decided by comparing that
    // layer with its own baseline, never by the presence of a status letter.
    const candidates = new Set([
      ...Object.keys(state?.dirty ?? {}),
      ...Object.keys(state?.untracked ?? {}),
      ...status.map(entry => entry.file),
      ...status.filter(entry => entry.from).map(entry => entry.from),
      ...committed.map(item => item.file),
      ...committed.filter(item => item.from).map(item => item.from),
    ]);

    const evaluated = new Map();
    for (const file of [...candidates].sort()) {
      const entry = statusByFile.get(file) ?? null;
      const baseline = baselineOf(file);
      const currentIndex = index.get(file) ?? null;
      const currentWt = fingerprintPath(root, file);
      // A task commit is another observed state: restoring the index to its task-start
      // entry still differs from that commit and must remain a separate review layer.
      const indexChanged = !sameGitEntry(currentIndex, baseline.index ?? null)
        || (committedFingerprints.has(file) && !sameGitEntry(currentIndex, treeNow.get(file) ?? null));
      // A clean tracked baseline is compared by Git content id; anything else (dirty or
      // untracked baselines) stored raw worktree bytes and is compared byte for byte.
      const cleanBaseline = baseline.worktree?.status === 'clean';
      const contentId = cleanBaseline ? worktreeContentId(root, file) : null;
      const worktreeChanged = cleanBaseline
        ? currentWt.status !== 'ok' || contentId === null || contentId !== baseline.worktree.sha256
        : !sameState(baseline.worktree ?? {status: 'missing', sha256: null, size: null}, currentWt);
      evaluated.set(file, {indexChanged, worktreeChanged, cleanBaseline, contentId});

      // The status arrays keep mirroring what Git reports; records are created separately.
      if (entry) {
        if (entry.x === '?') summary.untracked.push(file);
        else {
          if (entry.x !== ' ') summary.staged.push(file);
          if (entry.y !== ' ') summary.unstaged.push(file);
        }
        if (entry.x === 'R' && entry.from) {
          summary.renamed.push({from: entry.from, file, layer: 'index'});
          summary.deleted.push(entry.from);
        }
        if (entry.x === 'D' || entry.y === 'D') summary.deleted.push(file);
      }
      if (committed.some(item => item.file === file && item.kind === 'D')) summary.deleted.push(file);

      if (entry && entry.x === '?') {
        // Untracked files produce a record only when their content moved from the baseline.
        if (worktreeChanged) {
          addChange({file, layer: 'untracked', kind: baseline.kind === 'untracked' ? 'modified' : 'added'},
            worktreeView(root, file));
        }
        continue;
      }

      const committedFingerprint = committedFingerprints.get(file) ?? null;
      let indexFingerprint = null;
      if (indexChanged) {
        const view = blobView(root, currentIndex);
        indexFingerprint = view.fingerprint;
        if (!sameGitEntry(indexFingerprint, committedFingerprint)) {
          addChange({file, layer: 'index', kind: currentIndex ? 'modified' : 'deleted', oldPath: entry?.from ?? null}, view);
        }
      }
      if (worktreeChanged) {
        // A worktree that only matches the recorded index or commit is already covered by
        // that layer; a worktree restored to a *pre-task* value is still a task change.
        const explainedByIndex = cleanBaseline
          ? Boolean(contentId && currentIndex && contentId === currentIndex.blob)
          : sameFingerprint(currentWt, indexFingerprint);
        const explainedByCommit = cleanBaseline
          ? Boolean(contentId && committedFingerprint?.blob && contentId === committedFingerprint.blob)
          : sameFingerprint(currentWt, committedFingerprint);
        if (!explainedByIndex && !explainedByCommit) {
          addChange({file, layer: 'worktree', kind: currentWt.status === 'missing' ? 'deleted' : 'modified', oldPath: entry?.from ?? null},
            worktreeView(root, file));
        }
      }
    }

    // Baseline edits with no rendered layer are either proven unchanged (both comparisons
    // succeeded) or moved in a way no rendered layer covers.
    for (const file of [...Object.keys(state?.dirty ?? {}), ...Object.keys(state?.untracked ?? {})]) {
      const info = evaluated.get(file);
      if (!info) continue;
      if (changes.some(change => change.file === file && change.layer !== 'baseline')) continue;
      const scopeClass = scopeOf(file, scope);
      if (info.indexChanged || info.worktreeChanged) {
        changes.push({file, layer: 'baseline', kind: 'changed-unrendered', scope: scopeClass,
          attribution: 'unknown', note: '检测到任务期间变化但无法归属到具体层，须协调者核对',
          view: worktreeView(root, file)});
        if (scopeClass === 'out') summary.out_of_scope.push({file, layer: 'baseline', attribution: 'unknown'});
        else if (scopeClass === 'unscoped') summary.unscoped.push({file, layer: 'baseline', attribution: 'unknown'});
        else summary.pre_existing_also_modified.push({file, layer: 'baseline', attribution: 'unknown'});
        continue;
      }
      changes.push({file, layer: 'baseline', kind: 'unchanged', scope: scopeClass,
        attribution: 'pre-existing', note: '任务开始时已改动，本次未变化', view: worktreeView(root, file)});
      if (scopeClass === 'in') summary.pre_existing.push({file, layer: 'baseline', attribution: 'pre-existing'});
      else if (scopeClass === 'out') summary.out_of_scope.push({file, layer: 'baseline', attribution: 'pre-existing'});
      else summary.unscoped.push({file, layer: 'baseline', attribution: 'pre-existing'});
    }
    if (!state) notes.push('未提供基线快照：归属标为 unknown，材料列出当前全部变化，不声称验证过任务前归属。');
  } else {
    // Same manifest universe as snapshot(): a .git directory that Git itself cannot read
    // (binary missing, broken repo) must not surface its internals as task additions.
    const current = manifest(root, {skipGit: true});
    const before = state?.files ?? null;
    if (fs.existsSync(path.join(root, '.git'))) {
      notes.push('仓库内存在 .git，但 Git 无法读取（未安装或仓库损坏）：本次按无 Git 模式采集，提交历史不参与比对。');
    }
    // Links are part of the manifest now, so their presence must show up in integrity: the
    // comparison stops at the link's own target string and never reads the target.
    for (const [file, fingerprint] of Object.entries(current)) {
      if (fingerprint.status !== 'link' || scopeOf(file, scope) === 'out') continue;
      if (limits.some(limit => limit.file === file && limit.layer === 'worktree')) continue;
      limits.push({file, layer: 'worktree', kind: 'link', reason: 'link (target not read)',
        bytes: null, ref: file, digest: fingerprint.sha256});
    }
    if (!state) notes.push('未提供基线快照：无 Git 模式下没有可比较的基线，无法检测任务期间的变化，第 3–7 节的空态均为“无法判定”而非“无变化”。');
    if (before) {
      for (const [file, fingerprint] of Object.entries(current)) {
        if (!(file in before)) {
          summary.untracked.push(file);
          addChange({file, layer: 'untracked', kind: 'added'}, worktreeView(root, file));
        } else if (!sameState(before[file], fingerprint)) {
          summary.unstaged.push(file);
          addChange({file, layer: 'worktree', kind: 'modified'}, worktreeView(root, file));
        }
      }
      for (const file of Object.keys(before)) {
        if (file in current) continue;
        summary.deleted.push(file);
        addChange({file, layer: 'worktree', kind: 'deleted'}, blobView(root, null));
      }
    }
  }

  summary.committed = [...new Set(summary.committed)];
  summary.staged = [...new Set(summary.staged)];
  summary.unstaged = [...new Set(summary.unstaged)];
  summary.untracked = [...new Set(summary.untracked)];
  summary.deleted = [...new Set(summary.deleted)].sort();
  summary.renamed = summary.renamed.filter(Boolean);
  for (const list of [summary.task, summary.pre_existing, summary.pre_existing_also_modified, summary.out_of_scope, summary.unscoped]) {
    list.sort((a, b) => a.file.localeCompare(b.file) || a.layer.localeCompare(b.layer));
  }
  const lines = renderMaterial({root, requested, options, gitMode, baseInfo, currentHead, scope, state,
    summary, changes, limits, notes, baselineOf, undetectable});

  // Section 5 can add integrity entries, so the status and its header line are finalised
  // together; summary and Markdown must never disagree.
  if (limits.length) {
    summary.integrity.status = 'incomplete';
    const headerIndex = lines.findIndex(line => line.startsWith('- 完整性：'));
    if (headerIndex >= 0) lines[headerIndex] = `- 完整性：incomplete（${limits.length} 项见第 8 节）`;
  }

  const material = collapseBlankLines(lines.join('\n'));
  publishExclusive(options.out, material);
  summary.material_bytes = Buffer.byteLength(material, 'utf8');
  return summary;
}

const USAGE = [
  'usage:',
  '  node review-material.mjs snapshot --repo <dir> --out <file> [--scope <a,b>]',
  '  node review-material.mjs collect  --repo <dir> --out <file> [--base <sha>] [--snapshot <file>] [--scope <a,b>] [--label T-1-01]',
  '  --scope "" declares an explicit empty writable scope; omitting --scope inherits the snapshot scope, otherwise it is unspecified.',
  '  snapshot reads its base from HEAD and accepts neither --base nor --snapshot.',
].join('\n');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {command, repo: null, out: null, base: null, snapshot: null, label: null, scope: [], scopeProvided: false};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!['--repo', '--out', '--base', '--snapshot', '--scope', '--label'].includes(flag)) {
      throw Object.assign(new Error('unknown argument: ' + flag + '\n' + USAGE), {kind: 'usage'});
    }
    if (value === undefined) throw Object.assign(new Error('missing value for ' + flag + '\n' + USAGE), {kind: 'usage'});
    if (flag === '--scope') {
      options.scope = parseScope(value);
      options.scopeProvided = true;
    } else options[flag.slice(2)] = value;
    i += 1;
  }
  if (!['snapshot', 'collect'].includes(command)) throw Object.assign(new Error(USAGE), {kind: 'usage'});
  if (!options.repo || !options.out) throw Object.assign(new Error('--repo and --out are required\n' + USAGE), {kind: 'usage'});
  return options;
}

// Comparing the *real* paths keeps the CLI working when the script is reached through a
// junction or symlink (a plain URL comparison silently exits 0 with no output there).
function invokedDirectly() {
  try {
    return samePath(realPath(process.argv[1] ?? ''), realPath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.command === 'snapshot' ? snapshot(options.repo, options) : collect(options.repo, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ok: false, errors: [error?.message ?? String(error)]}, null, 2));
    process.exitCode = 2;
  }
}

export {snapshot, collect, globToRegExp, parseArgs, resolveReal, emptyTree, worktreeContentId};
