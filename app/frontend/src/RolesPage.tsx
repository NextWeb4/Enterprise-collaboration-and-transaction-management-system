import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { DATA_SCOPES, PERMISSION_CATALOG } from '@collab/shared/permissions.js';
import type { DataScope } from '@collab/shared/permissions.js';
import { createRole, deleteRole, getEffectivePermissions, listAllAccounts, listAllRoles, replaceUserRoles, updateRole } from './api';
import type { Account, EffectivePermissions, Role } from './api';

interface RoleFormValues { code: string; name: string; description: string; dataScope: DataScope; permissionCodes: string[] }
const scopeLabels: Record<DataScope, string> = { self: '本人', department: '本部门', department_tree: '本部门及下级', all: '全部' };
const permissionLabels = new Map(PERMISSION_CATALOG.map((permission) => [permission.code, `${permission.name} (${permission.code})`]));

export function RolesPage({ identity }: { identity: MeResponse }): ReactNode {
  const canManageRoles = identity.permissions.includes('role:manage');
  const canAssignRoles = canManageRoles && identity.permissions.includes('user:manage');
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [effective, setEffective] = useState<EffectivePermissions | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | undefined>();
  const [assignedRoleIds, setAssignedRoleIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form] = Form.useForm<RoleFormValues>();

  const refreshRoles = async (): Promise<void> => setRoles(await listAllRoles());
  const refreshEffective = async (userId: string): Promise<void> => {
    const current = await getEffectivePermissions(userId);
    setEffective(current);
    setAssignedRoleIds(current.roleIds);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([listAllRoles(), canAssignRoles ? listAllAccounts().catch(() => []) : Promise.resolve([])]).then(([roleItems, accountItems]) => {
      if (!active) return;
      setRoles(roleItems);
      setAccounts(accountItems);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : '角色列表加载失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [canAssignRoles]);

  const effectiveRoleIds = useMemo(() => new Set(assignedRoleIds), [assignedRoleIds]);
  const pendingPermissions = useMemo(() => [...new Set((roles ?? []).filter((role) => effectiveRoleIds.has(role.id)).flatMap((role) => role.permissionCodes))], [roles, effectiveRoleIds]);

  const openEditor = (role: Role | 'new'): void => {
    setEditing(role);
    form.setFieldsValue(role === 'new'
      ? { code: '', name: '', description: '', dataScope: 'self', permissionCodes: [] }
      : { code: role.code, name: role.name, description: role.description, dataScope: role.dataScope, permissionCodes: role.permissionCodes });
  };

  const saveRole = async (values: RoleFormValues): Promise<void> => {
    setBusy(true); setError(null);
    try {
      if (editing === 'new') await createRole({ ...values, code: values.code.trim(), name: values.name.trim(), description: values.description.trim() });
      else if (editing) await updateRole(editing.id, { ...values, name: values.name.trim(), description: values.description.trim(), version: editing.version });
      setEditing(null);
      await refreshRoles();
    } catch (err) { setError(err instanceof Error ? err.message : '保存角色失败'); }
    finally { setBusy(false); }
  };

  const saveAssignment = async (): Promise<void> => {
    if (!effective || !selectedUserId || selectedUserId === identity.user.id) return;
    setBusy(true); setError(null);
    try {
      await replaceUserRoles(selectedUserId, assignedRoleIds, effective.version);
      await refreshEffective(selectedUserId);
    } catch (err) { setError(err instanceof Error ? err.message : '角色分配失败'); }
    finally { setBusy(false); }
  };

  if (!canManageRoles) return <Alert type="warning" showIcon message="没有管理角色的权限" />;

  return <div className="page-stack">
    <div className="page-heading"><div><Typography.Title level={2}>角色与权限</Typography.Title><Typography.Text type="secondary">管理角色配置及账号角色分配。</Typography.Text></div><Button type="primary" onClick={() => openEditor('new')}>新建角色</Button></div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    <Card title="角色列表" extra={<Button onClick={() => { setLoading(true); void refreshRoles().catch((err: unknown) => setError(err instanceof Error ? err.message : '角色列表加载失败')).finally(() => setLoading(false)); }}>刷新</Button>}>
      {loading ? <Spin /> : roles?.length === 0 ? <Empty description="暂无角色" /> : <Table<Role> rowKey="id" dataSource={roles ?? []} pagination={{ pageSize: 20 }} columns={[
        { title: '角色', dataIndex: 'name' },
        { title: '角色编码', dataIndex: 'code' },
        { title: '数据范围', render: (_: unknown, role: Role) => scopeLabels[role.dataScope] },
        { title: '权限数', render: (_: unknown, role: Role) => role.permissionCodes.length },
        { title: '类型', render: (_: unknown, role: Role) => role.system ? <Tag>系统</Tag> : <Tag color="blue">自定义</Tag> },
        { title: '操作', render: (_: unknown, role: Role) => role.system ? <Typography.Text type="secondary">不可修改</Typography.Text> : <Space><Button type="link" onClick={() => openEditor(role)}>编辑</Button><Popconfirm title={`删除角色“${role.name}”？`} onConfirm={() => { setBusy(true); void deleteRole(role.id, role.version).then(refreshRoles).catch((err: unknown) => setError(err instanceof Error ? err.message : '删除角色失败')).finally(() => setBusy(false)); }}><Button type="link" danger loading={busy}>删除</Button></Popconfirm></Space> },
      ]} />}
    </Card>
    {canAssignRoles && <Card title="账号角色分配">
      <Form layout="vertical">
        <Form.Item label="内部账号"><Select aria-label="内部账号" showSearch optionFilterProp="label" allowClear value={selectedUserId} options={accounts.filter((account) => account.status === 'active').map((account) => ({ value: account.id, label: `${account.name} (${account.email})` }))} onChange={(userId: string | undefined) => { setSelectedUserId(userId); setEffective(null); if (userId) void refreshEffective(userId).catch((err: unknown) => setError(err instanceof Error ? err.message : '权限信息加载失败')); }} /></Form.Item>
        {selectedUserId && effective && <>
          {selectedUserId === identity.user.id && <Alert type="warning" showIcon message="不能直接修改自己的角色" />}
          <Form.Item label="分配角色"><Select mode="multiple" value={assignedRoleIds} options={(roles ?? []).map((role) => ({ value: role.id, label: `${role.name} (${role.code})` }))} onChange={(roleIds: string[]) => setAssignedRoleIds(roleIds)} disabled={selectedUserId === identity.user.id} /></Form.Item>
          <Typography.Paragraph type="secondary">当前有效权限：{effective.permissions.map((code) => permissionLabels.get(code) ?? code).join('、') || '无'}</Typography.Paragraph>
          <Typography.Paragraph>变更后权限：{pendingPermissions.map((code) => permissionLabels.get(code) ?? code).join('、') || '无'}</Typography.Paragraph>
          <Button type="primary" loading={busy} disabled={selectedUserId === identity.user.id || assignedRoleIds.length === 0 || (assignedRoleIds.length === effective.roleIds.length && assignedRoleIds.every((roleId) => effective.roleIds.includes(roleId)))} onClick={() => void saveAssignment()}>保存角色分配</Button>
        </>}
        {selectedUserId && !effective && <Spin />}
      </Form>
    </Card>}
    <Modal title={editing === 'new' ? '新建自定义角色' : `编辑角色 ${editing?.name ?? ''}`} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={busy} destroyOnHidden width={720}>
      <Form form={form} layout="vertical" onFinish={(values) => void saveRole(values)}>
        <Form.Item name="code" label="角色编码" rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,63}$/, message: '使用小写字母、数字和下划线，且以字母开头' }]}><Input disabled={editing !== 'new'} maxLength={64} /></Form.Item>
        <Form.Item name="name" label="角色名称" rules={[{ required: true, min: 2, max: 30 }]}><Input maxLength={30} /></Form.Item>
        <Form.Item name="description" label="说明" rules={[{ max: 300 }]}><Input.TextArea maxLength={300} /></Form.Item>
        <Form.Item name="dataScope" label="数据范围" rules={[{ required: true }]}><Select options={DATA_SCOPES.map((scope) => ({ value: scope, label: scopeLabels[scope] }))} /></Form.Item>
        <Form.Item name="permissionCodes" label="权限码" rules={[{ required: true, type: 'array', min: 1 }]}><Select mode="multiple" showSearch optionFilterProp="label" options={PERMISSION_CATALOG.map((permission) => ({ value: permission.code, label: `${permission.name} (${permission.code})` }))} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}
