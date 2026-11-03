import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LmdbStorageEngine } from '../src/storage/engine.js';
import { indexStoreKey } from '../src/storage/index-registry.js';
import { createCoreRepositories } from '../src/modules/core/repositories.js';
import { createProjectRepositories } from '../src/modules/projects/project-service.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
function run(script: string, dir: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', script], {
    cwd: process.cwd(),
    env: { ...process.env, DATA_DIR: dir },
    encoding: 'utf8',
    timeout: 30000,
  });
}
async function open(dir: string): Promise<LmdbStorageEngine> {
  const engine = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
  await engine.open();
  return engine;
}

describe('project storage maintenance', () => {
  it('detects damaged unique and nonunique indexes, rebuilds and retains them after restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-project-maintenance-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const engine = await open(dir);
    const repos = createProjectRepositories(engine, createCoreRepositories(engine));
    const project = await repos.projects.create({
      name: '验证项目',
      key: 'VER',
      description: '',
      visibility: 'private',
      status: 'planning',
      statusReason: null,
      ownerId: 'owner-id',
      taskSeq: 1,
      startDate: null,
      dueDate: null,
    });
    const member = await repos.members.create({
      projectId: project.id,
      userId: 'owner-id',
      role: 'owner',
      membershipKey: `${project.id}:owner-id`,
    });
    const task = await repos.tasks.create({
      projectId: project.id,
      taskNo: 1,
      taskKey: 'VER-1',
      title: '验证任务',
      description: '',
      status: 'todo',
      progress: 0,
      priority: 'medium',
      assigneeId: null,
      createdBy: 'owner-id',
      startDate: null,
      dueDate: null,
      completedAt: null,
    });
    const comment = await repos.comments.create({
      taskId: task.id,
      authorId: 'owner-id',
      content: '验证评论',
      editedAt: null,
      removedAt: null,
    });
    await engine.transaction((tx) => {
      tx.remove('idx_projects_key', project.key);
      tx.remove('idx_project_members_key', member.membershipKey);
      tx.remove('idx_tasks_key', task.taskKey);
      tx.remove('idx_projects_visibility', indexStoreKey(project.visibility, project.id));
      tx.remove('idx_projects_owner', indexStoreKey(project.ownerId, project.id));
      tx.remove('idx_project_members_user', indexStoreKey(member.userId, member.id));
      tx.remove('idx_project_members_project', indexStoreKey(project.id, member.id));
      tx.remove('idx_tasks_project', indexStoreKey(project.id, task.id));
      tx.put('idx_projects_owner', indexStoreKey('stale', 'missing'), 'missing');
    });
    await engine.close();
    const invalid = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(invalid.status).not.toBe(0);
    for (const name of [
      'idx_projects_key',
      'idx_project_members_key',
      'idx_tasks_key',
      'idx_projects_visibility',
      'idx_projects_owner',
      'idx_project_members_user',
      'idx_project_members_project',
      'idx_tasks_project',
    ])
      expect(String(invalid.stdout)).toContain(name);
    const rebuilt = run('app/backend/src/cli/rebuild-indexes.ts', dir);
    expect(rebuilt.status, String(rebuilt.stderr)).toBe(0);
    const verified = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verified.status, String(verified.stderr)).toBe(0);
    const reopened = await open(dir);
    try {
      const after = createProjectRepositories(reopened, createCoreRepositories(reopened));
      expect((await after.comments.get(comment.id))?.content).toBe('验证评论');
      expect((await after.projects.getByUniqueIndex('idx_projects_key', 'VER'))?.id).toBe(
        project.id,
      );
      expect(
        (await after.members.getByUniqueIndex('idx_project_members_key', member.membershipKey))?.id,
      ).toBe(member.id);
      expect((await after.tasks.getByUniqueIndex('idx_tasks_key', 'VER-1'))?.id).toBe(task.id);
      expect(
        (
          await after.members.list({ indexName: 'idx_project_members_user', prefix: member.userId })
        ).items.map((item) => item.id),
      ).toEqual([member.id]);
      expect(
        (
          await after.members.list({ indexName: 'idx_project_members_project', prefix: project.id })
        ).items.map((item) => item.id),
      ).toEqual([member.id]);
      expect(
        (
          await after.projects.list({ indexName: 'idx_projects_visibility', prefix: 'private' })
        ).items.map((item) => item.id),
      ).toEqual([project.id]);
      expect(
        (
          await after.projects.list({ indexName: 'idx_projects_owner', prefix: project.ownerId })
        ).items.map((item) => item.id),
      ).toEqual([project.id]);
      expect(
        (await after.tasks.list({ indexName: 'idx_tasks_project', prefix: project.id })).items.map(
          (item) => item.id,
        ),
      ).toEqual([task.id]);
      expect(
        (await after.projects.list({ indexName: 'idx_projects_owner', prefix: 'stale' })).total,
      ).toBe(0);
      await expect(
        after.projects.create({
          name: '重复项目',
          key: 'VER',
          description: '',
          visibility: 'private',
          status: 'planning',
          statusReason: null,
          ownerId: 'another',
          taskSeq: 0,
          startDate: null,
          dueDate: null,
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_KEY_TAKEN' });
    } finally {
      await reopened.close();
    }
  });

  it('rejects malformed comment data during verification and rebuild', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-comment-invalid-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const engine = await open(dir);
    const repos = createProjectRepositories(engine, createCoreRepositories(engine));
    const comment = await repos.comments.create({
      taskId: 'task-id',
      authorId: 'user-id',
      content: '测试',
      editedAt: null,
      removedAt: null,
    });
    await engine.transaction((tx) => {
      tx.put('task_comments', comment.id, { ...comment, authorId: 123 });
    });
    await engine.close();
    const verify = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verify.status).not.toBe(0);
    expect(String(verify.stdout)).toContain('task_comments');
    expect(run('app/backend/src/cli/rebuild-indexes.ts', dir).status).not.toBe(0);
  });

  it('rejects corrupt project documents before mutating any index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-project-invalid-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const engine = await open(dir);
    const repos = createProjectRepositories(engine, createCoreRepositories(engine));
    const project = await repos.projects.create({
      name: '无效项目',
      key: 'BAD',
      description: '',
      visibility: 'private',
      status: 'planning',
      statusReason: null,
      ownerId: 'owner-id',
      taskSeq: 0,
      startDate: null,
      dueDate: null,
    });
    await engine.transaction((tx) => {
      tx.put('projects', project.id, { ...project, name: '' });
    });
    await engine.close();
    const verified = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verified.status).not.toBe(0);
    expect(String(verified.stdout)).toContain('schema 或主键无效');
    const rebuilt = run('app/backend/src/cli/rebuild-indexes.ts', dir);
    expect(rebuilt.status).not.toBe(0);
    const reopened = await open(dir);
    try {
      await reopened.transaction((tx) => {
        expect(tx.get('idx_projects_key', 'BAD')).toBe(project.id);
      });
    } finally {
      await reopened.close();
    }
  });

  it('reports file reference drift without repairing refCount or any index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-file-reference-maintenance-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const content = Buffer.from('unbound file must remain evidence');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    await mkdir(join(dir, 'files', sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, 'files', storageKey), content);
    const engine = await open(dir);
    const core = createCoreRepositories(engine);
    const file = await core.files.create({
      originalName: 'evidence.txt',
      mimeType: 'text/plain',
      size: content.length,
      sha256,
      storageKey,
      refCount: 1,
      uploadedBy: 'owner',
      status: 'active',
    });
    await engine.transaction((tx) =>
      tx.put('idx_projects_owner', indexStoreKey('stale', 'missing'), 'missing'),
    );
    await engine.close();

    const verified = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verified.status).not.toBe(0);
    expect(String(verified.stdout)).toContain(`files: ${file.id} refCount=1`);
    const rebuilt = run('app/backend/src/cli/rebuild-indexes.ts', dir);
    expect(rebuilt.status).not.toBe(0);

    const reopened = await open(dir);
    try {
      const repos = createCoreRepositories(reopened);
      expect((await repos.files.require(file.id)).refCount).toBe(1);
      await reopened.transaction((tx) => {
        expect(tx.get('idx_projects_owner', indexStoreKey('stale', 'missing'))).toBe('missing');
      });
    } finally {
      await reopened.close();
    }
  });

  it('counts document versions and active application attachments as independent references', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-file-reference-sources-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const content = Buffer.from('one document version and one active application attachment');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const storageKey = `${sha256.slice(0, 2)}/${sha256}`;
    await mkdir(join(dir, 'files', sha256.slice(0, 2)), { recursive: true });
    await writeFile(join(dir, 'files', storageKey), content);
    const engine = await open(dir);
    const core = createCoreRepositories(engine);
    const file = await core.files.create({
      originalName: 'shared.txt',
      mimeType: 'text/plain',
      size: content.length,
      sha256,
      storageKey,
      refCount: 1,
      uploadedBy: 'owner',
      status: 'active',
    });
    const now = new Date().toISOString();
    await engine.transaction((tx) => {
      tx.put('documents', 'doc-1', {
        id: 'doc-1',
        type: 'document',
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        title: '引用对账',
        description: '',
        categoryId: null,
        projectId: null,
        ownerId: 'owner',
        visibility: 'organization',
        status: 'active',
        currentVersionId: 'version-1',
        versionCount: 1,
      });
      tx.put('document_versions', 'version-1', {
        id: 'version-1',
        type: 'document_version',
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        documentId: 'doc-1',
        versionNo: 1,
        fileId: file.id,
        fileName: 'shared.txt',
        mime: 'text/plain',
        size: content.length,
        sha256,
        versionNote: '',
        uploadedBy: 'owner',
      });
      tx.put('applications', 'application-1', {
        id: 'application-1',
        type: 'application',
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        applicationNo: null,
        applicationType: 'general',
        title: '附件引用',
        formSchemaVersion: 1,
        formData: {},
        startAt: null,
        endAt: null,
        status: 'draft',
        applicantId: 'owner',
        departmentId: null,
        submittedAt: null,
        completedAt: null,
      });
      tx.put('application_attachments', 'attachment-1', {
        id: 'attachment-1',
        type: 'application_attachment',
        schemaVersion: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        applicationId: 'application-1',
        fileId: file.id,
        fileName: 'shared.txt',
        mime: 'text/plain',
        size: content.length,
        sha256,
        uploadedBy: 'owner',
      });
      tx.put('idx_projects_owner', indexStoreKey('stale', 'missing'), 'missing');
    });
    await engine.close();

    const verify = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verify.status).not.toBe(0);
    expect(String(verify.stdout)).toContain('refCount=1 与业务引用数=2');
    const rebuild = run('app/backend/src/cli/rebuild-indexes.ts', dir);
    expect(rebuild.status).not.toBe(0);

    const reopened = await open(dir);
    try {
      await reopened.transaction((tx) => {
        expect(tx.get<Record<string, unknown>>('files', file.id)?.refCount).toBe(1);
        expect(tx.get('idx_projects_owner', indexStoreKey('stale', 'missing'))).toBe('missing');
        expect(tx.get('idx_documents_owner', indexStoreKey('owner', 'doc-1'))).toBeUndefined();
      });
    } finally {
      await reopened.close();
    }
  });

  it('rejects duplicate primary unique keys before changing any indexes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-unique-conflict-maintenance-'));
    dirs.push(dir);
    for (const name of ['files', 'tmp', 'trash']) await mkdir(join(dir, name), { recursive: true });
    const engine = await open(dir);
    const repos = createProjectRepositories(engine, createCoreRepositories(engine));
    const project = await repos.projects.create({
      name: '唯一性项目',
      key: 'UNQ',
      description: '',
      visibility: 'private',
      status: 'planning',
      statusReason: null,
      ownerId: 'owner-id',
      taskSeq: 0,
      startDate: null,
      dueDate: null,
    });
    await engine.transaction((tx) => {
      tx.put('projects', 'duplicate-project', {
        ...project,
        id: 'duplicate-project',
        name: '重复唯一键项目',
      });
      tx.remove('idx_projects_key', 'UNQ');
      tx.put('idx_projects_owner', indexStoreKey('stale', 'missing'), 'missing');
    });
    await engine.close();

    const verify = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verify.status).not.toBe(0);
    const rebuild = run('app/backend/src/cli/rebuild-indexes.ts', dir);
    expect(rebuild.status).not.toBe(0);
    expect(String(rebuild.stderr)).toContain('唯一键 UNQ');

    const reopened = await open(dir);
    try {
      await reopened.transaction((tx) => {
        expect(tx.get('idx_projects_key', 'UNQ')).toBeUndefined();
        expect(tx.get('idx_projects_owner', indexStoreKey('stale', 'missing'))).toBe('missing');
      });
    } finally {
      await reopened.close();
    }
  });

  it('keeps an invalid schema marker unchanged when storage verification fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-verify-schema-marker-'));
    dirs.push(dir);
    const engine = await open(dir);
    await engine.transaction((tx) => tx.put('meta', 'schemaVersion', 0));
    await engine.close();

    expect(run('app/backend/src/cli/storage-verify.ts', dir).status).not.toBe(0);
    const inspection = new LmdbStorageEngine({ path: join(dir, 'store', 'lmdb') });
    await inspection.open({ allowSchemaMismatch: true });
    try {
      expect(inspection.maintenanceDb('meta').get('schemaVersion')).toBe(0);
    } finally {
      await inspection.close();
    }
  });

  it('rejects malformed core documents before mutating any stale index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-core-invalid-maintenance-'));
    dirs.push(dir);
    const engine = await open(dir);
    const core = createCoreRepositories(engine);
    const user = await core.users.create({
      name: '完整性用户',
      email: 'integrity.user',
      passwordHash: 'x'.repeat(30),
      status: 'active',
      mustChangePassword: false,
      lastLoginAt: null,
      passwordChangedAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      roleIds: [],
      departmentId: null,
    });
    await engine.transaction((tx) => {
      tx.put('users', user.id, { ...user, passwordHash: 'invalid' });
      tx.put('idx_projects_owner', indexStoreKey('stale', 'missing'), 'missing');
    });
    await engine.close();

    const verify = run('app/backend/src/cli/storage-verify.ts', dir);
    expect(verify.status).not.toBe(0);
    expect(String(verify.stdout)).toContain(`users: ${user.id} schema 或主键无效`);
    expect(run('app/backend/src/cli/rebuild-indexes.ts', dir).status).not.toBe(0);

    const reopened = await open(dir);
    try {
      await reopened.transaction((tx) => {
        expect(tx.get('idx_projects_owner', indexStoreKey('stale', 'missing'))).toBe('missing');
      });
    } finally {
      await reopened.close();
    }
  });
});
