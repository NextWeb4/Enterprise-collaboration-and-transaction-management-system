import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Form, Input, Spin, Switch, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { getSystemSettings, updateSystemSettings, type SystemSettings } from './system-api';

export function SystemSettingsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [settings, setSettings] = useState<SystemSettings | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [form] = Form.useForm<Pick<SystemSettings, 'displayName' | 'timezone'>>();
  const allowed = identity.permissions.includes('setting:manage');
  useEffect(() => { if (!allowed) return; let active = true; void getSystemSettings().then((value) => { if (active) { setSettings(value); form.setFieldsValue(value); } }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : '系统配置加载失败'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [allowed, form]);
  if (!allowed) return <Card><Alert type="warning" showIcon message="没有查看系统配置的权限" /></Card>;
  if (loading) return <div className="page-loading"><Spin /></div>;
  if (!settings) return <Alert type="error" showIcon message={error ?? '系统配置不可用'} />;
  return <div className="page-stack"><div className="page-heading"><div><Typography.Title level={2}>系统配置</Typography.Title><Typography.Text type="secondary">组织显示名和时区会即时用于后续页面展示与日期计算。</Typography.Text></div></div>{error && <Alert type="error" showIcon message={error} />}
    <Card title="组织基础配置"><Form form={form} layout="vertical" onFinish={(values) => { setBusy(true); setError(null); void updateSystemSettings({ ...values, version: settings.version }).then((value) => { setSettings(value); form.setFieldsValue(value); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '保存失败')).finally(() => setBusy(false)); }}>
      <Form.Item name="displayName" label="组织显示名" rules={[{ required: true, min: 2, max: 80 }]}><Input maxLength={80} /></Form.Item><Form.Item name="timezone" label="IANA 时区" extra="例如 Asia/Shanghai 或 Asia/Tokyo。" rules={[{ required: true, max: 80 }]}><Input maxLength={80} /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>保存配置</Button>
    </Form></Card><Card title="固定安全策略"><Form layout="vertical"><Form.Item label="允许自审批"><Switch checked={settings.workflowAllowSelfApproval} disabled checkedChildren="开启" unCheckedChildren="关闭" /></Form.Item></Form><Typography.Text type="secondary">自审批为固定关闭的安全策略，不能通过系统配置开启。</Typography.Text></Card></div>;
}
