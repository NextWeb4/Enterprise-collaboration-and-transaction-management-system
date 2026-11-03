import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { GLOBAL_SCHEMA_VERSION, LmdbStorageEngine } from '../storage/engine.js';
import { SingleInstanceLock } from '../runtime/single-instance.js';

/**
 * Migration entry point is intentionally fail-closed until an approved,
 * versioned transformer and legacy audit verifier are available.
 *
 * Opening with allowSchemaMismatch is restricted to this maintenance command;
 * normal application startup still rejects old, new, or missing versions.
 */
export async function runMigration(dataDir: string): Promise<string> {
  const lock = new SingleInstanceLock(dataDir);
  const engine = new LmdbStorageEngine({ path: resolve(dataDir, 'store', 'lmdb') });
  await lock.acquire();
  try {
    await engine.open({ allowSchemaMismatch: true });
    engine.setMaintenance(true);
    const rawVersion = engine.maintenanceDb('meta').get('schemaVersion') as number | undefined;

    if (rawVersion === undefined) {
      throw new Error('拒绝迁移：数据缺少 meta.schemaVersion；需先提供经审查的旧数据格式与迁移 fixture');
    }
    if (!Number.isSafeInteger(rawVersion) || rawVersion < 1) {
      throw new Error(`拒绝迁移：meta.schemaVersion 无效（${String(rawVersion)}）`);
    }
    if (rawVersion > GLOBAL_SCHEMA_VERSION) {
      throw new Error(`拒绝迁移：数据 schema ${rawVersion} 高于当前版本 ${GLOBAL_SCHEMA_VERSION}`);
    }
    if (rawVersion === GLOBAL_SCHEMA_VERSION) {
      return `无需迁移，schemaVersion=${GLOBAL_SCHEMA_VERSION}`;
    }

    // No approved transformer exists yet. Never guess-convert legacy documents
    // or recompute an incompatible append-only audit hash chain.
    throw new Error(`拒绝迁移：未注册 schema ${rawVersion} -> ${GLOBAL_SCHEMA_VERSION} 的经审查迁移`);
  } finally {
    await engine.close().catch(() => undefined);
    await lock.release().catch(() => undefined);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\//u, '').replaceAll('/', '\\'))) {
const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
  try {
    console.log(await runMigration(resolve(config.dataDir)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
