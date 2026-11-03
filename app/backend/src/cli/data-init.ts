import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { LmdbStorageEngine } from '../storage/engine.js';
import { createCoreRepositories, seedCoreData } from '../modules/core/repositories.js';

const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
const dirs = ['config', 'store', 'files', 'logs', 'tmp', 'trash', 'locks'];
for (const dir of dirs) await mkdir(resolve(config.dataDir, dir), { recursive: true });
const engine = new LmdbStorageEngine({ path: resolve(config.dataDir, 'store', 'lmdb') });
await engine.open();
await seedCoreData(createCoreRepositories(engine));
await engine.close();
console.log(`数据目录已初始化: ${resolve(config.dataDir)}`);
