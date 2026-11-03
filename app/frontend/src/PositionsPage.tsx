import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { MeResponse } from '@collab/shared/schemas.js';
import { createPosition, deletePosition, listPositions, updatePosition, type Position, type PositionInput } from './organization-directory-api';

const positionFormSchema = z.object({ name: z.string().trim().min(1, '请输入岗位名称').max(80, '岗位名称最多 80 字'), code: z.string().trim().min(1, '请输入岗位编码').max(64, '岗位编码最多 64 字'), description: z.string().max(300, '说明最多 300 字'), sortOrder: z.number().int().min(0).max(1000000), status: z.enum(['active', 'inactive']) });
type PositionForm = z.infer<typeof positionFormSchema>;
function failureText(error: unknown): string { return error instanceof Error ? error.message : '岗位操作失败'; }

export function PositionsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><PositionsWorkspace identity={identity} /></QueryClientProvider>;
}

function PositionsWorkspace({ identity }: { identity: MeResponse }): ReactNode {
  const client = useQueryClient(); const [editing, setEditing] = useState<Position | 'new' | null>(null); const [error, setError] = useState<string | null>(null);
  const canRead = identity.permissions.includes('position:read'); const canManage = identity.permissions.includes('position:manage');
  const positions = useQuery({ queryKey: ['positions'], queryFn: listPositions, enabled: canRead });
  const save = useMutation({ mutationFn: async ({ current, input }: { current: Position | 'new'; input: PositionInput }) => current === 'new' ? createPosition(input) : updatePosition(current.id, { ...input, version: current.version }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['positions'] }); setEditing(null); }, onError: (reason: unknown) => setError(failureText(reason)) });
  const remove = useMutation({ mutationFn: ({ id, version }: Pick<Position, 'id' | 'version'>) => deletePosition(id, version), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['positions'] }); }, onError: (reason: unknown) => setError(failureText(reason)) });
  if (!canRead) return <Card><Alert type="warning" showIcon message="没有查看岗位的权限" /></Card>;
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>岗位管理</Typography.Title><Typography.Text type="secondary">维护岗位目录；被员工档案引用的岗位不能删除。</Typography.Text></div>{canManage && <Button type="primary" onClick={() => { setError(null); setEditing('new'); }}>新建岗位</Button>}</div>
    {(error || positions.error) && <Alert type="error" showIcon message={error ?? failureText(positions.error)} closable onClose={() => setError(null)} />}
    <Card>{positions.isLoading ? <div className="page-loading"><Spin /></div> : (positions.data ?? []).length === 0 ? <Empty description="暂无岗位" /> : <Table rowKey="id" dataSource={positions.data} pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
      { title: '岗位名称', dataIndex: 'name' }, { title: '岗位编码', dataIndex: 'code' }, { title: '说明', dataIndex: 'description', render: (value: string) => value || '—' }, { title: '状态', dataIndex: 'status', render: (value: Position['status']) => <Tag color={value === 'active' ? 'green' : 'default'}>{value === 'active' ? '启用' : '停用'}</Tag> },
      { title: '操作', render: (_: unknown, position: Position) => canManage ? <Space><Button type="link" onClick={() => { setError(null); setEditing(position); }}>编辑</Button><Button type="link" loading={save.isPending} onClick={() => { setError(null); save.mutate({ current: position, input: { name: position.name, code: position.code, description: position.description, sortOrder: position.sortOrder, status: position.status === 'active' ? 'inactive' : 'active' } }); }}>{position.status === 'active' ? '停用' : '启用'}</Button><Popconfirm title="删除岗位？被员工引用时服务端会拒绝删除。" onConfirm={() => remove.mutate(position)}><Button danger type="link">删除</Button></Popconfirm></Space> : null },
    ]} />}</Card>{editing !== null && <PositionDialog current={editing} busy={save.isPending} onCancel={() => setEditing(null)} onSave={(input) => save.mutate({ current: editing, input })} />}</div>;
}

function PositionDialog({ current, busy, onCancel, onSave }: { current: Position | 'new'; busy: boolean; onCancel: () => void; onSave: (input: PositionInput) => void }): ReactNode {
  const form = useForm<PositionForm>({ resolver: zodResolver(positionFormSchema), defaultValues: current === 'new' ? { name: '', code: '', description: '', sortOrder: 0, status: 'active' } : { name: current.name, code: current.code, description: current.description, sortOrder: current.sortOrder, status: current.status } });
  return <Modal title={current === 'new' ? '新建岗位' : '编辑岗位'} open onCancel={onCancel} onOk={() => void form.handleSubmit(onSave)()} confirmLoading={busy} destroyOnClose>
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(onSave)(); }}><Space direction="vertical" style={{ width: '100%' }} size="middle">
      <Controller name="name" control={form.control} render={({ field, fieldState }) => <Form.Item label="岗位名称" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message} required><Input {...field} aria-label="岗位名称" maxLength={80} autoFocus /></Form.Item>} />
      <Controller name="code" control={form.control} render={({ field, fieldState }) => <Form.Item label="岗位编码" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message} required><Input {...field} aria-label="岗位编码" maxLength={64} /></Form.Item>} />
      <Controller name="description" control={form.control} render={({ field, fieldState }) => <Form.Item label="说明" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message}><Input.TextArea {...field} aria-label="岗位说明" maxLength={300} /></Form.Item>} />
      <Controller name="sortOrder" control={form.control} render={({ field, fieldState }) => <Form.Item label="排序" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message}><InputNumber aria-label="岗位排序" value={field.value} min={0} max={1000000} precision={0} onChange={(value) => field.onChange(value ?? 0)} /></Form.Item>} />
      <Controller name="status" control={form.control} render={({ field }) => <Form.Item label="状态"><Select aria-label="岗位状态" value={field.value} onChange={field.onChange} options={[{ value: 'active', label: '启用' }, { value: 'inactive', label: '停用' }]} /></Form.Item>} />
    </Space></form>
  </Modal>;
}
