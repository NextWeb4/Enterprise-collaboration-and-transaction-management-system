import { useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Timeline,
  Typography,
  Upload,
} from 'antd';
import {
  applicationDraftRequestSchema,
  type ApplicationDraftRequest,
  type MeResponse,
} from '@collab/shared/schemas.js';
import { listProjects } from './api';
import {
  actOnApplication,
  attachApplicationFile,
  attachmentDownloadUrl,
  copyApplication,
  createApplication,
  getApplication,
  initializeTemplates,
  listApplications,
  listApprovalUsers,
  listTemplates,
  listTemplateVersions,
  removeApplication,
  removeApplicationFile,
  saveTemplate,
  submitApplication,
  templateAction,
  updateApplication,
  type ApplicationDetail,
  type ApplicationStatus,
  type ApplicationSummary,
  type ApplicationType,
  type TemplateInput,
  type WorkflowTemplate,
} from './approvals-api';

const typeNames: Record<ApplicationType, string> = {
  leave: '请假',
  travel: '出差',
  field: '外勤',
  seal: '用印',
  general: '通用事务',
};
const statusNames: Record<ApplicationStatus, string> = {
  draft: '草稿',
  pending: '审批中',
  approved: '已通过',
  rejected: '已驳回',
  withdrawn: '已撤回',
};
const statusColors: Record<ApplicationStatus, string> = {
  draft: 'default',
  pending: 'processing',
  approved: 'success',
  rejected: 'error',
  withdrawn: 'warning',
};
const fieldNames: Record<string, string> = {
  leaveType: '请假类型',
  durationDays: '天数',
  reason: '请假原因',
  handoverUserId: '交接人',
  destination: '目的地',
  purpose: '事由',
  transport: '交通方式',
  estimatedCost: '预计费用（元）',
  location: '外勤地点',
  documentName: '文件名称',
  sealType: '印章类型',
  copies: '份数',
  expectedDate: '期望日期',
  recipient: '领取人',
  subject: '主题',
  content: '事项说明',
};
const leaveOptions = [
  { value: 'annual', label: '年假' },
  { value: 'sick', label: '病假' },
  { value: 'personal', label: '事假' },
  { value: 'compensatory', label: '调休' },
  { value: 'marriage', label: '婚假' },
  { value: 'maternity', label: '产假' },
  { value: 'paternity', label: '陪产假' },
  { value: 'bereavement', label: '丧假' },
];
const transportOptions = [
  { value: 'plane', label: '飞机' },
  { value: 'train', label: '火车' },
  { value: 'car', label: '汽车' },
  { value: 'other', label: '其他' },
];
const sealOptions = [
  { value: 'company', label: '公司章' },
  { value: 'contract', label: '合同章' },
  { value: 'finance', label: '财务章' },
  { value: 'other', label: '其他' },
];
const types = Object.entries(typeNames).map(([value, label]) => ({ value, label }));
const date = (value: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN') : '—';
const message = (error: unknown): string =>
  error instanceof Error ? error.message : '操作失败，请重试';
function Failure({ error, retry }: { error: unknown; retry?: () => void }): ReactNode {
  return error ? (
    <Alert
      type="error"
      showIcon
      message={message(error)}
      action={retry ? <Button onClick={retry}>重试</Button> : undefined}
    />
  ) : null;
}

export function ApprovalsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }),
  );
  const canRead = identity.permissions.some((permission) =>
    ['application:read:self', 'application:read:all', 'application:approve', 'audit:read'].includes(
      permission,
    ),
  );
  if (!canRead)
    return <Alert type="warning" showIcon message="没有查看申请的权限，请联系组织管理员" />;
  return (
    <QueryClientProvider client={client}>
      <Routes>
        <Route index element={<ApplicationList identity={identity} />} />
        <Route path="new" element={<ApplicationEditor identity={identity} />} />
        <Route path="templates" element={<TemplatesPage identity={identity} />} />
        <Route path=":id" element={<ApplicationView identity={identity} />} />
      </Routes>
    </QueryClientProvider>
  );
}

function ApplicationList({ identity }: { identity: MeResponse }): ReactNode {
  const [view, setView] = useState('mine');
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ApplicationStatus>();
  const [type, setType] = useState<ApplicationType>();
  const [q, setQ] = useState('');
  const query = useQuery({
    queryKey: ['applications', identity.user.id, view, page, status, type, q],
    queryFn: () => listApplications({ page, pageSize: 20, view, status, applicationType: type, q }),
  });
  const views = [
    { value: 'mine', label: '我的申请' },
    { value: 'pending', label: '待我审批' },
    { value: 'involved', label: '我参与的审批' },
    ...(identity.permissions.some(
      (permission) => permission === 'application:read:all' || permission === 'audit:read',
    )
      ? [{ value: 'all', label: '治理与审计' }]
      : []),
  ];
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>OA 审批</Typography.Title>
          <Typography.Text type="secondary">发起事务，处理待办，追溯每一次决定。</Typography.Text>
        </div>
        <Space wrap>
          {identity.permissions.includes('workflow:template:manage') && (
            <Link to="templates">
              <Button>审批模板</Button>
            </Link>
          )}
          {identity.permissions.includes('application:create') && (
            <Link to="new">
              <Button type="primary">发起申请</Button>
            </Link>
          )}
        </Space>
      </div>
      <Card>
        <Space wrap style={{ marginBottom: 20 }}>
          <Select
            aria-label="申请视图"
            value={view}
            options={views}
            onChange={(value) => {
              setView(value);
              setPage(1);
            }}
            style={{ minWidth: 150 }}
          />
          <Select
            aria-label="申请类型"
            placeholder="全部类型"
            allowClear
            value={type}
            options={types}
            onChange={(value: ApplicationType | undefined) => {
              setType(value);
              setPage(1);
            }}
            style={{ minWidth: 130 }}
          />
          <Select
            aria-label="申请状态"
            placeholder="全部状态"
            allowClear
            value={status}
            options={Object.entries(statusNames).map(([value, label]) => ({ value, label }))}
            onChange={(value: ApplicationStatus | undefined) => {
              setStatus(value);
              setPage(1);
            }}
            style={{ minWidth: 130 }}
          />
          <Input.Search
            aria-label="搜索申请"
            placeholder="标题或申请编号"
            allowClear
            onSearch={(value) => {
              setQ(value);
              setPage(1);
            }}
            style={{ width: 240 }}
          />
          <Button onClick={() => void query.refetch()}>刷新</Button>
        </Space>
        <Failure error={query.error} retry={() => void query.refetch()} />
        <Table<ApplicationSummary>
          rowKey="id"
          loading={query.isPending}
          dataSource={query.data?.data ?? []}
          locale={{ emptyText: <Empty description="此范围暂无申请" /> }}
          scroll={{ x: 750 }}
          pagination={{
            current: page,
            pageSize: 20,
            total: query.data?.meta.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
          }}
          columns={[
            {
              title: '申请',
              render: (_, row) => (
                <>
                  <Link to={row.id}>{row.title}</Link>
                  <br />
                  <Typography.Text type="secondary">
                    {row.applicationNo ?? '尚未提交'}
                  </Typography.Text>
                </>
              ),
            },
            { title: '类型', render: (_, row) => typeNames[row.applicationType] },
            { title: '申请人', dataIndex: 'applicantName' },
            { title: '部门', render: (_, row) => row.departmentName ?? '—' },
            {
              title: '状态',
              render: (_, row) => (
                <Tag color={statusColors[row.status]}>{statusNames[row.status]}</Tag>
              ),
            },
            { title: '提交时间', render: (_, row) => date(row.submittedAt) },
          ]}
        />
      </Card>
    </div>
  );
}

function ApplicationEditor({
  identity,
  existing,
  onSaved,
}: {
  identity: MeResponse;
  existing?: ApplicationDetail;
  onSaved?: () => void;
}): ReactNode {
  const navigate = useNavigate();
  const client = useQueryClient();
  const form = useForm<ApplicationDraftRequest>({
    resolver: zodResolver(applicationDraftRequestSchema),
    defaultValues: existing
      ? {
          applicationType: existing.applicationType,
          title: existing.title,
          formData: existing.formData ?? {},
          startAt: existing.startAt,
          endAt: existing.endAt,
          projectId: existing.projectId,
        }
      : {
          applicationType: 'general',
          title: '',
          formData: {},
          startAt: null,
          endAt: null,
          projectId: null,
        },
  });
  const type = useWatch({ control: form.control, name: 'applicationType' });
  const projects = useQuery({
    queryKey: ['application-project-options'],
    queryFn: listProjects,
    enabled: identity.permissions.includes('project:read'),
  });
  const approvalUsers = useQuery({
    queryKey: ['approval-users'],
    queryFn: listApprovalUsers,
    enabled:
      type === 'leave' &&
      (identity.permissions.includes('employee:read') ||
        identity.permissions.includes('organization:directory:read')),
  });
  const save = useMutation({
    mutationFn: async (input: ApplicationDraftRequest) => {
      const clean = {
        ...input,
        formData: Object.fromEntries(
          Object.entries(input.formData).filter(
            ([, value]) => value !== '' && value !== undefined && value !== null,
          ),
        ),
      };
      return existing
        ? updateApplication(existing.id, existing.version, clean)
        : createApplication(clean);
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['applications'] });
      await client.invalidateQueries({ queryKey: ['application', result.id] });
      if (onSaved) onSaved();
      else navigate(`/app/applications/${result.id}`);
    },
  });
  const field = (
    name: string,
    kind: 'text' | 'long' | 'number' | 'date' = 'text',
    options?: Array<{ value: string; label: string }>,
  ): ReactNode => (
    <Form.Item label={fieldNames[name]} key={name}>
      <Controller
        control={form.control}
        name={`formData.${name}`}
        render={({ field: input }) =>
          options ? (
            <Select
              {...input}
              aria-label={fieldNames[name]}
              value={typeof input.value === 'string' ? input.value : undefined}
              allowClear
              options={options}
            />
          ) : kind === 'number' ? (
            <InputNumber
              {...input}
              aria-label={fieldNames[name]}
              value={typeof input.value === 'number' ? input.value : null}
              min={0}
              step={name === 'durationDays' ? 0.5 : name === 'estimatedCost' ? 0.01 : 1}
              style={{ width: '100%' }}
            />
          ) : kind === 'long' ? (
            <Input.TextArea
              {...input}
              aria-label={fieldNames[name]}
              value={typeof input.value === 'string' ? input.value : ''}
              rows={4}
              maxLength={name === 'content' ? 2000 : 500}
              showCount
            />
          ) : (
            <Input
              {...input}
              aria-label={fieldNames[name]}
              value={typeof input.value === 'string' ? input.value : ''}
              type={kind === 'date' ? 'date' : 'text'}
              maxLength={100}
            />
          )
        }
      />
    </Form.Item>
  );
  if (!identity.permissions.includes('application:create'))
    return <Alert type="warning" message="没有发起申请的权限" />;
  return (
    <Card
      title={existing ? '编辑草稿' : '发起申请'}
      extra={<Link to="/app/applications">返回申请中心</Link>}
    >
      <Failure error={save.error} />
      <Form
        layout="vertical"
        onFinish={() => void form.handleSubmit((values) => save.mutate(values))()}
        style={{ maxWidth: 760 }}
      >
        <Form.Item label="申请类型">
          <Controller
            control={form.control}
            name="applicationType"
            render={({ field: input }) => (
              <Select
                {...input}
                aria-label="申请类型"
                disabled={!!existing}
                options={types}
                onChange={(value: ApplicationType) => {
                  input.onChange(value);
                  form.setValue('formData', {});
                  form.setValue('startAt', null);
                  form.setValue('endAt', null);
                }}
              />
            )}
          />
        </Form.Item>
        <Form.Item
          label="标题"
          validateStatus={form.formState.errors.title ? 'error' : undefined}
          help={form.formState.errors.title?.message}
        >
          <Controller
            control={form.control}
            name="title"
            render={({ field: input }) => (
              <Input {...input} aria-label="标题" maxLength={100} placeholder="用一句话说明这项申请" />
            )}
          />
        </Form.Item>
        {['leave', 'travel', 'field'].includes(type) && (
          <Space align="start" wrap>
            {(['startAt', 'endAt'] as const).map((name) => (
              <Form.Item
                key={name}
                label={name === 'startAt' ? '开始时间（本地时区）' : '结束时间（本地时区）'}
              >
                <Controller
                  control={form.control}
                  name={name}
                  render={({ field: input }) => (
                    <Input
                      type="datetime-local"
                      aria-label={name === 'startAt' ? '开始时间（本地时区）' : '结束时间（本地时区）'}
                      value={
                        input.value
                          ? new Date(
                              Date.parse(input.value) -
                                new Date(input.value).getTimezoneOffset() * 60000,
                            )
                              .toISOString()
                              .slice(0, 16)
                          : ''
                      }
                      onChange={(event) =>
                        input.onChange(
                          event.target.value ? new Date(event.target.value).toISOString() : null,
                        )
                      }
                    />
                  )}
                />
              </Form.Item>
            ))}
          </Space>
        )}
        {type === 'leave' && (
          <>
            {field('leaveType', 'text', leaveOptions)}
            {field('durationDays', 'number')}
            <Typography.Paragraph type="secondary">
              按 0.5 天填写；首版不自动扣减余额或排除节假日。
            </Typography.Paragraph>
            {field('reason', 'long')}
            <Form.Item label="交接人">
              <Controller
                control={form.control}
                name="formData.handoverUserId"
                render={({ field: input }) => (
                <Select
                  {...input}
                  aria-label="交接人"
                    allowClear
                    placeholder="可选：选择在职交接人"
                    value={typeof input.value === 'string' ? input.value : undefined}
                    options={(approvalUsers.data ?? [])
                      .filter((user) => user.userId !== identity.user.id)
                      .map((user) => ({ value: user.userId, label: user.name }))}
                  loading={approvalUsers.isPending && approvalUsers.fetchStatus === 'fetching'}
                    notFoundContent={approvalUsers.error ? '无权读取在职用户' : '暂无在职用户'}
                  />
                )}
              />
            </Form.Item>
          </>
        )}
        {type === 'travel' && (
          <>
            {field('destination')}
            {field('purpose', 'long')}
            {field('transport', 'text', transportOptions)}
            {field('estimatedCost', 'number')}
          </>
        )}
        {type === 'field' && (
          <>
            {field('location')}
            {field('purpose', 'long')}
          </>
        )}
        {type === 'seal' && (
          <>
            {field('documentName')}
            {field('sealType', 'text', sealOptions)}
            {field('copies', 'number')}
            {field('purpose', 'long')}
            {field('expectedDate', 'date')}
            {field('recipient')}
            <Alert type="info" message="保存草稿后，请上传一个待用印文件再提交审批。" />
          </>
        )}
        {type === 'general' && (
          <>
            {field('subject')}
            {field('content', 'long')}
            {field('expectedDate', 'date')}
            <Typography.Paragraph type="secondary">
              通用事务用于行政事项；不承载付款、合同或采购审批。
            </Typography.Paragraph>
          </>
        )}
        <Form.Item label="关联项目（可选）">
          <Controller
            control={form.control}
            name="projectId"
            render={({ field: input }) => (
              <Select
                {...input}
                allowClear
                loading={projects.isPending && projects.fetchStatus === 'fetching'}
                options={(projects.data ?? [])
                  .filter((project) => project.status !== 'archived')
                  .map((project) => ({
                    value: project.id,
                    label: `${project.key} · ${project.name}`,
                  }))}
                onChange={(value?: string) => input.onChange(value ?? null)}
              />
            )}
          />
        </Form.Item>
        <Space>
          <Button type="primary" htmlType="submit" loading={save.isPending}>
            保存草稿
          </Button>
          {onSaved && <Button onClick={onSaved}>取消编辑</Button>}
        </Space>
      </Form>
    </Card>
  );
}

function ApplicationView({ identity }: { identity: MeResponse }): ReactNode {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<'approve' | 'reject' | 'withdraw' | 'reassign' | null>(null);
  const [comment, setComment] = useState('');
  const [assignee, setAssignee] = useState<string>();
  const [key] = useState(() => crypto.randomUUID());
  const query = useQuery({ queryKey: ['application', id], queryFn: () => getApplication(id) });
  const accounts = useQuery({
    queryKey: ['approval-assignees'],
    queryFn: listApprovalUsers,
    enabled: action === 'reassign',
  });
  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['application', id] });
    await client.invalidateQueries({ queryKey: ['applications'] });
  };
  const mutation = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setAction(null);
      setComment('');
      setAssignee(undefined);
      await refresh();
    },
  });
  if (query.isPending) return <Spin />;
  if (!query.data) return <Failure error={query.error} retry={() => void query.refetch()} />;
  const application = query.data;
  if (editing)
    return (
      <ApplicationEditor
        identity={identity}
        existing={application}
        onSaved={() => {
          setEditing(false);
          void refresh();
        }}
      />
    );
  const actionTitle =
    action === 'approve'
      ? '确认通过申请'
      : action === 'reject'
        ? '确认驳回申请'
        : action === 'withdraw'
          ? '确认撤回申请'
          : '异常转交当前步骤';
  const displayValue = (name: string, value: unknown): string => {
    const options =
      name === 'leaveType'
        ? leaveOptions
        : name === 'transport'
          ? transportOptions
          : name === 'sealType'
            ? sealOptions
            : [];
    return options.find((option) => option.value === value)?.label ?? String(value ?? '—');
  };
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Link to="/app/applications">← 返回申请中心</Link>
          <Typography.Title level={2}>{application.title}</Typography.Title>
          <Space>
            <Tag color={statusColors[application.status]}>{statusNames[application.status]}</Tag>
            <Typography.Text type="secondary">
              {application.applicationNo ?? '尚未分配编号'} ·{' '}
              {typeNames[application.applicationType]}
            </Typography.Text>
          </Space>
        </div>
        <Space wrap>
          {application.actions.edit && <Button onClick={() => setEditing(true)}>编辑草稿</Button>}
          {application.actions.submit && (
            <Popconfirm
              title="确认提交？提交后正文和附件不可修改。"
              onConfirm={() => mutation.mutateAsync(() => submitApplication(id, key))}
            >
              <Button type="primary" loading={mutation.isPending}>
                提交审批
              </Button>
            </Popconfirm>
          )}
          {application.actions.approve && (
            <>
              <Button type="primary" onClick={() => setAction('approve')}>
                通过
              </Button>
              <Button danger onClick={() => setAction('reject')}>
                驳回
              </Button>
            </>
          )}
          {application.actions.withdraw && (
            <Button onClick={() => setAction('withdraw')}>撤回</Button>
          )}
          {application.actions.reassign && (
            <Button onClick={() => setAction('reassign')}>异常转交</Button>
          )}
          {application.actions.copy && (
            <Button
              onClick={() =>
                mutation.mutate(async () => {
                  const result = await copyApplication(id);
                  navigate(`/app/applications/${result.id}`);
                })
              }
            >
              复制新建
            </Button>
          )}
          {application.actions.edit && (
            <Popconfirm
              title="确认删除草稿？此操作不会提交审批。"
              onConfirm={() =>
                mutation.mutateAsync(async () => {
                  await removeApplication(id, application.version);
                  navigate('/app/applications');
                })
              }
            >
              <Button danger>删除</Button>
            </Popconfirm>
          )}
        </Space>
      </div>
      <Failure error={query.error ?? mutation.error} />
      {application.redacted && (
        <Alert type="info" showIcon message="审计摘要：正文、附件和审批意见已隐藏" />
      )}
      <Card title="申请详情">
        <Descriptions
          column={{ xs: 1, sm: 2 }}
          items={[
            { key: 'applicant', label: '申请人', children: application.applicantName },
            { key: 'department', label: '部门', children: application.departmentName ?? '—' },
            { key: 'submitted', label: '提交时间', children: date(application.submittedAt) },
            { key: 'completed', label: '完成时间', children: date(application.completedAt) },
            ...(application.startAt
              ? [
                  { key: 'start', label: '开始时间', children: date(application.startAt) },
                  { key: 'end', label: '结束时间', children: date(application.endAt) },
                ]
              : []),
            ...(application.projectId
              ? [
                  {
                    key: 'project',
                    label: '关联项目',
                    children: (
                      <Link to={`/app/projects/${application.projectId}`}>查看关联项目</Link>
                    ),
                  },
                ]
              : []),
            ...Object.entries(application.formData ?? {}).map(([name, value]) => ({
              key: name,
              label: fieldNames[name] ?? name,
              children: (
                <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {displayValue(name, value)}
                </span>
              ),
            })),
          ]}
        />
      </Card>
      {!application.redacted && (
        <Card
          title="附件"
          extra={
            application.actions.edit ? (
              <Upload
                accept=".pdf,.png,.jpg,.jpeg"
                showUploadList={false}
                beforeUpload={(file) => {
                  mutation.mutate(() => attachApplicationFile(id, application.version, file));
                  return false;
                }}
              >
                <Button
                  disabled={
                    mutation.isPending ||
                    application.attachments.length >=
                      (application.applicationType === 'seal' ? 1 : 5)
                  }
                >
                  上传附件
                </Button>
              </Upload>
            ) : undefined
          }
        >
          <Typography.Paragraph type="secondary">
            PDF / JPG / PNG，每个不超过 10MB；
            {application.applicationType === 'seal' ? '用印须有一个文件' : '最多五个文件'}。
          </Typography.Paragraph>
          {application.attachments.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无附件" />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }}>
              {application.attachments.map((attachment) => (
                <Space key={attachment.id} wrap>
                  <a href={attachmentDownloadUrl(id, attachment.id)}>{attachment.fileName}</a>
                  <Typography.Text type="secondary">
                    {Math.ceil(attachment.size / 1024)} KB
                  </Typography.Text>
                  {application.actions.edit && (
                    <Popconfirm
                      title="移除此附件？"
                      onConfirm={() =>
                        mutation.mutateAsync(() =>
                          removeApplicationFile(id, application.version, attachment.id),
                        )
                      }
                    >
                      <Button size="small" danger>
                        移除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ))}
            </Space>
          )}
        </Card>
      )}
      <Card title="审批时间线">
        {application.status === 'draft' ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="提交后生成审批流程" />
        ) : (
          <>
            <Timeline
              items={[
                {
                  color: 'green',
                  children: <>申请已提交 · {date(application.history.submittedAt)}</>,
                },
                ...application.history.records.map((record) => ({
                  color: record.action === 'reject' ? 'red' : 'green',
                  children: (
                    <>
                      <Typography.Text strong>
                        {record.operatorName} ·{' '}
                        {
                          { approve: '通过', reject: '驳回', withdraw: '撤回', reassign: '转交' }[
                            record.action
                          ]
                        }
                      </Typography.Text>
                      <div>{date(record.createdAt)}</div>
                      {record.action === 'reassign' && (
                        <div>
                          {record.fromApproverName} → {record.toApproverName}
                        </div>
                      )}
                      {record.comment && (
                        <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                          {record.comment}
                        </Typography.Paragraph>
                      )}
                    </>
                  ),
                })),
              ]}
            />
            <Space direction="vertical">
              {application.history.steps.map((step) => (
                <Space key={step.id}>
                  <Tag color={step.status === 'active' ? 'processing' : 'default'}>
                    {step.stepNo}. {step.name}
                  </Tag>
                  <span>
                    {
                      {
                        active: '当前步骤',
                        waiting: '未激活',
                        approved: '已通过',
                        rejected: '已驳回',
                        cancelled: '已取消',
                      }[step.status]
                    }
                    {step.approverName ? ` · ${step.approverName}` : ''}
                  </span>
                </Space>
              ))}
            </Space>
          </>
        )}
      </Card>
      <Modal
        title={actionTitle}
        open={action !== null}
        onCancel={() => setAction(null)}
        confirmLoading={mutation.isPending}
        okButtonProps={{
          danger: action === 'reject',
          disabled:
            action === 'reject'
              ? comment.trim().length < 10
              : action === 'reassign'
                ? comment.trim().length < 5 || !assignee
                : false,
        }}
        onOk={() => {
          if (action)
            mutation.mutate(() =>
              actOnApplication(id, action, application.version, comment, assignee),
            );
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>
            {action === 'withdraw'
              ? '撤回后不能再次提交，可复制为新草稿。'
              : action === 'reassign'
                ? '仅变更当前审批人，必须说明原因并保留记录。'
                : '请核对申请内容和附件，确认后将写入不可更改的审批历史。'}
          </Typography.Paragraph>
          {action === 'reassign' && (
            <>
              <Failure error={accounts.error} />
              <Select
                aria-label="新审批人"
                placeholder="选择新审批人"
                style={{ width: '100%' }}
                value={assignee}
                onChange={setAssignee}
                options={(accounts.data ?? [])
                  .filter((account) => account.userId !== application.applicantId)
                  .map((account) => ({ value: account.userId, label: account.name }))}
              />
            </>
          )}
          <Input.TextArea
            aria-label="审批意见或原因"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={
              action === 'reject'
                ? '驳回原因（10–500 字）'
                : action === 'reassign'
                  ? '转交原因（5–500 字）'
                  : '意见或原因（可选）'
            }
            rows={4}
            maxLength={500}
            showCount
          />
          <Failure error={mutation.error} />
        </Space>
      </Modal>
    </div>
  );
}

function TemplatesPage({ identity }: { identity: MeResponse }): ReactNode {
  const client = useQueryClient();
  const [editing, setEditing] = useState<WorkflowTemplate | 'new' | null>(null);
  const [historyId, setHistoryId] = useState<string>();
  const [form] = Form.useForm<TemplateInput>();
  const allowed = identity.permissions.includes('workflow:template:manage');
  const query = useQuery({
    queryKey: ['workflow-templates'],
    queryFn: listTemplates,
    enabled: allowed,
  });
  const versions = useQuery({
    queryKey: ['workflow-versions', historyId],
    queryFn: () => listTemplateVersions(historyId!),
    enabled: !!historyId,
  });
  const accounts = useQuery({
    queryKey: ['approval-template-users'],
    queryFn: listApprovalUsers,
    enabled: allowed && editing !== null,
  });
  const mutation = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      setEditing(null);
      await client.invalidateQueries({ queryKey: ['workflow-templates'] });
      await client.invalidateQueries({ queryKey: ['workflow-versions'] });
    },
  });
  if (!allowed) return <Alert type="warning" message="没有管理审批模板的权限" />;
  const edit = (value: WorkflowTemplate | 'new'): void => {
    setEditing(value);
    form.setFieldsValue(
      value === 'new'
        ? {
            name: '',
            applicationType: 'general',
            draftSteps: [
              {
                stepNo: 1,
                name: '部门负责人审批',
                approverType: 'department_manager',
                userId: null,
              },
            ],
          }
        : value,
    );
  };
  return (
    <div className="page-stack">
      <div className="page-heading">
        <div>
          <Link to="/app/applications">← 返回申请中心</Link>
          <Typography.Title level={2}>审批模板</Typography.Title>
          <Typography.Text type="secondary">
            发布保留旧版本；进行中的审批不受后续编辑影响。
          </Typography.Text>
        </div>
        <Space>
          <Popconfirm
            title="为尚未配置的类型创建并发布默认模板？请先确认员工上级和部门负责人。"
            onConfirm={() => mutation.mutateAsync(initializeTemplates)}
          >
            <Button>创建默认模板</Button>
          </Popconfirm>
          <Button type="primary" onClick={() => edit('new')}>
            新建模板
          </Button>
        </Space>
      </div>
      <Failure error={query.error ?? mutation.error} retry={() => void query.refetch()} />
      <Card>
        <Table<WorkflowTemplate>
          rowKey="id"
          dataSource={query.data ?? []}
          loading={query.isPending}
          scroll={{ x: 700 }}
          columns={[
            { title: '模板', dataIndex: 'name' },
            { title: '类型', render: (_, row) => typeNames[row.applicationType] },
            {
              title: '状态',
              render: (_, row) =>
                ({ draft: '草稿', active: '已启用', inactive: '已停用' })[row.status],
            },
            { title: '已发布版本', dataIndex: 'lastVersionNo' },
            {
              title: '操作',
              render: (_, row) => (
                <Space wrap>
                  <Button type="link" onClick={() => edit(row)}>
                    编辑草稿
                  </Button>
                  <Popconfirm
                    title="发布新版本？新申请将使用此审批链。"
                    onConfirm={() => mutation.mutateAsync(() => templateAction(row, 'publish'))}
                  >
                    <Button type="link">发布</Button>
                  </Popconfirm>
                  {row.status === 'active' && (
                    <Popconfirm
                      title="停用后不能提交新申请，进行中实例继续。"
                      onConfirm={() =>
                        mutation.mutateAsync(() => templateAction(row, 'deactivate'))
                      }
                    >
                      <Button type="link" danger>
                        停用
                      </Button>
                    </Popconfirm>
                  )}
                  <Button type="link" onClick={() => setHistoryId(row.id)}>
                    版本历史
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={editing === 'new' ? '新建模板' : '编辑下次发布的步骤'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={mutation.isPending}
        width={760}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(input) =>
            mutation.mutate(() =>
              saveTemplate(
                {
                  ...input,
                  draftSteps: input.draftSteps.map((step, index) => ({
                    ...step,
                    stepNo: index + 1,
                    userId: step.approverType === 'user' ? step.userId : null,
                  })),
                },
                editing && editing !== 'new' ? editing : undefined,
              ),
            )
          }
        >
          <Form.Item name="name" label="模板名称" rules={[{ required: true, min: 2, max: 50 }]}>
            <Input />
          </Form.Item>
          <Form.Item name="applicationType" label="申请类型">
            <Select options={types} disabled={editing !== 'new'} />
          </Form.Item>
          <Form.List name="draftSteps">
            {(fields, { add, remove, move }) => (
              <>
                {fields.map((field, index) => (
                  <Card
                    size="small"
                    title={`第 ${index + 1} 步`}
                    key={field.key}
                    style={{ marginBottom: 12 }}
                    extra={
                      <Space>
                        <Button
                          size="small"
                          disabled={index === 0}
                          onClick={() => move(index, index - 1)}
                        >
                          上移
                        </Button>
                        <Button
                          size="small"
                          disabled={fields.length === 1}
                          danger
                          onClick={() => remove(field.name)}
                        >
                          移除
                        </Button>
                      </Space>
                    }
                  >
                    <Form.Item
                      name={[field.name, 'name']}
                      label="步骤名称"
                      rules={[{ required: true, max: 50 }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item name={[field.name, 'approverType']} label="审批人类型">
                      <Select
                        options={[
                          { value: 'direct_manager', label: '直属上级' },
                          { value: 'department_manager', label: '部门负责人' },
                          { value: 'user', label: '指定用户' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item noStyle shouldUpdate>
                      {() =>
                        form.getFieldValue(['draftSteps', field.name, 'approverType']) ===
                        'user' ? (
                          <Form.Item
                            name={[field.name, 'userId']}
                            label="指定用户"
                            rules={[{ required: true }]}
                          >
                            <Select
                              loading={accounts.isPending}
                              options={(accounts.data ?? []).map((account) => ({
                                value: account.userId,
                                label: account.name,
                              }))}
                            />
                          </Form.Item>
                        ) : null
                      }
                    </Form.Item>
                  </Card>
                ))}
                <Button
                  disabled={fields.length >= 10}
                  onClick={() =>
                    add({
                      stepNo: fields.length + 1,
                      name: '审批',
                      approverType: 'direct_manager',
                      userId: null,
                    })
                  }
                >
                  增加步骤
                </Button>
              </>
            )}
          </Form.List>
        </Form>
        <Failure error={mutation.error ?? accounts.error} />
      </Modal>
      <Modal
        title="已发布版本（只读）"
        open={!!historyId}
        onCancel={() => setHistoryId(undefined)}
        footer={<Button onClick={() => setHistoryId(undefined)}>关闭</Button>}
      >
        <Failure error={versions.error} />
        {versions.isPending ? (
          <Spin />
        ) : (
          <Space direction="vertical" style={{ width: '100%' }}>
            {(versions.data ?? []).map((version) => (
              <Card
                key={version.id}
                size="small"
                title={`版本 ${version.versionNo} · ${date(version.publishedAt)}`}
              >
                <ol>
                  {version.steps.map((step) => (
                    <li key={step.stepNo}>
                      {step.name} ·{' '}
                      {
                        {
                          user: '固定用户',
                          direct_manager: '直属上级',
                          department_manager: '部门负责人',
                        }[step.approverType]
                      }
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </Space>
        )}
      </Modal>
    </div>
  );
}
