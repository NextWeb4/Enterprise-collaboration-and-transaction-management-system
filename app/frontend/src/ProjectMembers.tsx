import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Form, Modal, Popconfirm, Select, Space, Spin, Table } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { addProjectMember, getProject, listAllAccounts, listProjectMembers, removeProjectMember, transferProjectOwner, updateProjectMember } from './api';
import type { Account, Project, ProjectMember } from './api';

const labels: Record<ProjectMember['role'], string> = { owner: '负责人', manager: '经理', member: '成员', viewer: '只读成员' };
export function ProjectMembers({ project, identity, onProjectChanged }: { project: Project; identity: MeResponse; onProjectChanged: (project: Project) => void }): ReactNode {
  const [members, setMembers] = useState<ProjectMember[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectMember | null>(null);
  const [form] = Form.useForm<{ userId: string; role: 'manager' | 'member' | 'viewer' }>();
  const [roleForm] = Form.useForm<{ role: 'manager' | 'member' | 'viewer' }>();
  const can = (permission: string): boolean => identity.permissions.includes(permission);
  const refresh = async (): Promise<void> => { setMembers(await listProjectMembers(project.id)); };
  useEffect(() => {
    let active = true;
    void listProjectMembers(project.id).then((items) => { if (active) setMembers(items); }).catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '成员加载失败'); });
    return () => { active = false; };
  }, [project.id]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const writable = !['completed', 'cancelled', 'archived'].includes(project.status);
  return <Card title="项目成员" extra={writable && can('project:member:manage') && can('user:manage') ? <Button onClick={() => void run(async () => { setAccounts(await listAllAccounts()); setAdding(true); })}>添加成员</Button> : null}>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    {members === null ? error ? null : <Spin /> : <Table rowKey="userId" dataSource={members} pagination={false} columns={[
      { title: '姓名', dataIndex: 'name' }, { title: '项目角色', render: (_: unknown, member: ProjectMember) => labels[member.role] },
      { title: '操作', render: (_: unknown, member: ProjectMember) => <Space wrap>
        {writable && member.role !== 'owner' && can('project:owner:transfer') && <Popconfirm title={`将负责人转让给 ${member.name}？`} onConfirm={() => void run(async () => { const updated = await transferProjectOwner(project.id, member, project.version); onProjectChanged(updated); await refresh(); })}><Button type="link" loading={busy}>转让负责人</Button></Popconfirm>}
        {writable && member.role !== 'owner' && can('project:member:manage') && <Button type="link" onClick={() => { setEditing(member); roleForm.setFieldsValue({ role: member.role as 'manager' | 'member' | 'viewer' }); }}>修改角色</Button>}
        {writable && member.role !== 'owner' && can('project:member:manage') && <Popconfirm title={`移除 ${member.name}？`} onConfirm={() => void run(async () => { await removeProjectMember(project.id, member); await refresh(); onProjectChanged(await getProject(project.id)); })}><Button type="link" danger loading={busy}>移除</Button></Popconfirm>}
      </Space> },
    ]} />}
    <Modal title="添加项目成员" open={adding} onCancel={() => setAdding(false)} onOk={() => form.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={form} layout="vertical" initialValues={{ role: 'member' }} onFinish={(values) => void run(async () => { await addProjectMember(project.id, values); setAdding(false); form.resetFields(); await refresh(); })}>
        <Form.Item name="userId" label="内部账号" rules={[{ required: true }]}><Select showSearch optionFilterProp="label" options={accounts.filter((account) => account.status === 'active' && !members?.some((member) => member.userId === account.id)).map((account) => ({ value: account.id, label: `${account.name} (${account.email})` }))} /></Form.Item>
        <Form.Item name="role" label="项目角色" rules={[{ required: true }]}><Select options={[{ value: 'manager', label: '经理' }, { value: 'member', label: '成员' }, { value: 'viewer', label: '只读成员' }]} /></Form.Item>
      </Form>
    </Modal>
    <Modal title={`修改 ${editing?.name ?? ''} 的角色`} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => roleForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={roleForm} layout="vertical" onFinish={(values) => void run(async () => { if (!editing) return; await updateProjectMember(project.id, editing, values.role); setEditing(null); await refresh(); })}>
        <Form.Item name="role" label="项目角色" rules={[{ required: true }]}><Select options={[{ value: 'manager', label: '经理' }, { value: 'member', label: '成员' }, { value: 'viewer', label: '只读成员' }]} /></Form.Item>
      </Form>
    </Modal>
  </Card>;
}
