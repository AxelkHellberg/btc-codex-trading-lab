import { describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Run the actual operator helper without importing production entrypoints.
const helper = resolve('scripts/daemon-process.mjs');
const checks = `
import { verifyRecord, inspectProcess } from ${JSON.stringify(new URL('../scripts/daemon-process.mjs', import.meta.url).pathname)};
import assert from 'node:assert/strict';
const identity = {uid: process.getuid(), startedAt: 'Mon Nov 2 09:00:00 2026', command: '/bin/node /repo/dist/index.js'};
const record = {version:1, root:'/repo', role:'app', pid:123, executable:'/bin/node', ...identity};
assert.equal(verifyRecord(record, '/repo', () => identity), true);
for (const delta of [{uid:99}, {startedAt:'other start'}, {command:'/bin/node /other/dist/index.js'}]) {
 assert.equal(verifyRecord(record, '/repo', () => ({...identity, ...delta})), false);
}
for (const delta of [{pid:0}, {pid:-1}, {pid:1}, {pid:'123'}, {root:'/other'}, {role:'other'}, {command:'/bin/sh'}, {version:0}]) {
 assert.equal(verifyRecord({...record,...delta}, '/repo', () => identity), false);
}
assert.equal(verifyRecord(123, '/repo', () => identity), false);
assert.equal(verifyRecord(record, '/repo', () => {throw Error('gone')}), false);
const caffeinate = {...record,role:'caffeinate',executable:'/usr/bin/caffeinate',appPid:124,command:'/usr/bin/caffeinate -im -w 124'};
assert.equal(verifyRecord(caffeinate,'/repo',()=>({...identity,command:caffeinate.command})),true);
assert.equal(verifyRecord({...caffeinate,appPid:125},'/repo',()=>({...identity,command:caffeinate.command})),false);
assert.equal(inspectProcess(process.pid).uid,process.getuid());
`;

describe('daemon process ownership', () => {
  it('checks process user, start time, exact repository command and caffeinate target', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', checks], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
  it.each(['0', '-1', '1', String(process.pid), 'garbage', '{"pid":1}'])(
    'removes stale pidfile %s without signaling an unrelated process', (contents) => {
      const dir = mkdtempSync(`${tmpdir()}/daemon-pid-`);
      try {
        const file = `${dir}/app.pid`;
        writeFileSync(file, contents);
        const result = spawnSync(process.execPath, [helper, 'stop', file], { encoding: 'utf8' });
        expect(result.status).toBe(0);
        expect(existsSync(file)).toBe(false);
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  it('records, reuses and stops only the identified child process', async () => {
    const dir = mkdtempSync(`${tmpdir()}/daemon-owned-`);
    mkdirSync(`${dir}/dist`);
    writeFileSync(`${dir}/dist/index.js`, 'setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [`${dir}/dist/index.js`], { cwd: dir, stdio: 'ignore' });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const invoke = (...args: string[]) => spawnSync(process.execPath, [helper, ...args], { cwd: dir, encoding: 'utf8' });
    try {
      await new Promise<void>((resolve) => child.once('spawn', () => resolve()));
      const file = `${dir}/app.pid`;
      expect(invoke('record', file, 'app', String(child.pid), process.execPath).status).toBe(0);
      expect(invoke('verify', file).stdout.trim()).toBe(String(child.pid));
      expect(invoke('stop', file).status).toBe(0);
      expect(existsSync(file)).toBe(false);
      await exited;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses to reuse a legacy live PID as a running daemon', () => {
    const dir = mkdtempSync(`${tmpdir()}/daemon-pid-`);
    try {
      const file = `${dir}/app.pid`;
      writeFileSync(file, String(process.pid));
      const result = spawnSync(process.execPath, [helper, 'verify', file], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(existsSync(file)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
