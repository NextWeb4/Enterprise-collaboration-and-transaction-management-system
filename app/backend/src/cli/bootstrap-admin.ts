import { resolve } from 'node:path';
import { loadConfig } from '../config/env.js';
import { LmdbStorageEngine } from '../storage/engine.js';
import { createCoreRepositories, seedCoreData } from '../modules/core/repositories.js';
import { AuthService } from '../modules/core/auth-service.js';
import { AuditService } from '../modules/core/audit-service.js';
import type { UserDocument } from '../modules/core/models.js';
import type { DocumentEnvelope } from '../storage/envelope.js';
import { UnitOfWork } from '../storage/unit-of-work.js';
import { internalAccountSchema, isAcceptablePassword } from '@collab/shared/schemas.js';
import { SingleInstanceLock } from '../runtime/single-instance.js';

const config = loadConfig({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? './.data' });
const parsedAccount = internalAccountSchema.safeParse(process.env.BOOTSTRAP_ADMIN_ACCOUNT);
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || '组织管理员';
if (!parsedAccount.success || !password || password.length < 12 || password.length > 128 || !isAcceptablePassword(password)) throw new Error('请设置有效的 BOOTSTRAP_ADMIN_ACCOUNT 和 12–128 位非弱密码 BOOTSTRAP_ADMIN_PASSWORD，可选设置 BOOTSTRAP_ADMIN_NAME');
const email = parsedAccount.data;
const lock = new SingleInstanceLock(config.dataDir);
await lock.acquire();
const engine = new LmdbStorageEngine({ path: resolve(config.dataDir, 'store', 'lmdb') });
try {
  await engine.open();
  const repos = createCoreRepositories(engine);
  if ((await repos.users.countStored()) !== 0 || (await repos.auditLogs.countStored()) !== 0) throw new Error('数据目录已包含用户或审计记录，拒绝重复初始化首个管理员');
  await seedCoreData(repos);
  if (await repos.users.getByUniqueIndex('idx_users_email', email)) throw new Error('管理员账号已存在');
  const role = await repos.roles.getByUniqueIndex('idx_roles_code', 'org_admin');
  if (!role) throw new Error('org_admin 角色不存在');
  const uow = new UnitOfWork(engine);
  const audit = new AuditService(repos, uow);
  const auth = new AuthService(repos, uow, audit);
  const passwordHash = await auth.createPasswordHash(password);
  const user = await uow.run(async (tx) => {
    const created = await repos.users.create({ name, email, passwordHash, status: 'active', mustChangePassword: false, lastLoginAt: null, passwordChangedAt: new Date().toISOString(), failedLoginCount: 0, lockedUntil: null, roleIds: [role.id], departmentId: null } as Omit<UserDocument, keyof DocumentEnvelope>, tx);
    await audit.append({ actorUserId: null, action: 'user.bootstrap_created', resourceType: 'user', resourceId: created.id, ip: null, userAgent: null }, tx);
    return created;
  });
  console.log(`管理员已创建: ${user.email}`);
} finally {
  try {
    await engine.close();
  } finally {
    await lock.release();
  }
}
