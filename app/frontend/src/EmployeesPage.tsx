import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { MeResponse } from '@collab/shared/schemas.js';
import { listDepartments } from './api';
import { createEmployee, listActiveUsers, listEmployees, listPositions, updateEmployee, type Employee, type EmployeeInput } from './organization-directory-api';

const employeeFormSchema = z.object({
  userId: z.string().min(1, '请选择在职账号'), employeeNo: z.string().trim().max(64, '员工编号最多 64 字'), phone: z.string().trim().refine((value) => value === '' || (value.length >= 3 && value.length <= 40), '联系电话为 3–40 字'), departmentId: z.string().nullable(), positionId: z.string().nullable(), managerId: z.string().nullable(), hireDate: z.string().nullable(),
});
type EmployeeForm = z.infer<typeof employeeFormSchema>;
function failureText(error: unknown): string { return error instanceof Error ? error.message : '员工档案操作失败'; }

export function EmployeesPage({ identity }: { identity: MeResponse }): ReactNode {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><EmployeesWorkspace identity={identity} /></QueryClientProvider>;
}

function EmployeesWorkspace({ identity }: { identity: MeResponse }): ReactNode {
  const client = useQueryClient(); const [editing, setEditing] = useState<Employee | 'new' | null>(null); const [error, setError] = useState<string | null>(null);
  const canRead = identity.permissions.includes('employee:read'); const canManage = identity.permissions.includes('employee:manage');
  const employees = useQuery({ queryKey: ['employees'], queryFn: listEmployees, enabled: canRead });
  const accounts = useQuery({ queryKey: ['organization-active-users'], queryFn: listActiveUsers, enabled: canRead && canManage });
  const departments = useQuery({ queryKey: ['departments'], queryFn: listDepartments, enabled: canRead && canManage && identity.permissions.includes('department:read') });
  const positions = useQuery({ queryKey: ['positions'], queryFn: listPositions, enabled: canRead && canManage && identity.permissions.includes('position:read') });
  const save = useMutation({ mutationFn: async ({ current, input }: { current: Employee | 'new'; input: EmployeeInput }) => current === 'new' ? createEmployee(input) : updateEmployee(current.id, { ...input, version: current.version }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ['employees'] }); setEditing(null); }, onError: (reason: unknown) => setError(failureText(reason)) });
  if (!canRead) return <Card><Alert type="warning" showIcon message="没有查看员工档案的权限" /></Card>;
  const dependenciesReady = !accounts.isLoading && !departments.isLoading && !positions.isLoading;
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>员工管理</Typography.Title><Typography.Text type="secondary">维护员工档案、部门、岗位与直属上级。账号状态由账号管理维护。</Typography.Text></div>{canManage && <Button type="primary" disabled={!dependenciesReady} onClick={() => { setError(null); setEditing('new'); }}>新建员工档案</Button>}</div>
    {(error || employees.error || accounts.error || departments.error || positions.error) && <Alert type="error" showIcon message={error ?? failureText(employees.error ?? accounts.error ?? departments.error ?? positions.error)} closable onClose={() => setError(null)} />}
    <Card>{employees.isLoading ? <div className="page-loading"><Spin /></div> : (employees.data ?? []).length === 0 ? <Empty description="暂无员工档案" /> : <Table rowKey="id" dataSource={employees.data} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 900 }} columns={[
      { title: '姓名', dataIndex: 'name' }, { title: '内部账号', dataIndex: 'email' }, { title: '员工编号', dataIndex: 'employeeNo', render: (value: string | null) => value ?? '—' }, { title: '部门', dataIndex: 'departmentName', render: (value: string | null) => value ?? '未分配' }, { title: '岗位', dataIndex: 'positionName', render: (value: string | null) => value ?? '未设置' }, { title: '联系电话', dataIndex: 'phone', render: (value: string | null) => value ?? '—' }, { title: '状态', dataIndex: 'status', render: (value: Employee['status']) => <Tag color={value === 'active' ? 'green' : 'default'}>{value === 'active' ? '在职' : '停用'}</Tag> }, { title: '操作', render: (_: unknown, employee: Employee) => canManage ? <Button type="link" onClick={() => { setError(null); setEditing(employee); }}>编辑</Button> : null },
    ]} />}</Card>
    {editing !== null && <EmployeeDialog current={editing} accounts={accounts.data ?? []} departments={departments.data ?? []} positions={positions.data ?? []} busy={save.isPending} onCancel={() => setEditing(null)} onSave={(input) => save.mutate({ current: editing, input })} />}
  </div>;
}

function EmployeeDialog({ current, accounts, departments, positions, busy, onCancel, onSave }: { current: Employee | 'new'; accounts: Awaited<ReturnType<typeof listActiveUsers>>; departments: Awaited<ReturnType<typeof listDepartments>>; positions: Awaited<ReturnType<typeof listPositions>>; busy: boolean; onCancel: () => void; onSave: (input: EmployeeInput) => void }): ReactNode {
  const form = useForm<EmployeeForm>({ resolver: zodResolver(employeeFormSchema), defaultValues: current === 'new' ? { userId: '', employeeNo: '', phone: '', departmentId: null, positionId: null, managerId: null, hireDate: null } : { userId: current.userId, employeeNo: current.employeeNo ?? '', phone: current.phone ?? '', departmentId: current.departmentId, positionId: current.positionId, managerId: current.managerId, hireDate: current.hireDate } });
  const submit = (values: EmployeeForm): void => onSave({ userId: values.userId, employeeNo: emptyToNull(values.employeeNo), phone: emptyToNull(values.phone), departmentId: values.departmentId, positionId: values.positionId, managerId: values.managerId, hireDate: values.hireDate, avatarFileId: null });
  const selectedUserId = useWatch({ control: form.control, name: 'userId' });
  const accountOptions = accounts.map((account) => ({ value: account.userId, label: account.name })); const managerOptions = accounts.filter((account) => account.userId !== selectedUserId).map((account) => ({ value: account.userId, label: account.name }));
  const positionOptions = positions.filter((position) => position.status === 'active' || position.id === currentPositionId(current)).map((position) => ({ value: position.id, label: `${position.name}（${position.code}）` }));
  return <Modal title={current === 'new' ? '新建员工档案' : `编辑员工档案：${current.name}`} open onCancel={onCancel} onOk={() => void form.handleSubmit(submit)()} confirmLoading={busy} destroyOnClose width={720}>
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(submit)(); }}><Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Controller name="userId" control={form.control} render={({ field, fieldState }) => <Form.Item label="在职账号" required validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message}><Select aria-label="在职账号" value={field.value} onChange={field.onChange} options={accountOptions} disabled={current !== 'new'} showSearch optionFilterProp="label" /></Form.Item>} />
      <Controller name="employeeNo" control={form.control} render={({ field, fieldState }) => <Form.Item label="员工编号" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message}><Input {...field} aria-label="员工编号" maxLength={64} /></Form.Item>} />
      <Controller name="phone" control={form.control} render={({ field, fieldState }) => <Form.Item label="联系电话" validateStatus={fieldState.error ? 'error' : undefined} help={fieldState.error?.message}><Input {...field} aria-label="联系电话" maxLength={40} /></Form.Item>} />
      <Controller name="departmentId" control={form.control} render={({ field }) => <Form.Item label="所属部门"><Select aria-label="所属部门" value={field.value ?? undefined} onChange={(value: string | undefined) => field.onChange(value ?? null)} allowClear options={departments.map((department) => ({ value: department.id, label: department.name }))} showSearch optionFilterProp="label" /></Form.Item>} />
      <Controller name="positionId" control={form.control} render={({ field }) => <Form.Item label="岗位"><Select aria-label="岗位" value={field.value ?? undefined} onChange={(value: string | undefined) => field.onChange(value ?? null)} allowClear options={positionOptions} showSearch optionFilterProp="label" /></Form.Item>} />
      <Controller name="managerId" control={form.control} render={({ field }) => <Form.Item label="直属上级"><Select aria-label="直属上级" value={field.value ?? undefined} onChange={(value: string | undefined) => field.onChange(value ?? null)} allowClear options={managerOptions} showSearch optionFilterProp="label" /></Form.Item>} />
      <Controller name="hireDate" control={form.control} render={({ field }) => <Form.Item label="入职日期"><Input aria-label="入职日期" type="date" value={field.value ?? ''} onChange={(event) => field.onChange(event.target.value || null)} /></Form.Item>} />
      <Alert type="info" showIcon message="头像暂不支持上传或绑定" description="当前版本没有文件授权和引用计数闭环；请勿通过接口提交 avatarFileId。" />
    </Space></form>
  </Modal>;
}

function emptyToNull(value: string): string | null { const trimmed = value.trim(); return trimmed === '' ? null : trimmed; }
function currentPositionId(current: Employee | 'new'): string | null { return current === 'new' ? null : current.positionId; }
