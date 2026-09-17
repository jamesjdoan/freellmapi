import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFile = promisify(execFileCallback);
const projectRoot = resolve(import.meta.dirname, '..');
const script = join(projectRoot, 'scripts', 'deploy.sh');

/**
 * The command this script replaced reported success on a failed deploy: it
 * ended with `docker compose up -d 2>&1 | tail -1 && ...`, so the exit status
 * came from `tail`. When `up` could not bind port 3001 the chain carried on and
 * printed "deployed <tag>" while the container sat in Created.
 *
 * These run the real script against a stub `docker` on PATH, so the failure
 * modes are exercised rather than reasoned about.
 */

/** A fake docker whose behaviour per subcommand comes from env vars. */
const STUB_DOCKER = `#!/usr/bin/env bash
STUB_COMPOSE_FILE_DEFAULT="\${STUB_DIR}/docker-compose.yml"
STUB_COMPOSE_WORKDIR_DEFAULT="\${STUB_DIR}"
case "$1" in
  build) exit \${STUB_BUILD_EXIT:-0} ;;
  tag)   exit 0 ;;
  run)   exit 0 ;;
  compose)
    # STUB_COMPOSE_FAIL_FIRST makes the first call fail and later ones succeed,
    # which is the transient port race.
    if [[ -n "\${STUB_COMPOSE_FAIL_FIRST:-}" ]]; then
      marker="\${TMPDIR:-/tmp}/stub-compose-called"
      if [[ ! -f "$marker" ]]; then touch "$marker"; exit 1; fi
      rm -f "$marker"; exit 0
    fi
    exit \${STUB_COMPOSE_EXIT:-0} ;;
  inspect)
    # 'docker inspect <name> --format ...' for container state, labels, mounts,
    # health, ports or image id. Order matters: .Image must be tested after the
    # label lookup, because the compose labels include one called
    # 'com.docker.compose.image'.
    if [[ "$*" == *"Config.Labels"* ]]; then
      case "$*" in
        *config_files*) echo "\${STUB_COMPOSE_FILE:-$STUB_COMPOSE_FILE_DEFAULT}" ;;
        *working_dir*)  echo "\${STUB_COMPOSE_WORKDIR:-$STUB_COMPOSE_WORKDIR_DEFAULT}" ;;
        *project*)      echo "\${STUB_COMPOSE_PROJECT:-freellmapi}" ;;
        *service*)      echo "\${STUB_COMPOSE_SERVICE:-freellmapi}" ;;
        *)              echo "" ;;
      esac
      exit 0
    fi
    if [[ "$*" == *".State.Status"* ]]; then echo "\${STUB_STATE:-running}"; exit 0; fi
    if [[ "$*" == *".State.Health"* ]]; then echo "\${STUB_HEALTH:-healthy}"; exit 0; fi
    if [[ "$*" == *".Mounts"* ]]; then echo "\${STUB_VOLUME:-freellmapi_freellmapi-data}"; exit 0; fi
    if [[ "$*" == *"NetworkSettings.Ports"* ]]; then echo "\${STUB_PORTS:-3001/tcp=1 }"; exit 0; fi
    if [[ "$*" == *".Image"* ]]; then echo "\${STUB_RUNNING_IMAGE:-sha256:same}"; exit 0; fi
    exit 0 ;;
  image)
    if [[ "$*" == *".Id"* ]]; then echo "\${STUB_BUILT_IMAGE:-sha256:same}"; exit 0; fi
    exit \${STUB_IMAGE_INSPECT_EXIT:-0} ;;
  *) exit 0 ;;
esac
`;

/** A fake curl returning a chosen HTTP code, or 000 for "no answer". */
const STUB_CURL = `#!/usr/bin/env bash
# Mimics real curl: -w writes the code even on failure, and the exit status is
# non-zero when it could not connect. The first version always exited 0, which
# is why it could not catch the '000' + '|| echo 000' concatenation.
code="\${STUB_HTTP:-401}"
echo -n "$code"
[[ "$code" == "000" ]] && exit 7
exit 0
`;

async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'freellmapi-deploy-'));
  const bin = join(dir, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'docker'), STUB_DOCKER);
  await writeFile(join(bin, 'curl'), STUB_CURL);
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'curl'), 0o755);
  // The script now refuses a compose file that does not exist, which is the
  // whole point of resolving it from the container instead of guessing.
  await writeFile(join(dir, 'docker-compose.yml'), 'services: {}\n');
  t.after(() => rm(dir, { force: true, recursive: true }));
  return { dir, bin };
}

async function runDeploy(bin, env = {}) {
  try {
    const { stdout } = await execFile('bash', [script, '--skip-backup'], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_DIR: bin.replace(/\/bin$/, ''),
        // The give-up path is what two of these test; waiting out the real
        // 90-second deadline to observe it would put three minutes of wall
        // clock into the suite.
        // These stub the whole world, so they run the code-only path; the
        // backup path has its own tests below.
        DEPLOY_I_ACCEPT_NO_BACKUP: '1',
        DEPLOY_WAIT_SECONDS: '1',
        DEPLOY_POLL_SECONDS: '0.1',
        DEPLOY_COMPOSE_ATTEMPTS: '2',
        DEPLOY_COMPOSE_BACKOFF: '0.1',
        ...env,
      },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Runs the real backup path: no --skip-backup, and backups land in a sandbox. */
async function runDeployWithBackup(bin, dir, env = {}) {
  try {
    const { stdout } = await execFile('bash', [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        STUB_DIR: dir,
        DEPLOY_WAIT_SECONDS: '1',
        DEPLOY_POLL_SECONDS: '0.1',
        DEPLOY_COMPOSE_ATTEMPTS: '2',
        DEPLOY_COMPOSE_BACKOFF: '0.1',
        ...env,
      },
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

test('reports success only when the container is running and answering', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin);
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /deployed jamesjdoan\/freellmapi:main-/);
  assert.match(result.stdout, /rollback:/);
});

test('fails when compose cannot start the container', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin, { STUB_COMPOSE_EXIT: '1' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /compose up failed after 2 attempts/);
  assert.doesNotMatch(result.stdout, /deployed/);
});

test('retries a compose failure that clears on its own', async (t) => {
  const { bin } = await sandbox(t);
  // `up -d` removes the old container and immediately rebinds the host port;
  // Docker does not always release it in time. Seen twice for real, with the
  // port free a second later.
  const result = await runDeploy(bin, { STUB_COMPOSE_FAIL_FIRST: '1' });
  assert.equal(result.ok, true, result.stderr);
  assert.match(result.stdout, /retrying/);
  assert.match(result.stdout, /deployed/);
});

test('fails when the container is created but never runs — the original bug', async (t) => {
  const { bin } = await sandbox(t);
  // Exactly what happened: compose "succeeded", the container sat in Created
  // because something else held port 3001.
  const result = await runDeploy(bin, { STUB_STATE: 'created', STUB_COMPOSE_EXIT: '0' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not running/);
  assert.match(result.stderr, /port 3001/);
  assert.doesNotMatch(result.stdout, /deployed/);
});

test('fails when the container runs but does not answer', async (t) => {
  const { bin } = await sandbox(t);
  // curl prints 000 and exits non-zero, exactly as the real one does. An
  // earlier version of this script appended its own '000' fallback, producing
  // '000000', which passed a `!= 000` guard and reported a dead container as
  // deployed on the first real run.
  const result = await runDeploy(bin, { STUB_HTTP: '000' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /did not answer/);
  assert.doesNotMatch(result.stdout, /deployed/);
});

test('does not concatenate curl output with a fallback', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin, { STUB_HTTP: '000' });
  // The tell was a six-digit "code" in the success line.
  assert.doesNotMatch(result.stdout + result.stderr, /000000/);
});

test('fails when the running image is not the one just built', async (t) => {
  const { bin } = await sandbox(t);
  // A stale container left up by an earlier deploy would otherwise be reported
  // as this deploy's success.
  const result = await runDeploy(bin, {
    STUB_RUNNING_IMAGE: 'sha256:stale', STUB_BUILT_IMAGE: 'sha256:fresh',
  });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /not the image just built/);
});

test('fails when the build fails', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin, { STUB_BUILD_EXIT: '1' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /image build failed/);
});

test('never pipes a command whose exit status it relies on', async () => {
  // The specific shape that caused this: a pipeline swallows the status of
  // everything but its last stage.
  const source = await readFile(script, 'utf8');
  const offenders = source
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .filter(line => /\bdocker (build|tag|run|compose|inspect)\b/.test(line))
    .filter(line => line.includes('|') && !line.includes('||'));
  assert.deepEqual(offenders, [], `piped docker calls hide failures:\n${offenders.join('\n')}`);
});

/**
 * The two corrections, tested rather than asserted in a comment.
 *
 * Both were found by reading this script against a live install: it pointed at
 * a nested clone's docker-compose.yml, and it tarred the data volume while the
 * service was still writing to it.
 */
test('backs up only after the service is stopped, never while it is writing', async (t) => {
  const { bin, dir } = await sandbox(t);
  const order = join(dir, 'order.log');
  // A docker stub that records the ORDER of the calls that matter.
  await writeFile(join(bin, 'docker'), `#!/usr/bin/env bash
STUB_COMPOSE_FILE_DEFAULT="\${STUB_DIR}/docker-compose.yml"
STUB_COMPOSE_WORKDIR_DEFAULT="\${STUB_DIR}"
case "$1" in
  build) exit 0 ;;
  tag) exit 0 ;;
  run)
    # 'tar tzf' is the readback check; anything else is the archive itself.
    if [[ "$*" == *tzf* ]]; then echo "./freeapi.db"; exit 0; fi
    echo "backup" >> "${order}"; exit 0 ;;
  compose)
    if [[ "$*" == *" stop"* ]]; then echo "stop" >> "${order}"; fi
    if [[ "$*" == *" up"* ]]; then echo "up" >> "${order}"; fi
    exit 0 ;;
  inspect)
    if [[ "$*" == *"Config.Labels"* ]]; then
      case "$*" in
        *config_files*) echo "\${STUB_DIR}/docker-compose.yml" ;;
        *working_dir*)  echo "\${STUB_DIR}" ;;
        *project*)      echo "freellmapi" ;;
        *service*)      echo "freellmapi" ;;
        *)              echo "" ;;
      esac
      exit 0
    fi
    # 'running' before the stop, 'exited' after it: the script must refuse to
    # archive unless it sees the container actually stopped.
    if [[ "$*" == *".State.Status"* ]]; then
      # running -> (stop) exited -> (up) running again. The script must see a
      # genuinely stopped container before it archives, and a running one
      # before it reports success.
      if grep -q up "${order}" 2>/dev/null; then echo running
      elif grep -q stop "${order}" 2>/dev/null; then echo exited
      else echo running; fi
      exit 0
    fi
    if [[ "$*" == *".State.Health"* ]]; then echo healthy; exit 0; fi
    if [[ "$*" == *".Mounts"* ]]; then echo "freellmapi_freellmapi-data"; exit 0; fi
    if [[ "$*" == *"NetworkSettings.Ports"* ]]; then echo "3001/tcp=1 "; exit 0; fi
    if [[ "$*" == *".Image"* ]]; then echo "sha256:same"; exit 0; fi
    exit 0 ;;
  image) if [[ "$*" == *".Id"* ]]; then echo "sha256:same"; fi; exit 0 ;;
  *) exit 0 ;;
esac
`);
  await chmod(join(bin, 'docker'), 0o755);
  // Note: no --skip-backup, so the backup path is the one under test.
  const result = await runDeployWithBackup(bin, dir);
  assert.equal(result.ok, true, result.stderr);
  const seq = (await readFile(order, 'utf8')).trim().split('\n');
  assert.deepEqual(seq.slice(0, 2), ['stop', 'backup'],
    `stop must precede the backup, got ${seq.join(' -> ')}`);
  assert.ok(seq.indexOf('up') > seq.indexOf('backup'), 'must start only after the archive');
});

test('refuses a compose file that does not exist instead of guessing one', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin, { STUB_COMPOSE_FILE: '/nope/docker-compose.yml' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /compose file \/nope\/docker-compose.yml does not exist/);
});

test('refuses to skip the backup without the explicit acknowledgement', async (t) => {
  const { bin } = await sandbox(t);
  const result = await runDeploy(bin, { DEPLOY_I_ACCEPT_NO_BACKUP: '' });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /DEPLOY_I_ACCEPT_NO_BACKUP=1/);
});

// Not tested here: the remount check that the container came back on the SAME
// volume that was archived. Both the pre-stop lookup and the post-start lookup
// read `.Mounts` on the same container, so a stub cannot answer them
// differently by argument, and a test that cannot fail is worse than none.
// Verified by reading: scripts/deploy.sh compares `$remounted` to `$volume`
// and fails before reporting a deploy.
