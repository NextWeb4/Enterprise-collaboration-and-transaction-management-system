import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config/env.js';

describe('task comments and board', () => {
  it('enforces versions, visibility and state rules with atomic column ordering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'collab-board-'));
    const config = loadConfig({
      NODE_ENV: 'development',
      DATA_DIR: dir,
      HOST: '127.0.0.1',
      PORT: '3309',
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const { app, deps } = await buildApp({ config, logger: false });
    const base = { host: '127.0.0.1:3309', origin: config.webOrigin };
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/setup/admin',
            headers: base,
            payload: { name: '管理员', email: 'board.admin', password: 'AdminPasswordStrong42!' },
          })
        ).statusCode,
      ).toBe(201);
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: base,
        payload: { email: 'board.admin', password: 'AdminPasswordStrong42!' },
      });
      const headers = {
        ...base,
        cookie: login.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-csrf-token': login.json().data.csrfToken as string,
      };
      const made = await app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers,
        payload: { name: '看板项目', key: 'BORD', visibility: 'private' },
      });
      const project = made.json().data as { id: string; version: number };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/transition`,
            headers,
            payload: { targetStatus: 'active', version: project.version },
          })
        ).statusCode,
      ).toBe(200);
      const madeTasks = await Promise.all(
        [1, 2, 3].map((n) =>
          app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/tasks`,
            headers,
            payload: { title: `任务${n}` },
          }),
        ),
      );
      expect(madeTasks.map((response) => response.statusCode)).toEqual([201, 201, 201]);
      const tasks = madeTasks
        .map((response) => response.json().data as { id: string; version: number; taskNo: number })
        .sort((a, b) => a.taskNo - b.taskNo);
      const move = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${tasks[2]!.id}/board`,
        headers,
        payload: { version: tasks[2]!.version, targetStatus: 'todo', targetIndex: 0 },
      });
      expect(move.statusCode).toBe(200);
      const column = move.json().data.columns.todo as {
        id: string;
        boardOrder: number;
        version: number;
      }[];
      expect(column.map((task) => task.id)).toEqual([tasks[2]!.id, tasks[0]!.id, tasks[1]!.id]);
      expect(column.map((task) => task.boardOrder)).toEqual([1024, 2048, 3072]);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${tasks[2]!.id}/board`,
            headers,
            payload: { version: tasks[2]!.version, targetStatus: 'done', targetIndex: 0 },
          })
        ).statusCode,
      ).toBe(409);
      const current = column[0]!;
      const done = await app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${current.id}/board`,
        headers,
        payload: { version: current.version, targetStatus: 'done', targetIndex: 0 },
      });
      expect(done.statusCode).toBe(200);
      expect(done.json().data.task.progress).toBe(100);
      expect(
        done.json().data.columns.todo.map((task: { boardOrder: number }) => task.boardOrder),
      ).toEqual([1024, 2048]);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${current.id}/board`,
            headers,
            payload: {
              version: done.json().data.task.version,
              targetStatus: 'in_review',
              targetIndex: 0,
            },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/tasks/${current.id}/comments`,
            headers,
            payload: { content: '<script>alert(1)</script>' },
          })
        ).statusCode,
      ).toBe(422);
      const comment = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${current.id}/comments`,
        headers,
        payload: { content: '请查看进度' },
      });
      expect(comment.statusCode).toBe(201);
      const row = comment.json().data as { id: string; version: number };
      const createdMember = await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        headers,
        payload: { name: '旁观成员', email: 'board.member', password: 'MemberPasswordStrong42!' },
      });
      const memberId = createdMember.json().data.user.id as string;
      const memberLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: base,
        payload: { email: 'board.member', password: 'MemberPasswordStrong42!' },
      });
      const memberHeaders = {
        ...base,
        cookie: memberLogin.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
        'x-csrf-token': memberLogin.json().data.csrfToken as string,
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/change-password',
            headers: memberHeaders,
            payload: {
              currentPassword: 'MemberPasswordStrong42!',
              newPassword: 'MemberNewPasswordStrong42!',
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/tasks/${current.id}/comments`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/tasks/${current.id}/comments`,
            headers: memberHeaders,
            payload: { content: '无权评论' },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/projects/${project.id}/members`,
            headers,
            payload: { userId: memberId, role: 'viewer' },
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/tasks/${current.id}/comments`,
            headers: memberHeaders,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/tasks/${current.id}/comments`,
            headers: memberHeaders,
            payload: { content: '观察者不可评论' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/tasks/${current.id}/board`,
            headers: memberHeaders,
            payload: {
              version: done.json().data.task.version,
              targetStatus: 'todo',
              targetIndex: 0,
            },
          })
        ).statusCode,
      ).toBe(403);
      const memberRows = (
        await app.inject({ method: 'GET', url: `/api/v1/projects/${project.id}/members`, headers })
      ).json().data as { userId: string; version: number }[];
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/projects/${project.id}/members/${memberId}`,
            headers,
            payload: {
              role: 'member',
              version: memberRows.find((item) => item.userId === memberId)!.version,
            },
          })
        ).statusCode,
      ).toBe(200);
      const memberComment = await app.inject({
        method: 'POST',
        url: `/api/v1/tasks/${current.id}/comments`,
        headers: memberHeaders,
        payload: { content: '成员评论' },
      });
      expect(memberComment.statusCode).toBe(201);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/comments/${memberComment.json().data.id}`,
            headers,
            payload: { version: 1 },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/comments/${memberComment.json().data.id}`,
            headers,
            payload: { version: 1, reason: '内容不当' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/comments/${row.id}`,
            headers,
            payload: { version: row.version, content: '更新评论' },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/comments/${row.id}`,
            headers,
            payload: { version: row.version, content: '冲突' },
          })
        ).statusCode,
      ).toBe(409);
      const old = await deps.projectRepos.comments.create(
        {
          taskId: current.id,
          authorId: login.json().data.user.id,
          content: '旧评论',
          editedAt: null,
          removedAt: null,
        },
        undefined,
        { createdAt: '2020-01-01T00:00:00.000Z' },
      );
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/v1/comments/${old.id}`,
            headers,
            payload: { version: old.version, content: '超时编辑' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/api/v1/comments/${row.id}`,
            headers,
            payload: { version: row.version + 1 },
          })
        ).statusCode,
      ).toBe(200);
      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/tasks/${current.id}/comments`,
        headers,
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.find((item: { id: string }) => item.id === row.id)).toMatchObject({
        content: '',
        removedAt: expect.any(String),
      });
      expect(await deps.audit.verifyChain()).toBe(true);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
