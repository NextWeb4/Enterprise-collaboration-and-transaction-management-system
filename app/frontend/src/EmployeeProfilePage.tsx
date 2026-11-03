import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Card, Descriptions, Empty, Spin, Tag, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { listEmployees, type Employee } from './organization-directory-api';

export function EmployeeProfilePage({ identity }: { identity: MeResponse }): ReactNode {
  const [profile, setProfile] = useState<Employee | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!identity.permissions.includes('employee:read')) return; let active = true; void listEmployees().then((items) => { const mine = items.find((item) => item.userId === identity.user.id) ?? null; if (active) setProfile(mine); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '员工档案加载失败'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [identity.permissions, identity.user.id]);
  if (!identity.permissions.includes('employee:read')) return <Card><Alert type="warning" showIcon message="没有查看员工档案的权限" /></Card>;
  if (loading) return <div className="page-loading"><Spin /></div>;
  if (error) return <Alert type="error" showIcon message={error} />;
  if (!profile) return <Card><Empty description="尚未建立员工档案" /></Card>;
  return <div className="page-stack"><Typography.Title level={2}>我的员工档案</Typography.Title><Card><Descriptions column={{ xs: 1, sm: 2 }} items={[{ label: '姓名', children: profile.name }, { label: '内部账号', children: profile.email }, { label: '员工编号', children: profile.employeeNo ?? '未设置' }, { label: '部门', children: profile.departmentName ?? '未分配' }, { label: '岗位', children: profile.positionName ?? '未设置' }, { label: '联系电话', children: profile.phone ?? '未设置' }, { label: '入职日期', children: profile.hireDate ?? '未设置' }, { label: '状态', children: <Tag color={profile.status === 'active' ? 'green' : 'default'}>{profile.status === 'active' ? '在职' : '停用'}</Tag> }]} /></Card></div>;
}
