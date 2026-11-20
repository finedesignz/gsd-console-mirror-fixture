#!/usr/bin/env node
// GSD Console mirror hook (MIRROR-04, Phase 12 D-15). Committed to a repository as .claude/hooks/gsd-console-mirror.mjs
// and run by Claude Code after each tool call and when the agent stops, it pushes the repository's changed .planning/
// files to the console's hook ingest, so the board of a cloud session moves while the session works, not only after a
// merge. Served by the console at /assets/mirror-hook.mjs; docs/MIRROR.md "Hook feed" has the settings block.
//
//   node .claude/hooks/gsd-console-mirror.mjs <console origin>
//
// - It runs only in a cloud session (CLAUDE_CODE_REMOTE=true). A local machine is mirrored by the connector.
// - It sends no credential. The cloud environment's network secret for the console host (a token with mirror:write) is
//   attached by the session's agent proxy after the request leaves the VM.
// - It starts no process: git facts are read from the .git directory, and the request is Node's own fetch.
// - The file write is the truth and the push only a notice: a failure is reported on stderr with exit 1 (never exit 2,
//   which would keep a Stop hook's agent from stopping), the files stay as written, and a later run sends what is still
//   unsent (the state of what the console holds is in .git/, saved after each delivered request). After a failure the
//   runs of the next minute send nothing, so an unreachable console does not slow every tool call.
// - The first run of a clone, branch, project or origin sends the manifest of .planning/ first: the console tombstones
//   what this clone no longer has (a file an earlier session pushed) and answers the files it lacks.
// - The Stop run is the last chance to deliver: it waits for a background run that holds the lock (at most 35 seconds:
//   20 of budget and one 15 second request), then scans again, and it ignores the backoff. A background run (after a
//   tool call) that finds the lock leaves the work to the holder and to the next run.
// - Each request gives up after 15 seconds. A background run starts no request after 20 seconds and the Stop run none
//   after 40 counted from its start, inside the 60 second timeout of the settings block; what is left goes with the next
//   run.
// - Text files only (.md .json .yaml .yml .txt), forward-slash paths relative to .planning/, sha256 of the raw bytes,
//   bodies up to 512 KB (a larger or non-text file keeps hash and size, truncated), symlinks skipped, at most 200 files
//   per request: the rules of the console's ingest.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TEXT_EXTENSIONS = new Set(['.md', '.json', '.yaml', '.yml', '.txt']);
const BODY_MAX_BYTES = 512 * 1024;
const MAX_FILES = 5000;
const FILES_PER_REQUEST = 200;
const REQUEST_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const RUN_BUDGET_MS = 40_000; // the Stop run, which may wait for the lock first
const BACKGROUND_BUDGET_MS = 20_000; // a run after a tool call, so it releases the lock while a Stop run can still wait
const BACKOFF_MS = 60_000;
const LOCK_WAIT_MS = 38_000;
const LOCK_POLL_MS = 250;
const PATH_MAX = 400;
const LOCK_STALE_MS = 120_000;
const STATE_NAME = 'gsd-console-mirror.json';
const SLUG = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
// The ingest protocol (hosted/mirror/schema.js PROTOCOL); the console answers 426 to any other.
const PROTOCOL = '1';

const say = (message) => process.stderr.write(`gsd-console mirror: ${message}\n`);

/** Whether the console takes this path (hosted/mirror/schema.js pathProblem). */
export function isMirrorablePath(relative) {
  if (relative.length < 1 || relative.length > PATH_MAX) return false;
  if (relative !== relative.normalize('NFC')) return false;
  if (relative.startsWith('/') || relative.includes('\\') || relative.includes(':')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what this refuses
  if (/[\u0000-\u001f\u007f-\u009f]/.test(relative)) return false;
  if (relative.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return false;
  const dot = relative.lastIndexOf('.');
  return TEXT_EXTENSIONS.has(dot > relative.lastIndexOf('/') ? relative.slice(dot).toLowerCase() : '');
}

/** owner/name, lowercased, from a git remote URL (https, ssh:// or scp-like), or null. */
export function slugFromRemote(remote) {
  let tail = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    try {
      tail = new URL(remote).pathname;
    } catch {
      tail = null;
    }
  } else {
    tail = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(remote)?.[1] ?? null;
  }
  const parts = (tail ?? '')
    .replace(/\.git\/?$/i, '')
    .split('/')
    .filter(Boolean);
  const slug = parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}`.toLowerCase() : '';
  return SLUG.test(slug) ? slug : null;
}

/** Every mirrorable file of <dir>/.planning as the ingest takes it, keyed by path. */
export function scanPlanning(dir) {
  const root = path.join(dir, '.planning');
  const files = new Map();
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    return files;
  }
  if (!stat.isDirectory()) return files;
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile() && isMirrorablePath(relative)) {
        if (files.size >= MAX_FILES) throw new Error(`.planning has more than ${MAX_FILES} mirrorable files`);
        const bytes = fs.readFileSync(full);
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const text = bytes.length <= BODY_MAX_BYTES ? bytes.toString('utf8') : null;
        const storable = text !== null && !text.includes('\u0000') && Buffer.from(text, 'utf8').equals(bytes);
        files.set(relative, {
          path: relative,
          sha256,
          size: bytes.length,
          body: storable ? text : null,
          truncated: !storable,
        });
      }
    }
  };
  walk(root, '');
  return files;
}

/** The requests that bring the console from `held` (path -> sha256) to `files`: changed files and deleted paths. */
export function plan(held, files) {
  const changed = [...files.values()].filter((file) => held[file.path] !== file.sha256);
  const deleted = Object.keys(held).filter((pathName) => !files.has(pathName));
  const requests = [];
  let current = { files: [], deleted: [] };
  let bytes = 0;
  const flush = () => {
    if (current.files.length > 0 || current.deleted.length > 0) requests.push(current);
    current = { files: [], deleted: [] };
    bytes = 0;
  };
  for (const file of changed) {
    // The bytes the file adds to the JSON request: the 4 MB body limit of the ingest counts encoded bytes.
    const size = Buffer.byteLength(JSON.stringify(file)) + 1;
    if (current.files.length >= FILES_PER_REQUEST || (current.files.length > 0 && bytes + size > REQUEST_BYTES))
      flush();
    current.files.push(file);
    bytes += size;
  }
  for (const pathName of deleted) {
    if (current.deleted.length >= FILES_PER_REQUEST) flush();
    current.deleted.push(pathName);
  }
  flush();
  return requests;
}

/**
 * The git facts of a clone read from its files: the git directory (a worktree's .git file points at it), the branch of
 * HEAD (null when detached) and the origin URL. Null when dir is not a clone.
 */
export function gitFacts(dir) {
  let gitDir = path.join(dir, '.git');
  let commonDir = gitDir;
  try {
    if (fs.statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'))?.[1]?.trim();
      if (!pointer) return null;
      gitDir = path.resolve(dir, pointer);
      const common = path.join(gitDir, 'commondir');
      commonDir = fs.existsSync(common) ? path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim()) : gitDir;
    }
  } catch {
    return null;
  }
  let head;
  let config;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    config = fs.readFileSync(path.join(commonDir, 'config'), 'utf8');
  } catch {
    return null;
  }
  const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
  let inOrigin = false;
  let remote = null;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[(.+)\]\s*$/.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/.test(section[1].trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line) : null;
    if (url && remote === null) remote = url[1];
  }
  return { gitDir, branch, remote };
}

/** One POST with Node's fetch. Resolves {ok, status, body}; never throws. */
async function post(url, payload) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gsdc-protocol': PROTOCOL },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, body: await res.text() };
  } catch (error) {
    return { ok: false, status: 0, body: error?.cause?.code ?? error?.message ?? 'no answer' };
  }
}

function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && typeof state === 'object' && state.held && typeof state.held === 'object' ? state : null;
  } catch {
    return null;
  }
}

/** Writes the state through a temporary file and a rename, so a run that is stopped never leaves half a file. */
function writeState(file, state) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
}

/** Takes the per-clone lock, or returns null when another run holds it. The lock carries a nonce, so a run removes only its own. */
function takeLock(lock) {
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
  } catch {}
  const nonce = crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(lock, nonce, { flag: 'wx' });
  } catch {
    return null;
  }
  return () => {
    try {
      if (fs.readFileSync(lock, 'utf8') === nonce) fs.rmSync(lock, { force: true });
    } catch {}
  };
}

/**
 * Runs once; returns the exit code (0 done or nothing to do, 1 a push failed or the hook is set up wrong). `event` is the
 * hook_event_name of the hook input: 'Stop' waits for the lock and ignores the backoff.
 */
export async function run({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  send = post,
  now = Date.now,
  event = null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const final = event === 'Stop';
  if (env.CLAUDE_CODE_REMOTE !== 'true') return 0;
  const started = now();
  let origin;
  try {
    const url = new URL(argv[0] ?? '');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error();
    origin = url.origin;
  } catch {
    say('usage: node .claude/hooks/gsd-console-mirror.mjs <https console origin>; nothing was sent');
    return 1;
  }
  const dir = env.CLAUDE_PROJECT_DIR || cwd;
  const facts = gitFacts(dir);
  if (!facts) return 0;
  const { gitDir } = facts;
  const project = slugFromRemote(facts.remote ?? '');
  if (!project) {
    say('the remote origin does not name an owner/name repository; nothing was sent');
    return 1;
  }
  const ref = facts.branch;
  if (!ref) return 0; // a detached HEAD has no branch to mirror

  // One run at a time per clone: a run that finds the lock leaves the work to the holder and to the next run.
  const lockFile = path.join(gitDir, `${STATE_NAME}.lock`);
  let release = takeLock(lockFile);
  while (!release && final && now() - started < LOCK_WAIT_MS) {
    await sleep(LOCK_POLL_MS);
    release = takeLock(lockFile);
  }
  if (!release) {
    if (final) say('another run still holds the lock; the last changes go with the next run');
    return final ? 1 : 0;
  }
  try {
    const stateFile = path.join(gitDir, STATE_NAME);
    const saved = readState(stateFile);
    if (!final && saved && typeof saved.retry_after === 'number' && saved.retry_after > now()) return 0;
    const same = saved && saved.project === project && saved.ref === ref && saved.origin === origin;
    let files;
    try {
      files = scanPlanning(dir);
    } catch (error) {
      say(`${error.message}; nothing was sent`);
      return 1;
    }
    const keep = (held, extra = {}) => writeState(stateFile, { origin, project, ref, held, ...extra });
    // held null: the manifest failed, so the next run sends it again (the state names no checkout).
    const refused = (answer, held) => {
      const retry = { retry_after: now() + BACKOFF_MS };
      if (held === null) writeState(stateFile, { held: {}, ...retry });
      else keep(held, retry);
      say(
        `the console refused or did not answer (${answer.status || 'no answer'}): ${String(answer.body).slice(0, 300)}. The files stay as written; a run after a minute sends them again.`,
      );
      return 1;
    };

    let held = same ? saved.held : null;
    if (held === null) {
      // A clone, branch, project or origin this state does not know: the manifest says what the console lacks.
      const entries = [...files.values()].map(({ path: filePath, sha256, size }) => ({ path: filePath, sha256, size }));
      const answer = await send(`${origin}/api/mirror/manifest`, { project, ref, entries });
      let need = null;
      try {
        need = answer.ok ? JSON.parse(answer.body).need : null;
      } catch {}
      if (!Array.isArray(need)) return refused(answer, null);
      const lacking = new Set(need);
      held = {};
      for (const file of files.values()) if (!lacking.has(file.path)) held[file.path] = file.sha256;
      keep(held);
    }

    const next = { ...held };
    for (const request of plan(held, files)) {
      if (now() - started > (final ? RUN_BUDGET_MS : BACKGROUND_BUDGET_MS)) break; // the rest goes with the next run
      const answer = await send(`${origin}/api/mirror/ingest`, {
        project,
        ref,
        files: request.files,
        ...(request.deleted.length > 0 ? { deleted: request.deleted } : {}),
      });
      if (!answer.ok) return refused(answer, next);
      for (const file of request.files) next[file.path] = file.sha256;
      for (const pathName of request.deleted) delete next[pathName];
      keep(next);
    }
    return 0;
  } finally {
    release();
  }
}

/** The hook_event_name of a hook input, or null (input that is not JSON or names no event). */
export function eventOf(text) {
  try {
    const input = JSON.parse(text);
    return typeof input?.hook_event_name === 'string' ? input.hook_event_name : null;
  } catch {
    return null;
  }
}

/** The hook input on stdin; empty when run by hand at a terminal. */
function readInput() {
  if (process.stdin.isTTY) return '';
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('gsd-console-mirror.mjs')) {
  // The state of .planning/ itself is compared with what the console holds; of the hook input only the event is read.
  process.exitCode = await run({ event: eventOf(readInput()) });
}
