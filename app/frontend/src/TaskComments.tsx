import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Form, Input, List, Modal, Popconfirm, Spin, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { createTaskComment, deleteTaskComment, listTaskComments, updateTaskComment } from './api';
import type { Task, TaskComment } from './api';

export function TaskComments({ task, identity, writable, onClose }: { task: Task; identity: MeResponse; writable: boolean; onClose: () => void }): ReactNode {
  const [comments, setComments] = useState<TaskComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TaskComment | null>(null);
  const [moderating, setModerating] = useState<TaskComment | null>(null);
  const [form] = Form.useForm<{ content: string }>();
  const [editForm] = Form.useForm<{ content: string }>();
  const [reasonForm] = Form.useForm<{ reason: string }>();
  useEffect(() => {
    let active = true;
    void listTaskComments(task.id).then((items) => { if (active) setComments(items); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '评论加载失败'); });
    return () => { active = false; };
  }, [task.id]);
  const refresh = async (): Promise<void> => { setComments(await listTaskComments(task.id)); };
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const canComment = writable && identity.permissions.includes('task:comment');
  return <Modal title={`${task.taskKey} 的评论`} open onCancel={onClose} footer={null} width={680}>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    {comments === null ? error ? null : <Spin /> : <List locale={{ emptyText: '暂无评论' }} dataSource={comments} renderItem={(comment) => {
      const own = comment.authorId === identity.user.id;
      const canEdit = own && canComment;
      return <List.Item actions={comment.removedAt ? [] : [
        ...(canEdit ? [<Button key="edit" type="link" onClick={() => { setEditing(comment); editForm.setFieldsValue({ content: comment.content }); }}>编辑</Button>] : []),
        ...(own && canComment ? [<Popconfirm key="delete" title="删除这条评论？" onConfirm={() => void run(async () => { await deleteTaskComment(comment.id, comment.version); await refresh(); })}><Button type="link" danger>删除</Button></Popconfirm>] : []),
        ...(!own && writable && identity.permissions.includes('task:comment:moderate') ? [<Button key="moderate" type="link" danger onClick={() => setModerating(comment)}>删除</Button>] : []),
      ]}><List.Item.Meta title={<Typography.Text type="secondary">{own ? '我' : comment.authorId} · {new Date(comment.createdAt).toLocaleString()}</Typography.Text>} description={<Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{comment.removedAt ? '评论已删除' : comment.content}</Typography.Paragraph>} /></List.Item>;
    }} />}
    {canComment && <Form name="task-comment-create" form={form} layout="vertical" onFinish={(values) => void run(async () => { await createTaskComment(task.id, values.content); form.resetFields(); await refresh(); })}>
      <Form.Item name="content" label="发表评论" rules={[{ required: true, min: 1, max: 2000 }]}><Input.TextArea maxLength={2000} rows={3} /></Form.Item><Button htmlType="submit" type="primary" loading={busy}>发表评论</Button>
    </Form>}
    <Modal title="编辑评论" open={editing !== null} onCancel={() => setEditing(null)} onOk={() => editForm.submit()} confirmLoading={busy} destroyOnClose><Form name="task-comment-edit" form={editForm} layout="vertical" onFinish={(values) => void run(async () => { if (!editing) return; await updateTaskComment(editing.id, editing.version, values.content); setEditing(null); await refresh(); })}><Form.Item name="content" label="评论内容" rules={[{ required: true, min: 1, max: 2000 }]}><Input.TextArea maxLength={2000} rows={3} /></Form.Item></Form></Modal>
    <Modal title="删除他人评论" open={moderating !== null} onCancel={() => setModerating(null)} onOk={() => reasonForm.submit()} confirmLoading={busy} destroyOnClose><Form name="task-comment-moderate" form={reasonForm} layout="vertical" onFinish={(values) => void run(async () => { if (!moderating) return; await deleteTaskComment(moderating.id, moderating.version, values.reason); setModerating(null); reasonForm.resetFields(); await refresh(); })}><Form.Item name="reason" label="删除原因" rules={[{ required: true, min: 2, max: 500 }]}><Input.TextArea maxLength={500} /></Form.Item></Form></Modal>
  </Modal>;
}

