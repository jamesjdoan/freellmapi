import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Candidate code is untrusted. It runs in python3 isolated mode (-I: no user
// site, no env-driven paths; -B: no bytecode written), from a throwaway
// directory, with a wall-clock timeout and CPU/file-size limits set before the
// candidate is imported. On macOS sandbox-exec additionally denies all network
// access and every file write outside that directory. Where no OS sandbox is
// available the code is NOT run and the check reads INCONCLUSIVE.

export interface SandboxResult {
  ran: boolean;
  /** Why it did not run, or why it failed to finish. */
  reason?: string;
  /** Per-case outcomes printed by the hidden test runner. */
  cases: { name: string; ok: boolean; detail?: string }[];
}

const TIMEOUT_MS = 8_000;

function python(): string | null {
  for (const p of ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']) if (existsSync(p)) return p;
  return null;
}

export function sandboxAvailable(): boolean {
  if (!python()) return false;
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec');
  if (process.platform === 'linux') return spawnSync('unshare', ['-rn', 'true']).status === 0;
  return false;
}

function profile(dir: string): string {
  // Allow everything python needs to start, then deny the network outright and
  // any write outside the work directory.
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${dir}") (literal "/dev/null"))`,
  ].join('');
}

/**
 * Run `candidate` as module `candidate`, then `runner`, which must print one
 * JSON line per case: {"name": ..., "ok": bool, "detail": ...}.
 */
export function runPython(candidate: string, runner: string): SandboxResult {
  const py = python();
  if (!py || !sandboxAvailable()) return { ran: false, reason: 'no OS sandbox available', cases: [] };
  const dir = mkdtempSync(path.join(tmpdir(), 'fla-bench-'));
  try {
    writeFileSync(path.join(dir, 'candidate.py'), candidate);
    writeFileSync(path.join(dir, 'runner.py'), [
      'import resource, sys, json',
      'resource.setrlimit(resource.RLIMIT_CPU, (4, 4))',
      'resource.setrlimit(resource.RLIMIT_FSIZE, (1 << 20, 1 << 20))',
      `sys.path.insert(0, ${JSON.stringify(dir)})`,
      'try:',
      '    import candidate',
      'except BaseException as e:',
      '    print(json.dumps({"name": "import", "ok": False, "detail": type(e).__name__ + ": " + str(e)[:200]}))',
      '    sys.exit(0)',
      runner,
    ].join('\n'));
    const args = ['-I', '-B', path.join(dir, 'runner.py')];
    const [cmd, argv] = process.platform === 'darwin'
      ? ['/usr/bin/sandbox-exec', ['-p', profile(dir), py, ...args]]
      : ['unshare', ['-rn', py, ...args]];
    const res = spawnSync(cmd, argv, { cwd: dir, timeout: TIMEOUT_MS, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    if (res.error) return { ran: false, reason: `sandbox failed: ${res.error.message}`, cases: [] };
    const cases = (res.stdout ?? '').split('\n').filter(l => l.startsWith('{')).flatMap(l => {
      try {
        const c = JSON.parse(l) as { name?: unknown; ok?: unknown; detail?: unknown };
        return typeof c.name === 'string' ? [{ name: c.name, ok: c.ok === true, detail: typeof c.detail === 'string' ? c.detail : undefined }] : [];
      } catch { return []; }
    });
    if (res.signal) return { ran: true, reason: `killed by ${res.signal} (timeout or CPU limit)`, cases };
    return { ran: true, cases };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
