import { randomUUID } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';

export class SingleInstanceLock {
  private handle: FileHandle | null = null;
  private token: string | null = null;
  private readonly path: string;
  private readonly recoveryPath: string;

  constructor(dataDir: string) {
    this.path = resolve(dataDir, 'locks', 'app.lock');
    this.recoveryPath = `${this.path}.recovery`;
  }

  async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    if (await this.tryCreate()) return;

    const existing = await this.readLockFile(this.path);
    const pid = this.lockPid(existing);
    if (pid === null || this.processIsAlive(pid)) {
      throw new AppError('STORAGE_UNAVAILABLE', '已有实例正在运行');
    }

    let recoveryHandle: FileHandle;
    try {
      recoveryHandle = await open(this.recoveryPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('STORAGE_UNAVAILABLE', '锁恢复标记已存在；请确认没有实例运行后再手动清理该标记');
      }
      throw error;
    }

    const recoveryToken = randomUUID();
    try {
      await recoveryHandle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${recoveryToken}\n`);
      await recoveryHandle.sync();

      // Only the holder of the recovery marker may move a stale lock. Re-read
      // while serialized so concurrent starters cannot move a newly-owned lock.
      const current = await this.readLockFile(this.path);
      const currentPid = this.lockPid(current);
      if (currentPid !== null && this.processIsAlive(currentPid)) {
        throw new AppError('STORAGE_UNAVAILABLE', '已有实例正在运行');
      }
      if (currentPid === null && current !== '') {
        throw new AppError('STORAGE_UNAVAILABLE', '实例锁文件无效；请确认没有实例运行后再手动清理');
      }

      if (current === '') {
        if (!(await this.tryCreate())) throw new AppError('STORAGE_UNAVAILABLE', '已有实例正在运行');
        return;
      }

      const stalePath = `${this.path}.stale-${randomUUID()}`;
      try {
        await rename(this.path, stalePath);
      } catch {
        if (await this.tryCreate()) return;
        throw new AppError('STORAGE_UNAVAILABLE', '已有实例正在运行');
      }
      try {
        if (!(await this.tryCreate())) throw new AppError('STORAGE_UNAVAILABLE', '已有实例正在运行');
      } finally {
        await rm(stalePath, { force: true }).catch(() => undefined);
      }
    } finally {
      await this.releaseRecoveryGate(recoveryHandle, recoveryToken);
    }
  }

  async release(): Promise<void> {
    const handle = this.handle;
    if (handle) {
      await handle.close();
      this.handle = null;
    }
    const token = this.token;
    if (!token) return;
    let current: string;
    try {
      current = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.token = null;
        return;
      }
      throw error;
    }
    if (current.split(/\r?\n/u)[2] !== token) {
      this.token = null;
      return;
    }
    await rm(this.path);
    this.token = null;
  }

  private async tryCreate(): Promise<boolean> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    const token = randomUUID();
    try {
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`);
      await handle.sync();
      this.handle = handle;
      this.token = token;
      return true;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(this.path, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
  }

  private async readLockFile(path: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private lockPid(contents: string): number | null {
    const pid = Number(contents.split(/\r?\n/u, 1)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }

  private async releaseRecoveryGate(handle: FileHandle, token: string): Promise<void> {
    await handle.close();
    const current = await this.readLockFile(this.recoveryPath);
    if (current.split(/\r?\n/u)[2] === token) await rm(this.recoveryPath, { force: true });
  }
}
