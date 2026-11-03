import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Card, Empty, Input, Spin, Table, Tag, Typography } from 'antd';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@collab/shared/schemas.js';
import { listDirectory, type DirectoryEntry } from './organization-directory-api';

function failureText(error: unknown): string { return error instanceof Error ? error.message : '通讯录加载失败'; }

export function OrganizationDirectoryPage({ identity }: { identity: MeResponse }): ReactNode {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}><OrganizationDirectoryWorkspace identity={identity} /></QueryClientProvider>;
}

function OrganizationDirectoryWorkspace({ identity }: { identity: MeResponse }): ReactNode {
  const [keyword, setKeyword] = useState('');
  const canRead = identity.permissions.includes('organization:directory:read');
  const directory = useQuery({ queryKey: ['organization-directory'], queryFn: listDirectory, enabled: canRead });
  if (!canRead) return <Card><Alert type="warning" showIcon message="没有查看通讯录的权限" /></Card>;
  const normalized = keyword.trim().toLocaleLowerCase();
  const items = (directory.data ?? []).filter((item) => normalized === '' || [item.name, item.email, item.departmentName ?? '', item.positionName ?? ''].some((value) => value.toLocaleLowerCase().includes(normalized)));
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>组织通讯录</Typography.Title><Typography.Text type="secondary">按姓名、内部账号、部门或岗位搜索当前可见成员。</Typography.Text></div></div>{directory.error && <Alert type="error" showIcon message={failureText(directory.error)} />}
    <Card><Input.Search aria-label="搜索通讯录" placeholder="搜索姓名、内部账号、部门或岗位" allowClear onChange={(event) => setKeyword(event.target.value)} style={{ maxWidth: 360, marginBottom: 16 }} />
      {directory.isLoading ? <div className="page-loading"><Spin /></div> : items.length === 0 ? <Empty description={normalized === '' ? '暂无可见成员' : '没有符合条件的成员'} /> : <Table rowKey="id" dataSource={items} pagination={{ pageSize: 20, showSizeChanger: false }} columns={[
        { title: '姓名', dataIndex: 'name' }, { title: '内部账号', dataIndex: 'email' }, { title: '部门', dataIndex: 'departmentName', render: (value: string | null) => value ?? '未分配' }, { title: '岗位', dataIndex: 'positionName', render: (value: string | null) => value ?? '未设置' }, { title: '状态', dataIndex: 'status', render: (value: DirectoryEntry['status']) => <Tag color={value === 'active' ? 'green' : 'default'}>{value === 'active' ? '在职' : '停用'}</Tag> },
      ]} />}
    </Card></div>;
}
