import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, Modal, Popconfirm, Space, Table, Tag, Typography } from 'antd';
import type { Account, PageResponse } from './api';
import { createUser, disableAccount, listAccounts } from './api';
import { enableAccount, forceLogoutAccount, resetAccountPassword } from './account-lifecycle-api';

interface CreateAccountValues { name: string; email: string; password: string; confirm: string }

export function AccountsPage({ permissions = [], currentUserId }: { permissions?: readonly string[]; currentUserId?: string } = {}): ReactNode {
  const [form] = Form.useForm<CreateAccountValues>();
  const [result, setResult] = useState<PageResponse<Account> | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [resetResult, setResetResult] = useState<{ account: string; password: string } | null>(null);
  useEffect(() => {
    let active = true;
    void listAccounts(page, pageSize).then((response) => { if (active) setResult(response); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '账号列表加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [page, pageSize, reload]);

  const submit = async (values: CreateAccountValues): Promise<void> => {
    setError(null); setSuccess(null); setBusyId('create');
    try {
      if (values.password !== values.confirm) throw new Error('两次输入的密码不一致');
      await createUser({ name: values.name, email: values.email, password: values.password });
      form.resetFields(); setSuccess(`账号 ${values.email} 已创建`); setLoading(true); setPage(1); setReload((value) => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : '创建账号失败'); }
    finally { setBusyId(null); }
  };
  const disable = async (account: Account): Promise<void> => {
    setBusyId(account.id); setError(null); setSuccess(null);
    try {
      await disableAccount(account.id, account.version);
      setSuccess(`账号 ${account.email} 已停用`); setLoading(true); setReload((value) => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : '停用账号失败'); }
    finally { setBusyId(null); }
  };
  const manage = async (account: Account, action: 'enable' | 'reset' | 'logout'): Promise<void> => {
    setBusyId(account.id); setError(null); setSuccess(null); setResetResult(null);
    try {
      if (action === 'enable') { await enableAccount(account.id, account.version); setSuccess(`账号 ${account.email} 已启用，请重新登录`); }
      if (action === 'reset') { const result = await resetAccountPassword(account.id, account.version); setResetResult({ account: account.email, password: result.temporaryPassword }); }
      if (action === 'logout') { const result = await forceLogoutAccount(account.id, account.version); setSuccess(`已撤销 ${account.email} 的 ${result.revokedSessions} 个会话`); }
      setLoading(true); setReload((value) => value + 1);
    } catch (err) { setError(err instanceof Error ? err.message : '账号操作失败'); }
    finally { setBusyId(null); }
  };

  return <div className="page-stack">
    <div className="page-heading"><div><Typography.Title level={2}>内部账号</Typography.Title><Typography.Text type="secondary">管理内部登录账号。</Typography.Text></div></div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    {success && <Alert type="success" showIcon message={success} closable onClose={() => setSuccess(null)} />}
    <Card title="添加内部账号"><Typography.Paragraph type="secondary">新成员首次登录后需要修改初始密码。</Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={submit}>
        <Form.Item name="name" label="姓名" rules={[{ required: true, min: 1, max: 120 }]}><Input autoComplete="name" /></Form.Item>
        <Form.Item name="email" label="内部账号" rules={[{ required: true, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/, message: '账号需为 3–64 位字母、数字、点、下划线或连字符' }]}><Input autoComplete="off" /></Form.Item>
        <Form.Item name="password" label="初始密码" rules={[{ required: true, min: 12, max: 128, message: '密码需为 12–128 位' }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Form.Item name="confirm" label="确认初始密码" rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
        <Button type="primary" htmlType="submit" loading={busyId === 'create'}>创建账号</Button>
      </Form>
    </Card>
    <Modal title="新临时密码（仅显示本次）" open={resetResult !== null} onCancel={() => setResetResult(null)} footer={<Button type="primary" onClick={() => setResetResult(null)}>已妥善保存</Button>} destroyOnHidden>
      {resetResult && <><Typography.Paragraph>账号：{resetResult.account}。原会话已撤销；首次登录必须修改密码。</Typography.Paragraph><Input.Password aria-label="新临时密码" value={resetResult.password} readOnly autoComplete="off" /><Typography.Paragraph type="secondary">关闭后无法再次查询，请通过可信渠道交付本人。</Typography.Paragraph></>}
    </Modal>
    <Card title="账号列表" extra={<Button onClick={() => { setLoading(true); setReload((value) => value + 1); }}>刷新</Button>}>
      {result && result.meta.total === 0 && !loading ? <Empty description="暂无内部账号" /> : <Table<Account> rowKey="id" loading={loading} dataSource={result?.data ?? []} pagination={{ current: page, pageSize, total: result?.meta.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100], showTotal: (total) => `共 ${total} 个账号`, onChange: (nextPage, nextPageSize) => { setLoading(true); setPage(nextPage); setPageSize(nextPageSize); } }} columns={[
        { title: '姓名', dataIndex: 'name' }, { title: '内部账号', dataIndex: 'email' },
        { title: '状态', render: (_: unknown, account: Account) => <Tag color={account.status === 'active' ? 'green' : 'default'}>{account.status === 'active' ? '正常' : '已停用'}</Tag> },
        { title: '操作', render: (_: unknown, account: Account) => <Space wrap>
          {account.status === 'active' ? <>
            <Popconfirm title={`停用 ${account.email}？`} description="该账号的现有登录会话将同时失效。" onConfirm={() => void disable(account)}><Button type="link" danger disabled={account.id === currentUserId || busyId !== null} loading={busyId === account.id}>停用</Button></Popconfirm>
            <Popconfirm title={`重置 ${account.email} 的密码？`} description="生成临时密码并立即撤销全部会话。" onConfirm={() => void manage(account, 'reset')}><Button type="link" disabled={account.id === currentUserId || busyId !== null}>重置密码</Button></Popconfirm>
          </> : <Popconfirm title={`启用 ${account.email}？`} onConfirm={() => void manage(account, 'enable')}><Button type="link" disabled={busyId !== null}>启用</Button></Popconfirm>}
          {permissions.includes('session:manage') && <Popconfirm title={`强制 ${account.email} 下线？`} description="撤销全部会话，不修改密码。" onConfirm={() => void manage(account, 'logout')}><Button type="link" disabled={busyId !== null}>强制下线</Button></Popconfirm>}
        </Space> },
      ]} />}
    </Card>
  </div>;
}
