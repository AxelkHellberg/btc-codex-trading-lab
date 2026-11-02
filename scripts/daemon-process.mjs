import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// PID files protect against accidental PID reuse, not a hostile process owner.
export function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid daemon PID');
  const output = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='],
    { encoding: 'utf8', timeout: 2000 }).trim();
  const match = output.match(/^(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
  if (!match) throw new Error('Cannot identify daemon process');
  return { uid: Number(match[1]), startedAt: match[2].replace(/\s+/g, ' '), command: match[3] };
}

export function verifyRecord(record, root, inspect = inspectProcess, uid = process.getuid()) {
  if (record?.version !== 1 || record.root !== root || !['app', 'caffeinate'].includes(record.role) ||
      !Number.isSafeInteger(record.pid) || record.pid <= 1 || record.uid !== uid ||
      typeof record.startedAt !== 'string' || typeof record.command !== 'string') return false;
  const expected = record.role === 'app'
    ? `${record.executable} ${root}/dist/index.js`
    : `${record.executable} -im -w ${record.appPid}`;
  if (typeof record.executable !== 'string' || !record.executable.startsWith('/') || record.command !== expected ||
      (record.role === 'caffeinate' && (!Number.isSafeInteger(record.appPid) || record.appPid <= 1))) return false;
  try {
    const current = inspect(record.pid);
    return current.uid === record.uid && current.startedAt === record.startedAt && current.command === expected;
  } catch { return false; }
}

function main() {
  const [action, file, role, pidText, executable, appPidText] = process.argv.slice(2);
  const root = realpathSync(process.cwd());
  if (action === 'record') {
    const pid = Number(pidText);
    const record = { version: 1, root, role, pid, executable, appPid: Number(appPidText), ...inspectProcess(pid) };
    if (!verifyRecord(record, root)) throw new Error('Child process identity did not match');
    writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return;
  }
  if (!['verify', 'stop'].includes(action)) throw new Error('Unknown daemon process action');
  let contents;
  let record;
  try { contents = readFileSync(file, 'utf8'); record = JSON.parse(contents); }
  catch { /* Legacy numeric and malformed files are stale, never signal them. */ }
  const valid = verifyRecord(record, root);
  if (valid && action === 'verify') { console.log(record.pid); return; }
  if (valid && action === 'stop') process.kill(record.pid, 'SIGTERM');
  // A concurrent replacement belongs to another invocation.
  try { if (readFileSync(file, 'utf8') === contents) unlinkSync(file); } catch { /* Already absent. */ }
  if (!valid && action === 'verify') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
