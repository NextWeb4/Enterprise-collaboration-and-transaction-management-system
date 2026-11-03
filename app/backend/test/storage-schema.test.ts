import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_SCHEMA_VERSION, LmdbStorageEngine } from '../src/storage/engine.js';

const engines: LmdbStorageEngine[] = [];
const directories: string[] = [];

async function createEngine(): Promise<{ engine: LmdbStorageEngine; path: string }> {
  const path = await mkdtemp(join(tmpdir(), 'collab-office-schema-'));
  directories.push(path);
  const engine = new LmdbStorageEngine({ path });
  engines.push(engine);
  await engine.open();
  return { engine, path };
}

afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('normal application schema guard', () => {
  it.each([null, true, '1', 1.5, -1, 0, GLOBAL_SCHEMA_VERSION + 1])('rejects stored schema %j and preserves it for inspection', async (version) => {
    const { engine, path } = await createEngine();
    await engine.transaction((tx) => tx.put('meta', 'schemaVersion', version));
    await engine.close();
    const application = new LmdbStorageEngine({ path });
    engines.push(application);

    await expect(application.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await application.healthCheck()).toMatchObject({ ok: false, writable: false });
    // The failed open must close its handle; the same instance can be reopened
    // explicitly for maintenance without silently bypassing the version guard.
    await application.open({ allowSchemaMismatch: true });
    expect(application.maintenanceDb('meta').get('schemaVersion')).toEqual(version);
  });

  it('does not relabel an existing unversioned data directory as current', async () => {
    const { engine, path } = await createEngine();
    await engine.transaction((tx) => {
      tx.put('documents', 'retained-document', { original: 'preserve this payload' });
      tx.remove('meta', 'schemaVersion');
    });
    await engine.close();
    const application = new LmdbStorageEngine({ path });
    engines.push(application);

    await expect(application.open()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await application.open({ allowSchemaMismatch: true });
    expect(application.maintenanceDb('meta').get('schemaVersion')).toBeUndefined();
    expect(application.maintenanceDb('documents').get('retained-document')).toEqual({ original: 'preserve this payload' });
  });

  it('initializes a genuinely empty directory and reopens the current version', async () => {
    const { engine } = await createEngine();
    expect(await engine.healthCheck()).toMatchObject({ ok: true, schemaVersion: GLOBAL_SCHEMA_VERSION, writable: true });
    await engine.close();
    await engine.open();
    expect(await engine.healthCheck()).toMatchObject({ ok: true, schemaVersion: GLOBAL_SCHEMA_VERSION });
  });
});
