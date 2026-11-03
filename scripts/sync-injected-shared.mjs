import { cp, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'app', 'shared', 'dist');
const targetDir = path.join(rootDir, 'node_modules', '@collab', 'shared');
const targetStats = await lstat(targetDir).catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

if (!targetStats) {
  throw new Error(`Injected shared package is missing: ${targetDir}`);
}
if (targetStats.isSymbolicLink()) {
  throw new Error(`Injected shared package must be a directory, got a link: ${targetDir}`);
}

await mkdir(targetDir, { recursive: true });
const targetDist = path.join(targetDir, 'dist');
const lockPath = path.join(targetDir, '.dist-sync.lock');

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function acquireSyncLock() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pid = Number((await readFile(lockPath, 'utf8').catch(() => '')).split(/\s+/u)[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !(await processIsAlive(pid))) {
        await rm(lockPath, { force: true });
        continue;
      }
      await delay(25);
    }
  }
  throw new Error(`Timed out waiting for shared dist sync lock: ${lockPath}`);
}

const lockHandle = await acquireSyncLock();
try {
  await rm(targetDist, { recursive: true, force: true });
  await cp(sourceDir, targetDist, { recursive: true });
} finally {
  await lockHandle.close();
  await rm(lockPath, { force: true });
}
