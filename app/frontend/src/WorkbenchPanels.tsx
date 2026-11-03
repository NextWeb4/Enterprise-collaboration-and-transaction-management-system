import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { BellOutlined } from '@ant-design/icons';
import type { NotificationView, WorkbenchTask } from '@collab/shared/schemas.js';
import { updateTask } from './api';
import {
  getActivity,
  getMyTasks,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from './workbench-api';

function Queries({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 0 } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
function ErrorMessage({ error, retry }: { error: unknown; retry?: () => void }): ReactNode {
  return error ? (
    <Alert
      type="error"
      showIcon
      message={error instanceof Error ? error.message : '加载失败'}
      action={retry && <Button onClick={retry}>重试</Button>}
    />
  ) : null;
}
function TaskTable({
  tasks,
  loading,
  pagination,
}: {
  tasks: WorkbenchTask[];
  loading?: boolean;
  pagination?: {
    current: number;
    total: number;
    pageSize: number;
    onChange: (page: number) => void;
  };
}): ReactNode {
  const client = useQueryClient();
  const complete = useMutation({
    mutationFn: (task: WorkbenchTask) =>
      updateTask(task.id, { version: task.version, status: 'done', progress: 100 }),
    onSuccess: () => client.invalidateQueries(),
  });
  return (
    <>
      <ErrorMessage error={complete.error} />
      <Table<WorkbenchTask>
        rowKey="id"
        dataSource={tasks}
        loading={loading}
        pagination={pagination ?? false}
        scroll={{ x: 620 }}
        locale={{ emptyText: <Empty description="暂无待办任务" /> }}
        columns={[
          {
            title: '任务',
            render: (_, item) => (
              <Link to={`/app/projects?project=${item.projectId}&task=${item.id}`}>
                {item.taskKey} · {item.title}
              </Link>
            ),
          },
          { title: '项目', dataIndex: 'projectName' },
          {
            title: '优先级',
            render: (_, item) =>
              ({ urgent: '紧急', high: '高', medium: '中', low: '低' })[item.priority] ??
              item.priority,
          },
          {
            title: '截止日期',
            render: (_, item) => (
              <Space>
                {item.dueDate ?? '未设置'}
                {item.overdue && <Tag color="red">逾期</Tag>}
              </Space>
            ),
          },
          {
            title: '操作',
            render: (_, item) =>
              item.canComplete ? (
                <Button loading={complete.isPending} onClick={() => complete.mutate(item)}>
                  完成任务
                </Button>
              ) : (
                <Link to={`/app/projects?project=${item.projectId}`}>查看项目</Link>
              ),
          },
        ]}
      />
    </>
  );
}
function Activity(): ReactNode {
  const query = useQuery({ queryKey: ['activity'], queryFn: getActivity, refetchInterval: 30_000 });
  if (query.isPending)
    return (
      <Card>
        <Spin />
      </Card>
    );
  if (query.error || !query.data)
    return (
      <ErrorMessage
        error={query.error ?? new Error('暂无工作概览')}
        retry={() => void query.refetch()}
      />
    );
  const { metrics, tasks, approvals, projects, timezone } = query.data;
  return (
    <>
      <div className="summary-grid">
        {[
          ['未完成任务', metrics.openTasks],
          ['逾期任务', metrics.overdueTasks],
          ['本周到期', metrics.dueThisWeek],
          ['本周完成', metrics.completedThisWeek],
          ['待我审批', metrics.pendingApprovals],
          ['未读通知', metrics.unreadNotifications],
        ].map(([title, value]) => (
          <Card key={String(title)}>
            <Statistic title={title} value={value} />
          </Card>
        ))}
      </div>
      <Typography.Text type="secondary">
        按组织时区 {timezone} 统计，本周从周一开始。
      </Typography.Text>
      <Card title="我的待办" extra={<Link to="/app/my-tasks">查看全部</Link>}>
        <TaskTable tasks={tasks} />
      </Card>
      <Card title="待我审批" extra={<Link to="/app/applications">进入审批中心</Link>}>
        <Table
          rowKey="id"
          dataSource={approvals}
          pagination={false}
          scroll={{ x: 540 }}
          locale={{ emptyText: '当前没有待你审批的申请' }}
          columns={[
            {
              title: '申请',
              render: (_, item) => <Link to={`/app/applications/${item.id}`}>{item.title}</Link>,
            },
            { title: '申请人', dataIndex: 'applicantName' },
            { title: '当前步骤', dataIndex: 'step' },
            {
              title: '提交时间',
              render: (_, item) =>
                item.submittedAt ? new Date(item.submittedAt).toLocaleString('zh-CN') : '—',
            },
          ]}
        />
      </Card>
      <Card title="最近项目" extra={<Link to="/app/projects">全部项目</Link>}>
        {projects.length ? (
          <div className="module-grid">
            {projects.map((project) => (
              <Card size="small" key={project.id}>
                <Link to={`/app/projects?project=${project.id}`}>
                  {project.key} · {project.name}
                </Link>
                <div>
                  <Typography.Text type="secondary">
                    未完成任务 {project.openTasks} 项
                  </Typography.Text>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Empty description="还没有项目，创建一个或等待被邀请" />
        )}
      </Card>
    </>
  );
}
export function WorkbenchPanels(): ReactNode {
  return (
    <Queries>
      <Activity />
    </Queries>
  );
}
function MyTasks(): ReactNode {
  const [page, setPage] = useState(1);
  const [overdue, setOverdue] = useState(false);
  const query = useQuery({
    queryKey: ['tasks', page, overdue],
    queryFn: () => getMyTasks(page, overdue),
  });
  return (
    <div className="page-stack">
      <Typography.Title level={2}>我的待办</Typography.Title>
      <Card
        extra={
          <Space>
            仅逾期
            <Switch
              aria-label="仅逾期"
              checked={overdue}
              onChange={(value) => {
                setOverdue(value);
                setPage(1);
              }}
            />
          </Space>
        }
      >
        <ErrorMessage error={query.error} retry={() => void query.refetch()} />
        <TaskTable
          tasks={query.data?.data ?? []}
          loading={query.isPending}
          pagination={{
            current: page,
            total: query.data?.meta.total ?? 0,
            pageSize: 20,
            onChange: setPage,
          }}
        />
      </Card>
    </div>
  );
}
export function MyTasksPage(): ReactNode {
  return (
    <Queries>
      <MyTasks />
    </Queries>
  );
}
function Notifications(): ReactNode {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [page, setPage] = useState(1);
  const [unread, setUnread] = useState(false);
  const query = useQuery({
    queryKey: ['notifications', page, unread],
    queryFn: () => getNotifications(page, unread),
    refetchInterval: 30_000,
  });
  const read = useMutation({
    mutationFn: async (item: NotificationView) => {
      if (!item.readAt) await markNotificationRead(item.id, item.version);
      return item;
    },
    onSuccess: async (item) => {
      await client.invalidateQueries();
      if (item.linkPath?.startsWith('/app/')) navigate(item.linkPath);
    },
  });
  const readAll = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => client.invalidateQueries(),
  });
  return (
    <div className="page-stack">
      <Typography.Title level={2}>消息通知</Typography.Title>
      <Card
        extra={
          <Space wrap>
            仅未读
            <Switch
              aria-label="仅未读"
              checked={unread}
              onChange={(value) => {
                setUnread(value);
                setPage(1);
              }}
            />
            <Button loading={readAll.isPending} onClick={() => readAll.mutate()}>
              全部已读
            </Button>
          </Space>
        }
      >
        <ErrorMessage
          error={query.error ?? read.error ?? readAll.error}
          retry={() => void query.refetch()}
        />
        <Table<NotificationView>
          rowKey="id"
          dataSource={query.data?.data ?? []}
          loading={query.isPending}
          scroll={{ x: 500 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: query.data?.meta.total ?? 0,
            onChange: setPage,
          }}
          locale={{ emptyText: '暂无通知' }}
          columns={[
            {
              title: '通知',
              render: (_, item) => (
                <>
                  <Button type="link" loading={read.isPending} onClick={() => read.mutate(item)}>
                    {item.title}
                  </Button>
                  {item.content && <Typography.Paragraph>{item.content}</Typography.Paragraph>}
                </>
              ),
            },
            {
              title: '状态',
              render: (_, item) => (
                <Tag color={item.readAt ? 'default' : 'blue'}>{item.readAt ? '已读' : '未读'}</Tag>
              ),
            },
            {
              title: '时间',
              render: (_, item) => new Date(item.createdAt).toLocaleString('zh-CN'),
            },
          ]}
        />
      </Card>
    </div>
  );
}
export function NotificationsPage(): ReactNode {
  return (
    <Queries>
      <Notifications />
    </Queries>
  );
}
function Bell(): ReactNode {
  const query = useQuery({ queryKey: ['activity'], queryFn: getActivity, refetchInterval: 30_000 });
  return (
    <Link to="/app/notifications" aria-label="消息通知">
      <Badge count={query.data?.metrics.unreadNotifications ?? 0} overflowCount={99}>
        <BellOutlined style={{ fontSize: 20 }} />
      </Badge>
    </Link>
  );
}
export function NotificationBell(): ReactNode {
  return (
    <Queries>
      <Bell />
    </Queries>
  );
}
