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
import {pathToFileURL} from 'node:url';

const TOOL = 'review-material';
const FORMAT = 2;
const CONTENT_LIMIT = 200 * 1024;
const BLOB_LIMIT = 20 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

function run(cwd, command, args, encoding = 'utf8') {
  const result = spawnSync(command, args, {cwd, encoding, maxBuffer: 256 * 1024 * 1024});
  return {
    status: result.status,
    stdout: result.stdout ?? (encoding ? '' : Buffer.alloc(0)),
    stderr: result.stderr ?? '',
  };
}

// --literal-pathspecs keeps a file name containing `*` or `?` from being read as a
// pathspec pattern; core.quotePath=false keeps non-ASCII paths readable without touching
// the user's Git configuration.
function git(cwd, args) {
  return run(cwd, 'git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args]);
}

function gitBuffer(cwd, args) {
  return run(cwd, 'git', ['-c', 'core.quotePath=false', '--literal-pathspecs', ...args], null);
}

function gitValue(cwd, args) {
  const result = git(cwd, args);
  return result.status === 0 ? result.stdout.trim() : null;
}

function isRepo(repo) {
  const probe = git(repo, ['rev-parse', '--is-inside-work-tree']);
  return probe.status === 0 && probe.stdout.trim() === 'true';
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
    return path.resolve(fs.realpathSync(repo));
  } catch {
    return path.resolve(repo);
  }
}

// Resolve symlinks for the deepest existing ancestor and append the not-yet-existing tail,
// so a link pointing back into the repository is detected even before the target exists.
function resolveReal(target) {
  let current = path.resolve(target);
  const pending = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...pending.reverse());
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

function fingerprintFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    return {status: error?.code === 'ENOENT' ? 'missing' : 'unreadable', sha256: null, size: null};
  }
  if (!stat.isFile()) return {status: 'unreadable', sha256: null, size: stat.size};
  try {
    const {sha256: digest, size} = hashFile(file);
    return {status: 'ok', sha256: digest, size};
  } catch {
    return {status: 'unreadable', sha256: null, size: stat.size};
  }
}

const blobCache = new Map();

function blobFingerprint(repo, sha) {
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
  const content = gitBuffer(repo, ['cat-file', '-p', sha]);
  const value = content.status === 0
    ? {status: 'ok', sha256: sha256(content.stdout), size: content.stdout.length, blob: sha}
    : {status: 'unreadable', sha256: null, size, blob: sha};
  blobCache.set(sha, value);
  return value;
}

// Content view is the single place that decides "can this be shown completely?".
// `complete` is false for binary, oversized, truncated and unreadable content, and the
// caller records exactly one integrity entry for it.
function worktreeView(repo, file) {
  const fingerprint = fingerprintFile(path.join(repo, file));
  if (fingerprint.status !== 'ok') {
    return {kind: fingerprint.status === 'missing' ? 'missing' : 'unreadable', complete: false,
      fingerprint, ref: file, text: null, bytes: fingerprint.size, truncated: false};
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
  const result = gitBuffer(repo, ['cat-file', '-p', sha]);
  if (result.status !== 0) {
    return {kind: 'unreadable', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: null, truncated: false};
  }
  const buffer = result.stdout;
  const slice = buffer.subarray(0, Math.min(CONTENT_LIMIT, buffer.length));
  if (slice.includes(0)) {
    return {kind: 'binary', complete: false, fingerprint, ref: 'blob:' + sha, text: null,
      bytes: buffer.length, truncated: false};
  }
  const truncated = buffer.length > CONTENT_LIMIT;
  return {kind: 'text', complete: !truncated, fingerprint, ref: 'blob:' + sha,
    text: slice.toString('utf8'), bytes: buffer.length, truncated};
}

function sameFingerprint(left, right) {
  return Boolean(left && right) && left.status === 'ok' && right.status === 'ok'
    && left.sha256 !== null && left.sha256 === right.sha256;
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
    const rename = x === 'R' || x === 'C';
    entries.push({x, y, file, from: rename ? tokens[(i += 1)] ?? '' : null});
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
    const [, sha] = record.slice(0, tab).split(' ');
    blobs.set(record.slice(tab + 1), sha);
  }
  return blobs;
}

function treeBlobs(repo, revision) {
  const result = git(repo, ['ls-tree', '-r', '-z', revision]);
  if (result.status !== 0) return new Map();
  const blobs = new Map();
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [, type, sha] = record.slice(0, tab).split(' ');
    if (type === 'blob') blobs.set(record.slice(tab + 1), sha);
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
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files[toPosix(path.relative(repo, full))] = fingerprintFile(full);
    }
  };
  walk(repo);
  return files;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8'});
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
}

function fingerprintSummary(fingerprint) {
  if (!fingerprint) return '（无）';
  if (fingerprint.status === 'ok') return fingerprint.sha256.slice(0, 12) + '…（' + fingerprint.size + ' 字节）';
  const detail = fingerprint.size === null ? '' : '，' + fingerprint.size + ' 字节';
  return '（' + fingerprint.status + detail + '）';
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
        state.untracked[entry.file] = fingerprintFile(path.join(root, entry.file));
        continue;
      }
      state.dirty[entry.file] = {
        index: index.get(entry.file) ?? null,
        head: tree.get(entry.file) ?? (base ? resolveBlob(root, base, entry.file) : null),
        worktree: fingerprintFile(path.join(root, entry.file)),
      };
    }
  } else {
    state.files = manifest(root, {skipGit: true});
  }
  writeJson(options.out, state);
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
  if (options.scopeProvided) {
    const left = [...options.scope].sort();
    const right = [...(state.scope ?? [])].sort();
    if (left.join('\n') !== right.join('\n')) {
      throw new Error('collect scope differs from the baseline snapshot scope; take a new snapshot instead of widening silently: '
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
function resolveBase(options, state, currentHead) {
  if (options.base) return {kind: 'commit', sha: options.base, source: 'cli'};
  if (state) {
    if (state.base) return {kind: 'commit', sha: state.base, source: 'snapshot'};
    return {kind: 'empty', sha: EMPTY_TREE, source: 'snapshot-base-null'};
  }
  if (currentHead) return {kind: 'commit', sha: currentHead, source: 'head'};
  return {kind: 'none', sha: null, source: 'none'};
}

function hasDiff(repo, args, file) {
  const result = git(repo, ['diff', '--quiet', '--no-color', ...args, '--', file]);
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  throw new Error('git diff --quiet failed: ' + (result.stderr.trim() || result.status));
}

function diffFor(repo, args, files) {
  if (!files.length) return '';
  const result = git(repo, ['diff', '--no-color', ...args, '--', ...files]);
  if (result.status !== 0) throw new Error('git diff failed: ' + (result.stderr.trim() || result.status));
  return result.stdout.trim() ? fenced(result.stdout, 'diff') : '';
}

function collect(repo, options) {
  const requested = path.resolve(repo);
  assertDirectory(requested);
  const gitMode = isRepo(requested);
  const root = canonicalRepo(requested, gitMode);
  const mode = gitMode ? 'git' : 'snapshot';
  const state = readSnapshot(options.snapshot, {repo: root, mode, options});
  assertSafeOutput(options.out, root, options.snapshot);
  const scope = resolveScope(options, state);
  const currentHead = gitMode ? head(root) : null;
  const baseInfo = resolveBase(options, state, currentHead);
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
  const baseTree = state?.base ? treeBlobs(root, state.base) : new Map();
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
      value = {kind: 'dirty', head: entry.head, index: entry.index, worktree: entry.worktree};
    } else {
      const headBlob = state.base ? baseTree.get(file) ?? null : null;
      value = headBlob
        ? {kind: 'tracked', head: headBlob, index: headBlob, worktree: blobFingerprint(root, headBlob)}
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
    if (change.kind === 'deleted') {
      if (!before || before.status === 'missing') return {attribution: 'pre-existing', note: '任务开始前已不存在'};
      if (before.status === 'ok') return {attribution: 'mixed', note: '删除的内容并非本任务所写（任务开始时已存在改动）'};
      return {attribution: 'unknown', note: '基线摘要不可用（大文件或不可读）'};
    }
    if (sameState(before, change.view.fingerprint)) {
      return {attribution: 'pre-existing', note: '内容与任务开始时一致，仅位置/状态变化'};
    }
    if (!before || before.status !== 'ok' || change.view.fingerprint.status !== 'ok') {
      return {attribution: 'unknown', note: '缺少可比较的内容摘要（大文件或不可读）'};
    }
    return {attribution: 'mixed', note: '任务开始时已有改动，当前内容与任务开始时不同'};
  }

  if (gitMode) {
    const index = indexBlobs(root);
    const treeNow = currentHead ? treeBlobs(root, currentHead) : new Map();
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
      const currentIndexSha = index.get(file) ?? null;
      const currentWt = fingerprintFile(path.join(root, file));
      const indexChanged = currentIndexSha !== (baseline.index ?? null);
      const worktreeChanged = !sameState(baseline.worktree ?? {status: 'missing', sha256: null, size: null}, currentWt);
      evaluated.set(file, {indexChanged, worktreeChanged});

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
        const view = blobView(root, currentIndexSha);
        indexFingerprint = view.fingerprint;
        if (!sameFingerprint(indexFingerprint, committedFingerprint)) {
          addChange({file, layer: 'index', kind: currentIndexSha ? 'modified' : 'deleted', oldPath: entry?.from ?? null}, view);
        }
      }
      if (worktreeChanged) {
        // A worktree that only matches the recorded index or commit is already covered by
        // that layer; a worktree restored to a *pre-task* value is still a task change.
        const explainedByIndex = sameFingerprint(currentWt, indexFingerprint);
        const explainedByCommit = sameFingerprint(currentWt, committedFingerprint);
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
    const current = manifest(root, {skipGit: false});
    const before = state?.files ?? null;
    if (!state) notes.push('未提供基线快照：无 Git 模式下没有可比较的基线，材料只列出当前文件清单与指纹。');
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
  const inScope = entry => entry.scope === 'in';
  const layerLabel = {committed: '提交', index: '暂存', worktree: '工作区', untracked: '未跟踪', baseline: '任务开始时'};
  const lines = [];
  lines.push(`# ${options.label ? options.label + ' ' : ''}评审材料`, '');
  lines.push(`- 仓库：${root}`);
  if (!samePath(requested, root)) lines.push(`- 采集入口：${requested}（已规范化为仓库根）`);
  lines.push(`- 模式：${gitMode ? 'git' : '无 Git（文件清单与指纹）'}`);
  lines.push(`- 分支：${gitMode ? branch(root) ?? '（未知）' : '不适用'}`);
  lines.push(`- BASE：${baseInfo.kind === 'empty' ? '空树（快照记录当时无提交）' : baseInfo.sha ?? '（无）'}`);
  lines.push(`- HEAD：${currentHead ?? '（无提交）'}`);
  lines.push(`- 任务写入范围（scope）：${scope.mode === 'declared' ? scope.patterns.join('、') : scope.mode === 'empty' ? '（显式空：本任务不写产品文件）' : '（未声明：材料按未归属列示）'}`);
  lines.push(`- 基线快照：${state ? state.created_at + '（' + state.mode + '，基线 ' + (state.base ?? '无提交') + '）' : '未提供'}`);
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

  const renderNote = entry => {
    if (entry.attribution === 'pre-existing') return `> ${entry.file}：内容与任务开始时一致，仅${layerLabel[entry.layer]}状态变化，不计入本任务实现内容。`;
    if (entry.attribution === 'mixed') return `> ${entry.file}：任务开始时已有改动，当前内容与任务开始时不同（mixed），须协调者核对归属。`;
    if (entry.attribution === 'unknown') return `> ${entry.file}：归属无法证实（${entry.note ?? '缺少基线'}），差异保留供评审。`;
    return '';
  };
  const renderable = entry => inScope(entry)
    && !(entry.attribution === 'pre-existing' && (entry.layer === 'worktree' || entry.layer === 'untracked'));
  const byLayer = layer => entry => entry.layer === layer && renderable(entry);
  const baselineFingerprint = entry => {
    const baseline = baselineOf(entry.file);
    // Attribution always compares content against the user's task-start content, so the
    // displayed baseline digest must be the same value (falling back to the layer blob
    // only when no worktree digest exists, e.g. a file that was absent).
    if (baseline.worktree && baseline.worktree.status === 'ok') return baseline.worktree;
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
  const section = (title, layer, args, empty) => {
    const entries = changes.filter(byLayer(layer));
    lines.push(title, '');
    if (!entries.length) {
      lines.push(empty, '');
      return;
    }
    const files = [...new Set(entries.map(entry => entry.file))];
    const diff = diffFor(root, args, files);
    for (const entry of entries) if (entry.note) lines.push(renderNote(entry));
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
    const indexOnly = summary.unstaged.filter(file => !changes.some(entry => entry.file === file && entry.layer === 'worktree'));
    if (indexOnly.length) {
      lines.push(`> 以下文件相对索引有差异，但工作区内容与任务开始时一致，差异来自暂存/索引操作，未计入本任务实现内容：${indexOnly.join('、')}`, '');
    }
  } else {
    const entries = changes.filter(entry => entry.scope === 'in' && entry.layer === 'worktree' && entry.kind !== 'deleted');
    lines.push('## 3. 文件变化（无 Git：前后指纹 + 当前内容）', '');
    if (!entries.length) lines.push('（无修改；新增见第 4 节，删除见第 5 节）', '');
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
  if (!untracked.length) lines.push('（无未跟踪文件）', '');
  for (const entry of untracked) {
    lines.push(`### ${entry.file}`, '');
    if (entry.note) lines.push(renderNote(entry));
    lines.push(...renderView(entry));
  }
  lines.push('');

  lines.push('## 5. 删除的文件', '');
  const deletions = changes.filter(entry => entry.kind === 'deleted' && inScope(entry));
  if (!deletions.length) lines.push('（无删除）', '');
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
  if (!pre.length && !mixed.length && !unknown.length) lines.push('（无）', '');
  for (const entry of pre) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}）：${entry.layer === 'baseline' ? '任务开始时已改动，本次未变化' : '内容一致或仅位置变化'}；不计入本任务实现内容。`);
  for (const entry of mixed) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}）：${entry.note ?? '内容混合'}；须协调者核对。`);
  for (const entry of unknown) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}）：${entry.note ?? '归属无法证实'}。`);
  lines.push('');

  lines.push('## 7. 范围外 / 未声明范围的变化', '');
  const outside = changes.filter(entry => entry.scope !== 'in');
  if (!outside.length) lines.push('（无）', '');
  if (scope.mode !== 'declared') lines.push(`> 范围状态：${scope.mode === 'empty' ? '显式空范围（只读任务不写产品文件），下列变化未并入本任务交付' : '未声明写入范围，无法按范围归属；如需整仓请显式 --scope "**"'}。`, '');
  for (const entry of outside) lines.push(`- ${entry.file}（${layerLabel[entry.layer]}，${entry.scope === 'out' ? '范围外' : '未声明范围'}）`);
  lines.push('');

  if (notes.length || limits.length) {
    lines.push('## 8. 采集限制', '');
    for (const note of notes) lines.push('- ' + note);
    for (const limit of limits) {
      lines.push(`- incomplete: ${limit.file}（${layerLabel[limit.layer] ?? limit.layer}，${limit.reason}，${limit.bytes ?? '未知'} 字节，摘要 ${limit.digest ? limit.digest.slice(0, 12) + '…' : '不可用'}，引用 ${limit.ref ?? '（无）'}）`);
    }
    lines.push('');
  }

  // Section 5 can add integrity entries, so the status and its header line are finalised
  // together; summary and Markdown must never disagree.
  if (limits.length) {
    summary.integrity.status = 'incomplete';
    const headerIndex = lines.findIndex(line => line.startsWith('- 完整性：'));
    if (headerIndex >= 0) lines[headerIndex] = `- 完整性：incomplete（${limits.length} 项见第 8 节）`;
  }

  fs.mkdirSync(path.dirname(path.resolve(options.out)), {recursive: true});
  fs.writeFileSync(options.out, lines.join('\n').replace(/\n{3,}/g, '\n\n'), {encoding: 'utf8'});
  summary.material_bytes = fs.statSync(options.out).size;
  return summary;

  // Baseline content view for a deletion: HEAD/snapshot blob when available.
  function baselineView(file) {
    const baseline = baselineOf(file);
    if (baseline.head) return blobView(root, baseline.head);
    // Non-Git snapshots store digests, not bodies: keep the digest and say the body is gone.
    if (baseline.worktree && baseline.worktree.status === 'ok') {
      return {kind: 'digest-only', complete: false, fingerprint: baseline.worktree,
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
}

const USAGE = [
  'usage:',
  '  node review-material.mjs snapshot --repo <dir> --out <file> [--scope <a,b>]',
  '  node review-material.mjs collect  --repo <dir> --out <file> [--base <sha>] [--snapshot <file>] [--scope <a,b>] [--label T-1-01]',
  '  --scope "" declares an explicit empty writable scope; omitting --scope inherits the snapshot scope, otherwise it is unspecified.',
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = options.command === 'snapshot' ? snapshot(options.repo, options) : collect(options.repo, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ok: false, errors: [error?.message ?? String(error)]}, null, 2));
    process.exitCode = 2;
  }
}

export {snapshot, collect, globToRegExp, parseArgs};
