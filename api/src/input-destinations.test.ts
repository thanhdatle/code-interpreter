import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import * as fsp from 'fs/promises';
import * as crypto from 'crypto';
import * as path from 'path';
import * as os from 'os';
import * as semver from 'semver';
import {
  Job,
  disambiguateDestination,
  isSameStorageObject,
  type TFile,
} from './job';
import type { Runtime } from './runtime';
import { config } from './config';
import { SessionWorkspace } from './session-workspace';
import { inputCacheKey } from './session-inputs';
import { fallbackSandboxIdentity } from './workspace-isolation';

/**
 * Regression tests for input-destination collisions during `prime()`.
 *
 * A collision used to throw `Conflicting input destinations`, which failed
 * the whole execution. Because the caller replays the same attachment set on
 * every turn of a conversation, one collision killed every subsequent
 * execution permanently. The shape that produced it in the field: an upload
 * route stored a filename as doubly-encoded mojibake, so the session held one
 * storage object under two names, and both were sent on the next call. Their
 * requested names differed, so nothing caught it until both downloads
 * resolved the same `Content-Disposition` name.
 *
 * The policy is now: same storage object at one destination is a duplicate to
 * drop, different objects at one destination are disambiguated, and neither
 * aborts the job.
 */

/** The correctly-encoded name LibreChat uploads with. */
const UTF8_NAME = 'Báo_cáo_kết_quả.docx';
/** What the pre-fix upload route stored: the same bytes read as Latin-1. */
const MOJIBAKE_NAME = 'BÃ¡o_cÃ¡o_káº¿t_quáº£.docx';

interface JobInternals {
  submissionDir: string;
  files: TFile[];
  inputDestinations: Map<string, TFile>;
  droppedInputRefs: Set<TFile>;
  inputFileHashes: Map<string, { originalId?: string; originalSessionId?: string; hash: string }>;
}

function asInternals(job: Job): JobInternals {
  return job as unknown as JobInternals;
}

/**
 * `Job` copies the request files into its own array, so the destinations the
 * `/exec` response reports are the names on those copies — not on the objects
 * the caller handed in.
 */
function primedNames(job: Job): string[] {
  return asInternals(job).files.map(file => file.name);
}

function droppedNames(job: Job): string[] {
  const { files, droppedInputRefs } = asInternals(job);
  return files.filter(file => droppedInputRefs.has(file)).map(file => file.name);
}

function makeRuntime(): Runtime {
  return {
    language: 'python',
    version: new semver.SemVer('3.11.0'),
    aliases: [],
    pkgdir: '/tmp',
    compiled: false,
    env_vars: {},
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    max_process_count: 100,
    max_open_files: 100,
    max_file_size: 10_000_000,
    output_max_size: 1_000_000,
  };
}

/**
 * A real `SessionWorkspace` with only the workspace lease stubbed — acquiring
 * a genuine one needs a UID slot and a privileged on-disk workspace. All the
 * priming/surfacing bookkeeping the reuse path depends on is the real thing,
 * so these tests exercise `primedInputId`, `primedHash` and `markPrimed`
 * rather than a hand-written approximation of them.
 */
function sessionWorkspaceAt(dir: string, runtimeSessionId: string): SessionWorkspace {
  const session = new SessionWorkspace({ runtimeSessionId });
  const identity = fallbackSandboxIdentity();
  session.acquire = async () => ({ workspaceId: runtimeSessionId, dir, identity });
  return session;
}

function makeJob(files: TFile[], session: SessionWorkspace): Job {
  return new Job({
    session_id: 'test-session',
    runtime: makeRuntime(),
    files,
    args: [],
    stdin: '',
    timeouts: { compile: 5000, run: 5000 },
    cpu_times: { compile: 5000, run: 5000 },
    memory_limits: { compile: 100_000_000, run: 100_000_000 },
    session,
  });
}

type Route = {
  status: number;
  contentDisposition?: string;
  body?: string;
  delayMs?: number;
  onRequest?: () => void;
};

let server: ReturnType<typeof Bun.serve>;
let serverPort = 0;
const routes = new Map<string, Route>();
let originalFileServerUrl: string;
let originalPerJobUids: boolean;

function objectPath(file: TFile): string {
  return `/sessions/${encodeURIComponent(file.storage_session_id!)}/objects/${encodeURIComponent(file.id!)}`;
}

function utf8Disposition(name: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

beforeAll(() => {
  originalFileServerUrl = config.file_server_url;
  originalPerJobUids = config.per_job_uids;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const route = routes.get(new URL(req.url).pathname);
      if (!route) return new Response('not found', { status: 404 });
      route.onRequest?.();
      if (route.delayMs) await new Promise(resolve => setTimeout(resolve, route.delayMs));
      const headers = new Headers();
      if (route.contentDisposition) headers.set('content-disposition', route.contentDisposition);
      return new Response(route.body ?? '', { status: route.status, headers });
    },
  });
  serverPort = server.port ?? 0;
  (config as { file_server_url: string }).file_server_url = `http://127.0.0.1:${serverPort}`;
  (config as { per_job_uids: boolean }).per_job_uids = false;
});

afterAll(() => {
  (config as { file_server_url: string }).file_server_url = originalFileServerUrl;
  (config as { per_job_uids: boolean }).per_job_uids = originalPerJobUids;
  server.stop(true);
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codeapi-destinations-'));
  routes.clear();
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

async function entriesOf(dir: string): Promise<string[]> {
  const names = await fsp.readdir(dir);
  return names.filter(name => !name.startsWith('.tmp-')).sort();
}

describe('duplicate input destinations', () => {
  it('drops a duplicate ref instead of aborting when one object resolves to one name twice', async () => {
    /* The reported shape: one storage object held in the session under both
     * the correct name and its mojibake twin. Both refs download the same
     * object, whose Content-Disposition resolves to a single destination. */
    const shared = { id: 'dup-object-id', storage_session_id: 'prev-session' };
    const correct: TFile = { ...shared, name: UTF8_NAME };
    const corrupted: TFile = { ...shared, name: MOJIBAKE_NAME };
    let requests = 0;
    routes.set(objectPath(correct), {
      status: 200,
      contentDisposition: utf8Disposition(MOJIBAKE_NAME),
      body: 'report bytes',
      onRequest: () => { requests += 1; },
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_same_object_twice');
    const job = makeJob([correct, corrupted], session);
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    try {
      await job.prime();

      /* Written once, and the job survived — that is the whole point. */
      expect(session.dirtyReason).toBeUndefined();
      expect(await entriesOf(tmpDir)).toEqual([MOJIBAKE_NAME]);
      expect(await fsp.readFile(path.join(tmpDir, MOJIBAKE_NAME), 'utf8')).toBe('report bytes');
      /* Both refs were fetched, because only the response header reveals that
       * they collide — but the duplicate's body is cancelled rather than
       * streamed to disk, so the object is written exactly once. */
      expect(requests).toBe(2);

      expect([...asInternals(job).inputDestinations.keys()]).toEqual([MOJIBAKE_NAME]);
      expect(droppedNames(job)).toEqual([MOJIBAKE_NAME]);
      /* The /exec response must name the real path for both entries. */
      expect(primedNames(job)).toEqual([MOJIBAKE_NAME, MOJIBAKE_NAME]);
    } finally {
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  });

  it('drops a same-name duplicate before it is ever downloaded', async () => {
    const shared = { id: 'attached-twice-id', storage_session_id: 'prev-session' };
    const first: TFile = { ...shared, name: 'data.csv' };
    const second: TFile = { ...shared, name: 'data.csv' };
    let requests = 0;
    routes.set(objectPath(first), {
      status: 200,
      contentDisposition: 'attachment; filename="data.csv"',
      body: 'a,b\n1,2\n',
      onRequest: () => { requests += 1; },
    });

    const job = makeJob([first, second], sessionWorkspaceAt(tmpDir, 'rt_same_name_twice'));
    try {
      await job.prime();

      expect(await entriesOf(tmpDir)).toEqual(['data.csv']);
      /* The requested names already collide, so the duplicate never reaches
       * the network at all. */
      expect(requests).toBe(1);
      expect(droppedNames(job)).toEqual(['data.csv']);
    } finally {
      await job.cleanup();
    }
  });

  it('keeps one object requested at two independent destinations', async () => {
    /* Deliberate fan-out must keep working: same object, two paths the
     * caller actually asked for. */
    const shared = { id: 'fanned-out-id', storage_session_id: 'prev-session' };
    const here: TFile = { ...shared, name: 'a.csv' };
    const there: TFile = { ...shared, name: 'copy/a.csv' };
    routes.set(objectPath(here), { status: 200, body: 'shared bytes' });

    const job = makeJob([here, there], sessionWorkspaceAt(tmpDir, 'rt_fan_out'));
    try {
      await job.prime();

      expect(await fsp.readFile(path.join(tmpDir, 'a.csv'), 'utf8')).toBe('shared bytes');
      expect(await fsp.readFile(path.join(tmpDir, 'copy', 'a.csv'), 'utf8')).toBe('shared bytes');
      expect(droppedNames(job)).toEqual([]);
    } finally {
      await job.cleanup();
    }
  });
});

describe('conflicting input destinations between different objects', () => {
  it('disambiguates two different objects that resolve to the same name', async () => {
    const slower: TFile = { id: 'slower-id', storage_session_id: 'prev-session', name: 'slower-fallback.docx' };
    const faster: TFile = { id: 'faster-id', storage_session_id: 'prev-session', name: 'faster-fallback.docx' };
    routes.set(objectPath(slower), {
      status: 200,
      contentDisposition: utf8Disposition(UTF8_NAME),
      body: 'slower bytes',
      delayMs: 75,
    });
    routes.set(objectPath(faster), {
      status: 200,
      contentDisposition: utf8Disposition(UTF8_NAME),
      body: 'faster bytes',
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_different_objects_same_name');
    const job = makeJob([slower, faster], session);
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    try {
      await job.prime();

      expect(session.dirtyReason).toBeUndefined();
      /* Both survive: neither object is silently lost, and neither name
       * shadows the other. */
      expect(await entriesOf(tmpDir)).toEqual(
        ['Báo_cáo_kết_quả (2).docx', UTF8_NAME].sort(),
      );
      const written = await Promise.all(
        (await entriesOf(tmpDir)).map(name => fsp.readFile(path.join(tmpDir, name), 'utf8')),
      );
      expect(written.sort()).toEqual(['faster bytes', 'slower bytes']);

      /* Every ref reports the path its bytes actually landed at. */
      expect(primedNames(job).sort()).toEqual(['Báo_cáo_kết_quả (2).docx', UTF8_NAME].sort());
      expect(droppedNames(job)).toEqual([]);
    } finally {
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  });

  it('disambiguates a downloaded ref that lands on an inline file destination', async () => {
    const inline: TFile = { name: 'notes.txt', content: 'inline bytes' };
    const downloaded: TFile = { id: 'collides-id', storage_session_id: 'prev-session', name: 'placeholder.txt' };
    routes.set(objectPath(downloaded), {
      status: 200,
      contentDisposition: 'attachment; filename="notes.txt"',
      body: 'downloaded bytes',
    });

    const job = makeJob([inline, downloaded], sessionWorkspaceAt(tmpDir, 'rt_inline_collision'));
    try {
      await job.prime();

      expect(await fsp.readFile(path.join(tmpDir, 'notes.txt'), 'utf8')).toBe('inline bytes');
      expect(await fsp.readFile(path.join(tmpDir, 'notes (2).txt'), 'utf8')).toBe('downloaded bytes');
      expect(primedNames(job)).toEqual(['notes.txt', 'notes (2).txt']);
    } finally {
      await job.cleanup();
    }
  });

  it('disambiguates two inline files requested at the same destination', async () => {
    const first: TFile = { name: 'main.py', content: 'print(1)' };
    const second: TFile = { name: 'main.py', content: 'print(2)' };

    const job = makeJob([first, second], sessionWorkspaceAt(tmpDir, 'rt_inline_duplicate'));
    try {
      await job.prime();

      /* The first file keeps its name so the entry point is never renamed
       * out from under the runtime. */
      expect(primedNames(job)).toEqual(['main.py', 'main (2).py']);
      expect(await fsp.readFile(path.join(tmpDir, 'main.py'), 'utf8')).toBe('print(1)');
      expect(await fsp.readFile(path.join(tmpDir, 'main (2).py'), 'utf8')).toBe('print(2)');
    } finally {
      await job.cleanup();
    }
  });

  /* Now reachable end-to-end: `validateExecuteFiles` no longer 400s a
   * request whose destinations nest. A file reserved at `results` blocks
   * everything under `results/`, so the nested file has to move its ancestor
   * component or the search would exhaust and abort the job. */
  it('relocates a nested inline file blocked by a file at its ancestor path', async () => {
    const blocker: TFile = { name: 'results', content: 'a file, not a directory' };
    const nested: TFile = { name: 'results/out.csv', content: 'nested rows' };

    const job = makeJob([blocker, nested], sessionWorkspaceAt(tmpDir, 'rt_ancestor_blocked'));
    try {
      await job.prime();

      expect(primedNames(job)).toEqual(['results', 'results (2)/out.csv']);
      expect(await fsp.readFile(path.join(tmpDir, 'results'), 'utf8'))
        .toBe('a file, not a directory');
      expect(await fsp.readFile(path.join(tmpDir, 'results (2)', 'out.csv'), 'utf8'))
        .toBe('nested rows');
    } finally {
      await job.cleanup();
    }
  });

  it('disambiguates a ref nested under a destination another object owns', async () => {
    const dir: TFile = { name: 'results/out.csv', content: 'nested' };
    const shadow: TFile = { id: 'shadow-id', storage_session_id: 'prev-session', name: 'placeholder' };
    routes.set(objectPath(shadow), {
      status: 200,
      contentDisposition: 'attachment; filename="results"',
      body: 'would shadow the directory',
    });

    const job = makeJob([dir, shadow], sessionWorkspaceAt(tmpDir, 'rt_ancestor_collision'));
    try {
      await job.prime();

      expect(await fsp.readFile(path.join(tmpDir, 'results', 'out.csv'), 'utf8')).toBe('nested');
      expect(primedNames(job)).toEqual(['results/out.csv', 'results (2)']);
      expect(await fsp.readFile(path.join(tmpDir, 'results (2)'), 'utf8'))
        .toBe('would shadow the directory');
    } finally {
      await job.cleanup();
    }
  });
});

describe('disambiguateDestination', () => {
  /* Only ever called once a conflict is established, so it always invents a
   * variant — the caller decides whether disambiguation is needed at all.
   * That split matters: `isTaken` here is stricter than the conflict test,
   * and applying it to the original destination would rename files that were
   * merely primed on an earlier turn. */
  it('always returns a variant, never the original destination', () => {
    expect(disambiguateDestination('report.docx', 'report.docx', () => false)).toBe('report (2).docx');
  });

  it('trims an over-long stem to fit instead of failing the execution', () => {
    const max = config.max_path_length;
    const stem = 'n'.repeat(max - '.docx'.length);
    const atLimit = `${stem}.docx`;
    expect(atLimit.length).toBe(max);

    const resolved = disambiguateDestination(atLimit, atLimit, c => c === atLimit);
    expect(resolved.length).toBeLessThanOrEqual(max);
    expect(resolved.endsWith(' (2).docx')).toBe(true);
  });

  it('never leaves a lone surrogate half when trimming', () => {
    const max = config.max_path_length;
    /* Pad with astral characters so a naive slice lands mid-pair. */
    const stem = '😀'.repeat(Math.floor((max - '.txt'.length) / 2));
    const atLimit = `${stem}.txt`;
    const resolved = disambiguateDestination(atLimit, atLimit, c => c === atLimit);
    expect(resolved.length).toBeLessThanOrEqual(max);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(resolved)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(resolved)).toBe(false);
  });

  it('inserts the suffix before the extension', () => {
    const taken = new Set(['report.docx']);
    expect(disambiguateDestination('report.docx', 'report.docx', c => taken.has(c)))
      .toBe('report (2).docx');
  });

  it('counts upward past every taken variant', () => {
    const taken = new Set(['a.txt', 'a (2).txt', 'a (3).txt']);
    expect(disambiguateDestination('a.txt', 'a.txt', c => taken.has(c))).toBe('a (4).txt');
  });

  it('keeps the directory and handles extensionless and dotfile names', () => {
    const taken = new Set(['dir/sub/report.tar.gz', 'README', '.gitignore']);
    const isTaken = (c: string): boolean => taken.has(c);
    expect(disambiguateDestination('dir/sub/report.tar.gz', 'dir/sub/report.tar.gz', isTaken))
      .toBe('dir/sub/report.tar (2).gz');
    expect(disambiguateDestination('README', 'README', isTaken)).toBe('README (2)');
    /* A leading dot is part of the name, not an extension separator. */
    expect(disambiguateDestination('.gitignore', '.gitignore', isTaken)).toBe('.gitignore (2)');
  });

  /**
   * A reserved FILE at an ancestor path blocks the whole subtree under it.
   * Suffixing the basename would produce candidates that are still nested
   * under the blocker, so every one collides and the search would exhaust
   * and throw — reviving the abort this change exists to remove.
   */
  it('moves the blocking ancestor component, not the basename', () => {
    const taken = new Set(['results']);
    const isTaken = (c: string): boolean =>
      [...taken].some(t => t === c || c.startsWith(`${t}/`) || t.startsWith(`${c}/`));
    expect(disambiguateDestination('results/out.csv', 'results', isTaken))
      .toBe('results (2)/out.csv');
    expect(disambiguateDestination('results/deep/nested.csv', 'results', isTaken))
      .toBe('results (2)/deep/nested.csv');
  });

  it('suffixes the basename when the reserved path is nested under it', () => {
    const taken = new Set(['results/out.csv']);
    const isTaken = (c: string): boolean =>
      [...taken].some(t => t === c || c.startsWith(`${t}/`) || t.startsWith(`${c}/`));
    expect(disambiguateDestination('results', 'results/out.csv', isTaken)).toBe('results (2)');
  });

  it('throws only when no valid variant exists at all', () => {
    expect(() => disambiguateDestination('a.txt', 'a.txt', () => true))
      .toThrow(/Unable to find a free destination/);
  });
});

describe('isSameStorageObject', () => {
  it('matches only on an identical id and storage session', () => {
    const base: TFile = { id: 'x', storage_session_id: 's', name: 'a' };
    expect(isSameStorageObject(base, { ...base, name: 'b' })).toBe(true);
    expect(isSameStorageObject(base, { ...base, id: 'y' })).toBe(false);
    expect(isSameStorageObject(base, { ...base, storage_session_id: 't' })).toBe(false);
  });

  it('never treats inline files as the same object', () => {
    /* Inline files get `storage_session_id` backfilled from the execution
     * id, so without the id check two unrelated inline files would look
     * identical and one would be silently dropped. */
    const a: TFile = { name: 'a.txt', content: 'a', storage_session_id: 'exec-1' };
    const b: TFile = { name: 'b.txt', content: 'b', storage_session_id: 'exec-1' };
    expect(isSameStorageObject(a, b)).toBe(false);
    expect(isSameStorageObject(a, a)).toBe(false);
  });
});

/**
 * The reuse branch of `primeInputFile` skips the network when a prior turn
 * already primed the same object at the same path. It has three outcomes
 * beyond a plain miss — reused, duplicate, contested — and all of them now
 * turn on a destination reservation, so each needs its own coverage.
 */
describe('reuse of a prior turn\'s primed input', () => {
  const PRIOR_BYTES = 'primed last turn';

  async function seedPrimedInput(
    session: SessionWorkspace,
    name: string,
    file: TFile,
    bytes: string,
    hash?: string,
  ): Promise<void> {
    await fsp.writeFile(path.join(tmpDir, name), bytes);
    session.markPrimed(name, inputCacheKey(file.storage_session_id!, file.id!), false, hash);
  }

  function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  it('reuses the on-disk copy without re-downloading it', async () => {
    const file: TFile = { id: 'primed-id', storage_session_id: 'prev-session', name: 'kept.csv' };
    let requests = 0;
    routes.set(objectPath(file), {
      status: 200,
      body: 'should never be fetched',
      onRequest: () => { requests += 1; },
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_reuse_hit');
    await seedPrimedInput(session, 'kept.csv', file, PRIOR_BYTES, sha256(PRIOR_BYTES));

    const job = makeJob([file], session);
    try {
      await job.prime();

      expect(requests).toBe(0);
      expect(await fsp.readFile(path.join(tmpDir, 'kept.csv'), 'utf8')).toBe(PRIOR_BYTES);
      /* The reused copy must be committed, or the walker treats it as a
       * primed-but-not-re-sent file and drops it from the response. */
      expect(asInternals(job).inputFileHashes.get('kept.csv')).toMatchObject({
        originalId: 'primed-id',
        originalSessionId: 'prev-session',
        hash: sha256(PRIOR_BYTES),
      });
    } finally {
      await job.cleanup();
    }
  });

  it('drops a reuse whose destination an identical object already claimed', async () => {
    /* Same object, two refs: one requested under a stale name that the
     * download resolves onto the primed path, one requested at the primed
     * path itself. Sequential priming makes the download claim it first, so
     * the reuse hits the duplicate outcome. */
    const shared = { id: 'dup-primed-id', storage_session_id: 'prev-session' };
    const viaDownload: TFile = { ...shared, name: 'stale-name.csv' };
    const viaReuse: TFile = { ...shared, name: 'primed.csv' };
    let requests = 0;
    routes.set(objectPath(viaDownload), {
      status: 200,
      contentDisposition: 'attachment; filename="primed.csv"',
      body: 'fresh bytes',
      onRequest: () => { requests += 1; },
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_reuse_duplicate');
    await seedPrimedInput(session, 'primed.csv', viaReuse, PRIOR_BYTES, sha256(PRIOR_BYTES));

    const job = makeJob([viaDownload, viaReuse], session);
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 1;
    try {
      await job.prime();

      expect(session.dirtyReason).toBeUndefined();
      expect(await entriesOf(tmpDir)).toEqual(['primed.csv']);
      expect(await fsp.readFile(path.join(tmpDir, 'primed.csv'), 'utf8')).toBe('fresh bytes');
      expect(requests).toBe(1);
      expect(droppedNames(job)).toEqual(['primed.csv']);
      /* The surviving ref owns the entry, and it describes the bytes that
       * are actually on disk. */
      expect(asInternals(job).inputFileHashes.get('primed.csv')).toMatchObject({
        originalId: 'dup-primed-id',
        hash: sha256('fresh bytes'),
      });
    } finally {
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  });

  it('re-downloads a contested reuse to a destination of its own', async () => {
    /* A DIFFERENT object resolves onto the primed path. `lstat` only proves
     * the path exists, so the reuse check still passes — but the bytes there
     * now belong to the other object, so the reused ref must not keep them. */
    const intruder: TFile = { id: 'intruder-id', storage_session_id: 'prev-session', name: 'intruder-fallback.csv' };
    const primed: TFile = { id: 'primed-id', storage_session_id: 'prev-session', name: 'primed.csv' };
    routes.set(objectPath(intruder), {
      status: 200,
      contentDisposition: 'attachment; filename="primed.csv"',
      body: 'intruder bytes',
    });
    routes.set(objectPath(primed), {
      status: 200,
      contentDisposition: 'attachment; filename="primed.csv"',
      body: 'primed object bytes',
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_reuse_contested');
    await seedPrimedInput(session, 'primed.csv', primed, PRIOR_BYTES, sha256(PRIOR_BYTES));

    const job = makeJob([intruder, primed], session);
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 1;
    try {
      await job.prime();

      expect(session.dirtyReason).toBeUndefined();
      expect(await fsp.readFile(path.join(tmpDir, 'primed.csv'), 'utf8')).toBe('intruder bytes');
      /* Re-downloaded rather than silently reusing the intruder's bytes. */
      expect(await fsp.readFile(path.join(tmpDir, 'primed (2).csv'), 'utf8')).toBe('primed object bytes');
      expect(primedNames(job)).toEqual(['primed.csv', 'primed (2).csv']);
      expect(droppedNames(job)).toEqual([]);

      const hashes = asInternals(job).inputFileHashes;
      expect(hashes.get('primed.csv')).toMatchObject({ originalId: 'intruder-id' });
      expect(hashes.get('primed (2).csv')).toMatchObject({ originalId: 'primed-id' });
    } finally {
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  });

  it('never lets a contested reuse clobber or delete the owner\'s hash entry', async () => {
    /* The regression this guards: the reuse path used to commit
     * `inputFileHashes[name]` BEFORE reserving, then unwind with a
     * name-keyed delete that had no ownership test. Interleaved with a
     * different object writing the same path, that left the owner's bytes on
     * disk with no entry, and the walker silently dropped them from the
     * response.
     *
     * The window is widened deliberately: no primed hash is recorded, so the
     * reuse falls back to hashing a multi-megabyte file while the competing
     * download completes. The assertion is the interleaving-independent
     * invariant — every ref's committed entry describes that ref. */
    const large = 'x'.repeat(2 * 1024 * 1024);
    const intruder: TFile = { id: 'race-intruder-id', storage_session_id: 'prev-session', name: 'race-fallback.bin' };
    const primed: TFile = { id: 'race-primed-id', storage_session_id: 'prev-session', name: 'race.bin' };
    routes.set(objectPath(intruder), {
      status: 200,
      contentDisposition: 'attachment; filename="race.bin"',
      body: 'intruder bytes',
      delayMs: 5,
    });
    routes.set(objectPath(primed), {
      status: 200,
      contentDisposition: 'attachment; filename="race.bin"',
      body: 'primed object bytes',
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_reuse_race');
    /* No hash argument: forces the computeFileHash fallback. */
    await seedPrimedInput(session, 'race.bin', primed, large);

    const job = makeJob([intruder, primed], session);
    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 2;
    try {
      await job.prime();

      expect(session.dirtyReason).toBeUndefined();
      const names = primedNames(job);
      expect(new Set(names).size).toBe(2);
      expect(droppedNames(job)).toEqual([]);

      const hashes = asInternals(job).inputFileHashes;
      for (const file of asInternals(job).files) {
        const entry = hashes.get(file.name);
        /* No ref may be left without an entry, and no ref may be described
         * by another ref's entry. */
        expect(entry).toBeDefined();
        expect(entry?.originalId).toBe(file.id);
        await fsp.stat(path.join(tmpDir, file.name));
      }
    } finally {
      config.prime_concurrency = originalConcurrency;
      await job.cleanup();
    }
  }, 30_000);
});

/**
 * The caller replays the same attachment set on every turn of a conversation,
 * so a contested pair is re-disambiguated from scratch each time. The invented
 * name must therefore be STABLE across turns: if a file's own copy from the
 * previous turn counted as an occupied destination, the pair would migrate one
 * suffix per turn, strand an abandoned copy on disk each time, and after
 * `MAX_DESTINATION_SUFFIX` turns exhaust the search and throw — the
 * permanent-kill pathology this change removes, arriving slowly instead of
 * immediately.
 */
describe('replaying a contested pair across turns', () => {
  it('settles on a stable destination instead of climbing the suffix each turn', async () => {
    const intruder: TFile = { id: 'stable-intruder-id', storage_session_id: 'prev-session', name: 'intruder-fallback.csv' };
    const primed: TFile = { id: 'stable-primed-id', storage_session_id: 'prev-session', name: 'primed.csv' };
    routes.set(objectPath(intruder), {
      status: 200,
      contentDisposition: 'attachment; filename="primed.csv"',
      body: 'intruder bytes',
    });
    routes.set(objectPath(primed), {
      status: 200,
      contentDisposition: 'attachment; filename="primed.csv"',
      body: 'primed object bytes',
    });

    const session = sessionWorkspaceAt(tmpDir, 'rt_contested_replay');
    await fsp.writeFile(path.join(tmpDir, 'primed.csv'), 'primed last turn');
    session.markPrimed(
      'primed.csv',
      inputCacheKey(primed.storage_session_id!, primed.id!),
      false,
      crypto.createHash('sha256').update('primed last turn').digest('hex'),
    );

    const originalConcurrency = config.prime_concurrency;
    config.prime_concurrency = 1;
    const destinationsPerTurn: string[][] = [];
    try {
      for (let turn = 0; turn < 4; turn++) {
        const job = makeJob([intruder, primed], session);
        try {
          await job.prime();
          expect(session.dirtyReason).toBeUndefined();
          destinationsPerTurn.push(primedNames(job));
        } finally {
          await job.cleanup();
        }
      }

      /* Every turn resolves to the same two paths. */
      for (const destinations of destinationsPerTurn) {
        expect(destinations).toEqual(['primed.csv', 'primed (2).csv']);
      }
      /* And no abandoned copies accumulated on disk. */
      expect(await entriesOf(tmpDir)).toEqual(['primed (2).csv', 'primed.csv']);
      expect(await fsp.readFile(path.join(tmpDir, 'primed.csv'), 'utf8')).toBe('intruder bytes');
      expect(await fsp.readFile(path.join(tmpDir, 'primed (2).csv'), 'utf8')).toBe('primed object bytes');
    } finally {
      config.prime_concurrency = originalConcurrency;
    }
  }, 30_000);
});
