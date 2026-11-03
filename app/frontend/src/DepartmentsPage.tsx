import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Select, Spin, Table, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { createDepartment, listAllAccounts, listDepartments, updateDepartment } from './api';
import type { Account, Department, DepartmentInput } from './api';

export function DepartmentsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [departments, setDepartments] = useState<Department[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Department | 'new' | null>(null);
  const [form] = Form.useForm<DepartmentInput>();
  const canRead = identity.permissions.includes('department:read');
  const canManage = identity.permissions.includes('department:manage');
  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void listDepartments().then((data) => { if (active) setDepartments(data); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '部门加载失败'); });
    return () => { active = false; };
  }, [canRead]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const edit = (department: Department | 'new'): void => {
    void run(async () => {
      if (identity.permissions.includes('user:manage')) setAccounts(await listAllAccounts());
      setEditing(department);
      form.setFieldsValue(department === 'new' ? { name: '', code: null, parentId: null, managerId: null, description: '', sortOrder: 0 } : department);
    });
  };
  if (!canRead) return <Alert type="warning" showIcon message="没有查看部门的权限" />;
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>组织架构</Typography.Title><Typography.Text type="secondary">维护部门及上下级关系。</Typography.Text></div>{canManage && <Button type="primary" onClick={() => edit('new')}>新建部门</Button>}</div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    <Card title="部门列表">{departments === null ? error ? null : <Spin /> : departments.length === 0 ? <Empty description="暂无部门" /> : <Table rowKey="id" dataSource={departments} pagination={{ pageSize: 20 }} columns={[
      { title: '部门名称', dataIndex: 'name' }, { title: '编码', render: (_: unknown, department: Department) => department.code || '—' },
      { title: '上级部门', render: (_: unknown, department: Department) => departments.find((item) => item.id === department.parentId)?.name ?? '无' },
      { title: '操作', render: (_: unknown, department: Department) => canManage ? <Button type="link" onClick={() => edit(department)}>编辑</Button> : null },
    ]} />}</Card>
    <Modal title={editing === 'new' ? '新建部门' : '编辑部门'} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={(values) => void run(async () => { if (!editing) return; const data: DepartmentInput = { ...values, code: values.code || null, parentId: values.parentId || null, managerId: values.managerId || null, description: values.description || '', sortOrder: values.sortOrder ?? 0 }; if (editing === 'new') await createDepartment(data); else await updateDepartment(editing.id, { ...data, version: editing.version }); setEditing(null); setDepartments(await listDepartments()); })}>
        <Form.Item name="name" label="部门名称" rules={[{ required: true, min: 1, max: 80 }]}><Input /></Form.Item>
        <Form.Item name="code" label="部门编码"><Input maxLength={64} /></Form.Item>
        <Form.Item name="parentId" label="上级部门"><Select allowClear options={(departments ?? []).filter((item) => editing === 'new' || item.id !== editing?.id).map((item) => ({ value: item.id, label: item.name }))} /></Form.Item>
        <Form.Item name="managerId" label="部门负责人"><Select allowClear disabled={!identity.permissions.includes('user:manage')} options={accounts.filter((account) => account.status === 'active').map((account) => ({ value: account.id, label: `${account.name} (${account.email})` }))} /></Form.Item>
        <Form.Item name="description" label="描述"><Input.TextArea maxLength={300} /></Form.Item><Form.Item name="sortOrder" label="排序" rules={[{ type: 'number', min: 0, max: 1000000 }]}><InputNumber min={0} max={1000000} precision={0} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}
