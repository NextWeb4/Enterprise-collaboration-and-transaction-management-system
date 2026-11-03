export { GLOBAL_SCHEMA_VERSION, META_SCHEMA_VERSION_KEY, LmdbStorageEngine } from './engine.js';
export type {
  RangeEntry,
  RangeOptions,
  StorageEngine,
  StorageHealth,
  StorageTransaction,
} from './engine.js';
export { SchemaRegistry, assertSafeValue } from './schema-registry.js';
export type { RegisteredSchema } from './schema-registry.js';
export { indexStoreKey, entityIdFromIndexStoreKey } from './index-registry.js';
export type { IndexDefinition } from './index-registry.js';
export { createEnvelope } from './envelope.js';
export type { DocumentEnvelope } from './envelope.js';
export { BaseRepository } from './repository.js';
export type { ListQuery, Page, Repository, RepositoryDefinition } from './repository.js';
export { UnitOfWork } from './unit-of-work.js';
export { STORE_NAMES, INDEX_STORE_PREFIX, isStoreName, isIndexStoreName } from './store-names.js';
export type { StoreName } from './store-names.js';