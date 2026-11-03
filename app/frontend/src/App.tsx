import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  BrowserRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Descriptions,
  Empty,
  Layout,
  Menu,
  Result,
  Spin,
  Tag,
  Typography,
  Form,
  Input,
} from 'antd';
import {
  AppstoreOutlined,
  CalendarOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  ProjectOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  LogoutOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MeResponse, WorkbenchResponse } from '@collab/shared/schemas.js';
import {
  changePassword,
  health,
  login,
  logout,
  me,
  readBootstrapStorage,
  setupAdmin,
  setupStatus,
  workbench,
  writeBootstrapStorage,
  type BootstrapStorageResponse,
  type HealthResponse,
} from './api';
import { GlobalErrorBoundary } from './GlobalErrorBoundary';
import { greetingForTime } from './greeting';
import { ProjectsPage } from './ProjectsPage';
import { DepartmentsPage } from './DepartmentsPage';
import { AccountsPage } from './AccountsPage';
import { RolesPage } from './RolesPage';
import { AnalyticsPage } from './AnalyticsPage';
import { CalendarPage } from './CalendarPage';
import { DocumentsPage } from './DocumentsPage';
import { ApprovalsPage } from './ApprovalsPage';
import { OrganizationDirectoryPage } from './OrganizationDirectoryPage';
import { EmployeesPage } from './EmployeesPage';
import { EmployeeProfilePage } from './EmployeeProfilePage';
import { PositionsPage } from './PositionsPage';
import { SystemLogsPage } from './SystemLogsPage';
import { SystemSettingsPage } from './SystemSettingsPage';
import { WorkbenchPanels, MyTasksPage, NotificationsPage, NotificationBell } from './WorkbenchPanels';

const { Header, Sider, Content } = Layout;

export function App(): ReactNode {
  return (
    <GlobalErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<BootstrapPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/app/*" element={<ProtectedLayout />} />
          <Route path="*" element={<BootstrapPage />} />
        </Routes>
      </BrowserRouter>
    </GlobalErrorBoundary>
  );
}

function BootstrapPage(): ReactNode {
  const navigate = useNavigate();
  const [healthState, setHealthState] = useState<HealthResponse | null>(null);
  const [recordState, setRecordState] = useState<BootstrapStorageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [writing, setWriting] = useState(false);

  const load = async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const [healthResult, recordResult] = await Promise.all([health(), readBootstrapStorage()]);
      setHealthState(healthResult);
      setRecordState(recordResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法连接后端');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    void setupStatus()
      .then((result) => {
        if (result.required) navigate('/login', { replace: true });
      })
      .catch(() => undefined);
  }, [navigate]);

  const writeAndRead = async (): Promise<void> => {
    setWriting(true);
    setError(null);
    try {
      setRecordState(
        await writeBootstrapStorage(`浏览器验证 ${new Date().toLocaleString('zh-CN')}`),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'LMDB 写入失败');
    } finally {
      setWriting(false);
    }
  };

  return (
    <main className="bootstrap-shell">
      <section className="bootstrap-panel" aria-labelledby="bootstrap-title">
        <div className="brand-mark">
          <DatabaseOutlined />
        </div>
        <Typography.Title id="bootstrap-title" level={1}>
          项目启动检查
        </Typography.Title>
        <Typography.Paragraph type="secondary">
          验证前端、后端和 LMDB 的最小运行闭环。
        </Typography.Paragraph>
        {error && <Alert type="error" showIcon message="连接失败" description={error} />}
        <div className="bootstrap-grid">
          <Card
            title="后端 API"
            loading={loading}
            extra={
              <Button type="text" aria-label="重新检查" onClick={() => void load()}>
                重新检查
              </Button>
            }
          >
            <div className="bootstrap-status">
              {healthState?.ok ? (
                <CheckCircleOutlined className="status-ok" />
              ) : (
                <span className="status-dot" />
              )}
              {healthState?.ok ? '已连接' : '等待连接'}
            </div>
            {healthState && (
              <Typography.Text type="secondary">
                LMDB schema v{healthState.storage.schemaVersion} ·{' '}
                {healthState.storage.writable ? '可写' : '只读'}
              </Typography.Text>
            )}
          </Card>
          <Card title="LMDB 读写" loading={loading}>
            <div className="bootstrap-status">
              {recordState?.record ? (
                <CheckCircleOutlined className="status-ok" />
              ) : (
                <span className="status-dot" />
              )}
              {recordState?.record ? '已有持久化记录' : '尚无验证记录'}
            </div>
            <Typography.Paragraph type="secondary">
              {recordState?.readBack?.message ??
                recordState?.record?.message ??
                '点击按钮写入一条 JSON，再从 Repository 读回。'}
            </Typography.Paragraph>
            {recordState?.readBack && (
              <Typography.Paragraph>
                读取结果：
                {recordState.readBack.id === recordState.record?.id
                  ? '与写入记录一致'
                  : '与写入记录不一致'}
              </Typography.Paragraph>
            )}
            <Button
              type="primary"
              aria-label="写入并读取"
              icon={<DatabaseOutlined />}
              loading={writing}
              disabled={!healthState?.ok}
              onClick={() => void writeAndRead()}
            >
              写入并读取
            </Button>
          </Card>
        </div>
        <Typography.Paragraph className="bootstrap-data-note" type="secondary">
          数据保存在开发启动配置的数据目录中。
        </Typography.Paragraph>
        <Button type="link" href="/app">
          进入现有工作台
        </Button>
      </section>
    </main>
  );
}

function LoginPage(): ReactNode {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [setup, setSetup] = useState<boolean | null>(null);
  useEffect(() => {
    void setupStatus()
      .then((result) => setSetup(result.required))
      .catch(() => setError('无法检查初始化状态，请确认后端已启动'));
  }, []);
  if (setup === null)
    return (
      <main className="login-shell">
        {error ? <Alert type="error" message={error} /> : <Spin />}
      </main>
    );
  if (setup) return <SetupPage onDone={() => setSetup(false)} />;
  const onFinish = async (values: { email: string; password: string }): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      await login(values);
      navigate('/app');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };
  return (
    <main className="login-shell">
      <Card className="login-card" bordered={false}>
        <div className="brand-mark">CO</div>
        <Typography.Title level={2}>企业协同与事务管理平台</Typography.Title>
        <Typography.Paragraph type="secondary">
          把工作、审批、文档和项目放在同一处。
        </Typography.Paragraph>
        {error && <Alert type="error" showIcon message={error} className="form-alert" />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="email"
            label="内部账号"
            rules={[{ required: true, message: '请输入内部账号' }]}
          >
            <Input autoComplete="username" size="large" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password autoComplete="current-password" size="large" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}

function SetupPage({ onDone }: { onDone: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (values: {
    name: string;
    email: string;
    password: string;
    confirm: string;
  }): Promise<void> => {
    if (values.password !== values.confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await setupAdmin({ name: values.name, email: values.email, password: values.password });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setLoading(false);
    }
  };
  return (
    <main className="login-shell">
      <Card className="login-card">
        <Typography.Title level={2}>设置首个管理员</Typography.Title>
        <Typography.Paragraph>首次部署时创建管理员，完成后请登录。</Typography.Paragraph>
        {error && <Alert type="error" message={error} />}
        <Form layout="vertical" onFinish={submit}>
          <Form.Item name="name" label="管理员姓名" rules={[{ required: true }]}>
            <Input autoComplete="name" />
          </Form.Item>
          <Form.Item
            name="email"
            label="内部账号"
            rules={[
              {
                required: true,
                pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/,
                message: '账号需为 3–64 位字母、数字、点、下划线或连字符',
              },
            ]}
          >
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item
            name="password"
            label="管理员密码"
            rules={[{ required: true, min: 12, max: 128, message: '密码需为 12–128 位' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="confirm" label="确认密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            创建管理员
          </Button>
        </Form>
      </Card>
    </main>
  );
}

function ProtectedLayout(): ReactNode {
  const navigate = useNavigate();
  const location = useLocation();
  const [identity, setIdentity] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void me()
      .then(setIdentity)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '会话已失效');
      });
  }, []);
  if (error) return <Navigate to="/login" replace />;
  if (!identity)
    return (
      <main className="loading-shell">
        <Spin size="large" />
      </main>
    );
  const onLogout = async (): Promise<void> => {
    await logout().catch(() => undefined);
    navigate('/login');
  };
  if (identity.user.mustChangePassword)
    return <PasswordChangePage onChanged={setIdentity} onLogout={() => void onLogout()} />;
  const menuItems = [
    { key: '/app', icon: <AppstoreOutlined />, label: <Link to="/app">工作台</Link> },
    { key: '/app/my-tasks', icon: <CheckCircleOutlined />, label: <Link to="/app/my-tasks">我的待办</Link> },
    { key: '/app/notifications', icon: <FileTextOutlined />, label: <Link to="/app/notifications">消息通知</Link> },
    {
      key: '/app/departments',
      icon: <TeamOutlined />,
      label: <Link to="/app/departments">组织架构</Link>,
      disabled: !identity.permissions.includes('department:read'),
    },
    {
      key: '/app/directory',
      icon: <TeamOutlined />,
      label: <Link to="/app/directory">组织通讯录</Link>,
      disabled: !identity.permissions.includes('organization:directory:read'),
    },
    {
      key: '/app/employees',
      icon: <UserOutlined />,
      label: <Link to="/app/employees">员工档案</Link>,
      disabled:
        !identity.permissions.includes('employee:read') &&
        !identity.permissions.includes('employee:manage'),
    },
    {
      key: '/app/profile',
      icon: <UserOutlined />,
      label: <Link to="/app/profile">我的档案</Link>,
      disabled: !identity.permissions.includes('employee:read'),
    },
    {
      key: '/app/positions',
      icon: <TeamOutlined />,
      label: <Link to="/app/positions">岗位管理</Link>,
      disabled: !identity.permissions.includes('position:read'),
    },
    {
      key: '/app/projects',
      icon: <ProjectOutlined />,
      label: <Link to="/app/projects">项目与任务</Link>,
      disabled: !identity.permissions.includes('project:read'),
    },
    {
      key: '/app/calendar',
      icon: <CalendarOutlined />,
      label: <Link to="/app/calendar">日程与会议</Link>,
      disabled: !identity.permissions.includes('calendar:read'),
    },
    {
      key: '/app/applications',
      icon: <SafetyCertificateOutlined />,
      label: <Link to="/app/applications">行政审批</Link>,
      disabled: !identity.permissions.some(
        (permission) =>
          permission.startsWith('application:') || permission === 'workflow:template:manage',
      ),
    },
    {
      key: '/app/documents',
      icon: <FileTextOutlined />,
      label: <Link to="/app/documents">文档中心</Link>,
      disabled: !identity.permissions.includes('document:read'),
    },
    {
      key: '/app/analytics',
      icon: <FileTextOutlined />,
      label: <Link to="/app/analytics">经营数据分析</Link>,
      disabled:
        !identity.permissions.includes('analytics:read:project') &&
        !identity.permissions.includes('analytics:read:all'),
    },
    {
      key: '/app/users',
      icon: <TeamOutlined />,
      label: <Link to="/app/users">内部账号</Link>,
      disabled: !identity.permissions.includes('user:manage'),
    },
    {
      key: '/app/roles',
      icon: <SafetyCertificateOutlined />,
      label: <Link to="/app/roles">角色与权限</Link>,
      disabled: !identity.permissions.includes('role:manage'),
    },
    {
      key: '/app/settings',
      icon: <UserOutlined />,
      label: <Link to="/app/settings">个人设置</Link>,
    },
    {
      key: '/app/system/settings',
      icon: <SettingOutlined />,
      label: <Link to="/app/system/settings">系统配置</Link>,
      disabled: !identity.permissions.includes('setting:manage'),
    },
    {
      key: '/app/system/logs',
      icon: <FileTextOutlined />,
      label: <Link to="/app/system/logs">系统日志</Link>,
      disabled:
        !identity.permissions.includes('login:read') &&
        !identity.permissions.includes('audit:read'),
    },
  ];
  return (
    <Layout className="app-shell">
      <Sider breakpoint="lg" collapsedWidth="0" theme="light">
        <div className="sider-brand">
          <span className="brand-mark small">CO</span>
          <span>协同平台</span>
        </div>
        <Menu mode="inline" selectedKeys={[location.pathname]} items={menuItems} />
      </Sider>
      <Layout>
        <Header className="app-header">
          <div>
            <Typography.Text strong>{identity.organization?.name ?? '我的组织'}</Typography.Text>
            <Tag color="green" className="header-tag">
              单组织
            </Tag>
          </div>
          <div className="header-user">
            {identity.permissions.includes('workbench:read') && <NotificationBell />}
            <Link className="header-profile" to="/app/settings" aria-label="个人设置">
              <Avatar size="small">{identity.user.name.slice(0, 1)}</Avatar>
              <span>{identity.user.name}</span>
            </Link>
            <Button
              type="text"
              icon={<LogoutOutlined />}
              aria-label="退出登录"
              onClick={() => void onLogout()}
            />
          </div>
        </Header>
        <Content className="app-content">
          <Routes>
            <Route index element={<WorkbenchPage />} />
            <Route path="my-tasks" element={<MyTasksPage />} />
            <Route path="notifications" element={<NotificationsPage />} />
            <Route path="departments" element={<DepartmentsPage identity={identity} />} />
            <Route path="directory" element={<OrganizationDirectoryPage identity={identity} />} />
            <Route path="employees" element={<EmployeesPage identity={identity} />} />
            <Route path="profile" element={<EmployeeProfilePage identity={identity} />} />
            <Route path="positions" element={<PositionsPage identity={identity} />} />
            <Route path="projects" element={<ProjectsPage identity={identity} />} />
            <Route path="calendar" element={<CalendarPage identity={identity} />} />
            <Route path="applications/*" element={<ApprovalsPage identity={identity} />} />
            <Route path="documents" element={<DocumentsPage identity={identity} />} />
            <Route
              path="settings"
              element={<PersonalSettingsPage identity={identity} onChanged={setIdentity} />}
            />
            <Route path="system/settings" element={<SystemSettingsPage identity={identity} />} />
            <Route path="system/logs" element={<SystemLogsPage identity={identity} />} />
            <Route
              path="users"
              element={
                identity.permissions.includes('user:manage') ? (
                  <AccountsPage
                    permissions={identity.permissions}
                    currentUserId={identity.user.id}
                  />
                ) : (
                  <Result status="403" title="无权管理账号" />
                )
              }
            />
            <Route
              path="roles"
              element={
                identity.permissions.includes('role:manage') ? (
                  <RolesPage identity={identity} />
                ) : (
                  <Result status="403" title="无权管理角色" />
                )
              }
            />
            <Route path="analytics" element={<AnalyticsPage identity={identity} />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

function PersonalSettingsPage(props: {
  identity: MeResponse;
  onChanged: (identity: MeResponse) => void;
}): ReactNode {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>个人设置</Typography.Title>
          <Typography.Text type="secondary">查看账号信息并更新登录密码。</Typography.Text>
        </div>
      </div>
      <Card title="账号信息">
        <Descriptions column={1} size="small">
          <Descriptions.Item label="姓名">{props.identity.user.name}</Descriptions.Item>
          <Descriptions.Item label="内部账号">{props.identity.user.email}</Descriptions.Item>
          <Descriptions.Item label="账号状态">
            {props.identity.user.status === 'active' ? '正常' : '停用'}
          </Descriptions.Item>
          <Descriptions.Item label="角色">
            {props.identity.roles.length > 0 ? props.identity.roles.join('、') : '未分配角色'}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      <PasswordChangeForm onChanged={props.onChanged} />
    </div>
  );
}

function PasswordChangeForm(props: {
  onChanged: (identity: MeResponse) => void;
  onLogout?: () => void;
}): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const onFinish = async (values: {
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
  }): Promise<void> => {
    setError(null);
    if (values.newPassword !== values.confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setLoading(true);
    try {
      await changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      props.onChanged(await me());
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败');
    } finally {
      setLoading(false);
    }
  };
  return (
    <Card title={props.onLogout ? '首次登录安全设置' : '修改密码'}>
      <Typography.Paragraph type="secondary">
        {props.onLogout
          ? '这是首次登录的临时密码。修改后才能继续使用平台。'
          : '密码更新后将立即用于后续登录。'}
      </Typography.Paragraph>
      {error && <Alert type="error" showIcon message={error} className="form-alert" />}
      <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
        <Form.Item
          name="currentPassword"
          label="当前密码"
          rules={[{ required: true, message: '请输入当前密码' }]}
        >
          <Input.Password autoComplete="current-password" size="large" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="新密码"
          rules={[{ required: true, min: 12, max: 128, message: '新密码长度需为 12–128 个字符' }]}
        >
          <Input.Password autoComplete="new-password" size="large" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="确认新密码"
          rules={[{ required: true, message: '请再次输入新密码' }]}
        >
          <Input.Password autoComplete="new-password" size="large" />
        </Form.Item>
        <Button type="primary" htmlType="submit" size="large" block loading={loading}>
          修改密码
        </Button>
        {props.onLogout && (
          <Button type="text" block onClick={props.onLogout}>
            退出登录
          </Button>
        )}
      </Form>
    </Card>
  );
}

function PasswordChangePage(props: {
  onChanged: (identity: MeResponse) => void;
  onLogout: () => void;
}): ReactNode {
  return (
    <main className="login-shell">
      <Card className="login-card" bordered={false}>
        <div className="brand-mark">CO</div>
        <Typography.Title level={2}>请先修改密码</Typography.Title>
        <PasswordChangeForm onChanged={props.onChanged} onLogout={props.onLogout} />
      </Card>
    </main>
  );
}

function WorkbenchPage(): ReactNode {
  const [data, setData] = useState<WorkbenchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [greeting, setGreeting] = useState(() => greetingForTime(new Date()));
  useEffect(() => {
    const update = (): void => setGreeting(greetingForTime(new Date()));
    const timer = window.setInterval(update, 60_000);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    void workbench()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '工作台加载失败'));
  }, []);
  if (error) return <Result status="error" title="工作台加载失败" subTitle={error} />;
  if (!data)
    return (
      <div className="page-loading">
        <Spin />
      </div>
    );
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>
            {greeting}，{data.user.name}
          </Typography.Title>
          <Typography.Text type="secondary">这里是你的工作入口。</Typography.Text>
        </div>
      </div>
      <div className="summary-grid">
        <Card>
          <Typography.Text type="secondary">当前会话</Typography.Text>
          <Typography.Title level={3}>{data.security.activeSessions}</Typography.Title>
          <Typography.Text type="secondary">个活跃会话</Typography.Text>
        </Card>
        <Card>
          <Typography.Text type="secondary">账号状态</Typography.Text>
          <Typography.Title level={3}>
            <Tag color={data.user.status === 'active' ? 'green' : 'red'}>
              {data.user.status === 'active' ? '正常' : '停用'}
            </Tag>
          </Typography.Title>
          <Typography.Text type="secondary">登录账号：{data.user.email}</Typography.Text>
        </Card>
        <Card>
          <Typography.Text type="secondary">产品版本</Typography.Text>
          <Typography.Title level={3}>R1</Typography.Title>
          <Typography.Text type="secondary">基础与业务模块并行开发</Typography.Text>
        </Card>
      </div>
      <WorkbenchPanels />
      <Card title="模块状态" className="module-card">
        <div className="module-grid">
          {data.modules.map((module) => (
            <div className="module-item" key={module.key}>
              <div className="module-icon">
                <AppstoreOutlined />
              </div>
              <div className="module-copy">
                <Typography.Text strong>{module.name}</Typography.Text>
                <Typography.Text type="secondary">
                  {module.status === 'available'
                    ? '已上线'
                    : `计划于 ${module.milestone ?? '后续'}`}
                </Typography.Text>
              </div>
              <Tag color={module.status === 'available' ? 'green' : 'default'}>
                {module.status === 'available' ? '可用' : '规划中'}
              </Tag>
            </div>
          ))}
        </div>
      </Card>
      <Card title="下一步" className="notice-card">
        <Typography.Paragraph>
          从侧栏进入项目、审批、文档、组织和系统管理模块。
        </Typography.Paragraph>
      </Card>
    </div>
  );
}

function NotFoundPage(): ReactNode {
  return <Empty description="页面不存在" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
}
