import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import { createProject, createTask, deleteProject, deleteTask, getProject, listProjectMembers, listProjects, listTasks, transitionProject, updateProject, updateTask } from './api';
import type { Project, ProjectMember, Task } from './api';
import { ProjectMembers } from './ProjectMembers';
import { TaskComments } from './TaskComments';
import { TaskBoard } from './TaskBoard';
import { recordProjectVisit } from './workbench-api';

const projectStatuses: Record<Project['status'], string> = { planning: '规划中', active: '进行中', on_hold: '已暂停', completed: '已完成', cancelled: '已取消', archived: '已归档' };
const taskStatuses: Record<Task['status'], string> = { todo: '待处理', in_progress: '进行中', in_review: '待验收', done: '已完成', cancelled: '已取消' };
const transitions: Record<Project['status'], Project['status'][]> = { planning: ['active', 'cancelled'], active: ['on_hold', 'completed', 'cancelled'], on_hold: ['active', 'cancelled'], completed: ['archived'], cancelled: ['archived'], archived: [] };
const priorities: Record<Task['priority'], string> = { low: '低', medium: '中', high: '高', urgent: '紧急' };
function taskInput(values: { title: string; description?: string; priority: Task['priority']; assigneeId?: string; startDate?: string; dueDate?: string }, includeDefaultPriority = true): Omit<Parameters<typeof createTask>[1], 'title'> & { title: string } {
  return { title: values.title.trim(), ...(values.description?.trim() ? { description: values.description } : {}), ...(includeDefaultPriority || values.priority !== 'medium' ? { priority: values.priority } : {}), ...(values.assigneeId ? { assigneeId: values.assigneeId } : {}), ...(values.startDate ? { startDate: values.startDate } : {}), ...(values.dueDate ? { dueDate: values.dueDate } : {}) };
}

export function ProjectsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [taskCreating, setTaskCreating] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [editingMetadata, setEditingMetadata] = useState<Task | null>(null);
  const [commentTask, setCommentTask] = useState<Task | null>(null);
  const [transition, setTransition] = useState<Project['status'] | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [taskMembers, setTaskMembers] = useState<ProjectMember[]>([]);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [projectForm] = Form.useForm<{ name: string; key: string; description?: string; visibility: 'private' | 'organization'; startDate?: string; dueDate?: string }>();
  const [projectEditForm] = Form.useForm<{ name: string; description: string; visibility: 'private' | 'organization'; startDate?: string; dueDate?: string }>();
  const [taskForm] = Form.useForm<{ title: string; description?: string; priority: Task['priority']; assigneeId?: string; startDate?: string; dueDate?: string }>();
  const [editForm] = Form.useForm<{ status: Task['status']; progress: number }>();
  const [taskMetadataForm] = Form.useForm<{ title: string; description: string; priority: Task['priority']; assigneeId?: string; startDate?: string; dueDate?: string }>();
  const [reasonForm] = Form.useForm<{ reason: string }>();
  const can = (permission: string): boolean => identity.permissions.includes(permission);

  const loadProjects = useCallback(async (): Promise<void> => {
    setLoading(true);
    try { setProjects(await listProjects()); setError(null); } catch (err) { setError(err instanceof Error ? err.message : '项目加载失败'); }
    finally { setLoading(false); }
  }, []);
  const loadTasks = useCallback(async (project: Project): Promise<void> => {
    setSelected(project); setTasks([]); setTaskMembers([]); setFocusedTaskId(null); setLoading(true);
    if (identity.permissions.includes('workbench:read')) void recordProjectVisit(project.id).catch(() => undefined);
    try {
      if (!identity.permissions.includes('task:read')) {
        setError(null);
        return;
      }
      const [loadedTasks, members] = await Promise.all([
        listTasks(project.id),
        listProjectMembers(project.id).catch(() => [] as ProjectMember[]),
      ]);
      setTasks(loadedTasks);
      setTaskMembers(members);
      const taskId = new URLSearchParams(window.location.search).get('task');
      setFocusedTaskId(taskId && loadedTasks.some((task) => task.id === taskId) ? taskId : null);
      setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : '任务加载失败'); }
    finally { setLoading(false); }
  }, [identity.permissions]);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('project');
    if (!id || !identity.permissions.includes('project:read')) return;
    let active = true;
    void getProject(id).then((project) => { if (active) void loadTasks(project); }).catch((err: unknown) => { if (active) { setError(err instanceof Error ? err.message : '项目不可访问'); setLoading(false); } });
    return () => { active = false; };
  }, [identity.permissions, loadTasks]);
  useEffect(() => {
    if (!identity.permissions.includes('project:read')) return;
    let active = true;
    void listProjects().then((items) => { if (active) { setProjects(items); setError(null); } })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : '项目加载失败'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [identity.permissions]);
  useEffect(() => {
    if (!focusedTaskId) return;
    const timer = window.setTimeout(() => {
      document.getElementById(`task-${focusedTaskId}`)?.scrollIntoView?.({ block: 'center' });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [focusedTaskId, tasks]);
  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : '操作失败'); }
    finally { setBusy(false); }
  };

  if (!can('project:read')) return <Card><Alert type="warning" showIcon message="没有查看项目的权限" /></Card>;
  return <div className="page-stack">
    <div className="page-heading"><div><Typography.Title level={2}>项目与任务</Typography.Title><Typography.Text type="secondary">管理项目状态和任务进度。</Typography.Text></div>
      {!selected && can('project:create') && <Button type="primary" onClick={() => setCreating(true)}>新建项目</Button>}
      {selected && <Button onClick={() => { setSelected(null); setShowMembers(false); void loadProjects(); }}>返回项目列表</Button>}
    </div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    {loading ? <div className="page-loading"><Spin /></div> : !selected ? <Card title="项目列表">
      {projects.length === 0 ? <Empty description="暂无可访问项目" /> : <Table rowKey="id" dataSource={projects} pagination={false} columns={[
        { title: '项目', render: (_: unknown, project: Project) => <Button type="link" onClick={() => void loadTasks(project)}>{project.name}</Button> },
        { title: '短键', dataIndex: 'key' }, { title: '可见范围', render: (_: unknown, project: Project) => project.visibility === 'private' ? '私有' : '组织内' },
        { title: '状态', render: (_: unknown, project: Project) => <Tag>{projectStatuses[project.status]}</Tag> },
      ]} />}
    </Card> : <>
      <Card title={`${selected.name} (${selected.key})`} extra={<Space wrap>{can('project:update') && !['completed', 'cancelled', 'archived'].includes(selected.status) && <Button onClick={() => { projectEditForm.setFieldsValue({ name: selected.name, description: selected.description, visibility: selected.visibility, startDate: selected.startDate ?? undefined, dueDate: selected.dueDate ?? undefined }); setEditingProject(true); }}>编辑项目</Button>}{(can('project:update') || can('project:archive')) && transitions[selected.status].map((status) => <Button key={status} onClick={() => setTransition(status)}>{projectStatuses[status]}</Button>)}{can('project:delete') && <Popconfirm title="删除项目？" description="项目将被软删除，短键不会再次使用。" onConfirm={() => void run(async () => { await deleteProject(selected.id, selected.version); setSelected(null); setShowMembers(false); await loadProjects(); })}><Button danger>删除项目</Button></Popconfirm>}</Space>}>
        <Typography.Paragraph>{selected.description || '暂无项目描述'}</Typography.Paragraph><Tag>{projectStatuses[selected.status]}</Tag><Tag>{selected.visibility === 'private' ? '私有项目' : '组织内可见'}</Tag>{selected.startDate && <Tag>开始：{selected.startDate}</Tag>}{selected.dueDate && <Tag>截止：{selected.dueDate}</Tag>}<Button type="link" onClick={() => setShowMembers(!showMembers)}>{showMembers ? '收起成员' : '查看成员'}</Button>
      </Card>
      {showMembers && <ProjectMembers project={selected} identity={identity} onProjectChanged={setSelected} />}
      <Card title="任务" extra={<Space>{can('task:read') && <Button onClick={() => setShowBoard(!showBoard)}>{showBoard ? '列表视图' : '看板视图'}</Button>}{can('task:create') && selected.status === 'active' && <Button type="primary" onClick={() => { taskForm.resetFields(); taskForm.setFieldsValue({ priority: 'medium' }); setTaskCreating(true); }}>新建任务</Button>}</Space>}>
        {selected.status === 'planning' && <Typography.Paragraph type="secondary">启动项目后可添加任务。</Typography.Paragraph>}
        {!can('task:read') ? <Alert type="warning" message="没有查看任务的权限" /> : tasks.length === 0 ? <Empty description="暂无任务" /> : showBoard ? <TaskBoard tasks={tasks} writable={can('task:update') && !['completed', 'cancelled', 'archived'].includes(selected.status)} onRefresh={() => loadTasks(selected)} /> : <Table rowKey="id" dataSource={tasks} pagination={false} columns={[
          { title: '编号', dataIndex: 'taskKey' },
          { title: '任务', render: (_: unknown, task: Task) => <span id={`task-${task.id}`}>{task.title}{focusedTaskId === task.id && <Tag color="blue">定位任务</Tag>}</span> },
          { title: '负责人', render: (_: unknown, task: Task) => task.assigneeId ? taskMembers.find((member) => member.userId === task.assigneeId)?.name ?? '已分配' : '未分配' },
          { title: '优先级', render: (_: unknown, task: Task) => <Tag>{priorities[task.priority]}</Tag> },
          { title: '起止日期', render: (_: unknown, task: Task) => <span>{task.startDate ?? '—'} 至 {task.dueDate ?? '—'}</span> },
          { title: '状态', render: (_: unknown, task: Task) => <Tag>{taskStatuses[task.status]}</Tag> }, { title: '进度', render: (_: unknown, task: Task) => `${task.progress}%` },
          { title: '操作', render: (_: unknown, task: Task) => <Space>{can('task:read') && <Button type="link" onClick={() => setCommentTask(task)}>评论</Button>}{can('task:update') && !['completed', 'cancelled', 'archived'].includes(selected.status) && <Button type="link" onClick={() => { setEditingMetadata(task); taskMetadataForm.setFieldsValue({ title: task.title, description: task.description, priority: task.priority, assigneeId: task.assigneeId ?? undefined, startDate: task.startDate ?? undefined, dueDate: task.dueDate ?? undefined }); }}>编辑任务</Button>}{can('task:update') && !['completed', 'cancelled', 'archived'].includes(selected.status) && <Button type="link" onClick={() => { setEditing(task); editForm.setFieldsValue({ status: task.status, progress: task.progress }); }}>更新状态</Button>}{can('task:delete') && !['completed', 'cancelled', 'archived'].includes(selected.status) && <Popconfirm title="删除此任务？" onConfirm={() => void run(async () => { await deleteTask(task.id, task.version); await loadTasks(selected); })}><Button type="link" danger>删除</Button></Popconfirm>}</Space> },
        ]} />}
      </Card>
    </>}
    <Modal title="新建项目" open={creating} onCancel={() => setCreating(false)} onOk={() => projectForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={projectForm} layout="vertical" initialValues={{ visibility: 'private' }} onFinish={(values) => void run(async () => { await createProject({ name: values.name, key: values.key, visibility: values.visibility, ...(values.description?.trim() ? { description: values.description } : {}), ...(values.startDate ? { startDate: values.startDate } : {}), ...(values.dueDate ? { dueDate: values.dueDate } : {}) }); setCreating(false); projectForm.resetFields(); await loadProjects(); })}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, min: 2, max: 120 }]}><Input /></Form.Item>
        <Form.Item name="key" label="项目短键" extra="创建后不可修改，用于任务编号。" rules={[{ required: true, pattern: /^[A-Z][A-Z0-9]{1,9}$/, message: '请输入 2–10 位大写字母或数字，以字母开头' }]}><Input /></Form.Item>
        <Form.Item name="description" label="项目描述"><Input.TextArea maxLength={10000} /></Form.Item>
        <Form.Item name="visibility" label="可见范围" rules={[{ required: true }]}><Select options={[{ value: 'private', label: '仅项目成员' }, { value: 'organization', label: '组织内可见' }]} /></Form.Item>
        <Form.Item name="startDate" label="开始日期"><Input type="date" /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><Input type="date" /></Form.Item>
      </Form>
    </Modal>
    <Modal title="编辑项目" open={editingProject} onCancel={() => setEditingProject(false)} onOk={() => projectEditForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={projectEditForm} layout="vertical" onFinish={(values) => void run(async () => { if (!selected) return; const updated = await updateProject(selected.id, { name: values.name, description: values.description, visibility: values.visibility, version: selected.version, ...(values.startDate !== (selected.startDate ?? undefined) ? { startDate: values.startDate ?? null } : {}), ...(values.dueDate !== (selected.dueDate ?? undefined) ? { dueDate: values.dueDate ?? null } : {}) }); setSelected(updated); setEditingProject(false); })}>
        <Form.Item name="name" label="项目名称" rules={[{ required: true, min: 2, max: 120 }]}><Input /></Form.Item>
        <Form.Item name="description" label="项目描述"><Input.TextArea maxLength={10000} /></Form.Item>
        <Form.Item name="visibility" label="可见范围" rules={[{ required: true }]}><Select options={[{ value: 'private', label: '仅项目成员' }, { value: 'organization', label: '组织内可见' }]} /></Form.Item>
        <Form.Item name="startDate" label="开始日期"><Input type="date" /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><Input type="date" /></Form.Item>
      </Form>
    </Modal>
    <Modal title="新建任务" open={taskCreating} onCancel={() => setTaskCreating(false)} onOk={() => taskForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={taskForm} layout="vertical" initialValues={{ priority: 'medium' }} onFinish={(values) => void run(async () => { if (!selected) return; await createTask(selected.id, taskInput(values, false)); setTaskCreating(false); taskForm.resetFields(); await loadTasks(await getProject(selected.id)); })}>
        <Form.Item name="title" label="任务名称" rules={[{ required: true, min: 2, max: 120 }]}><Input /></Form.Item><Form.Item name="description" label="任务描述"><Input.TextArea maxLength={10000} /></Form.Item>
        <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select options={Object.entries(priorities).map(([value, label]) => ({ value, label }))} /></Form.Item>
        {can('task:assign') && <Form.Item name="assigneeId" label="负责人" extra="仅可分配给当前项目的在职成员。"><Select allowClear options={taskMembers.map((member) => ({ value: member.userId, label: `${member.name}（${member.role}）` }))} /></Form.Item>}
        <Form.Item name="startDate" label="开始日期"><Input type="date" /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><Input type="date" /></Form.Item>
      </Form>
    </Modal>
    <Modal title="编辑任务" open={editingMetadata !== null} onCancel={() => setEditingMetadata(null)} onOk={() => taskMetadataForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={taskMetadataForm} layout="vertical" onFinish={(values) => void run(async () => { if (!editingMetadata || !selected) return; await updateTask(editingMetadata.id, { version: editingMetadata.version, title: values.title.trim(), description: values.description, priority: values.priority, startDate: values.startDate ?? null, dueDate: values.dueDate ?? null, ...(can('task:assign') ? { assigneeId: values.assigneeId ?? null } : {}) }); setEditingMetadata(null); await loadTasks(selected); })}>
        <Form.Item name="title" label="任务名称" rules={[{ required: true, min: 2, max: 120 }]}><Input /></Form.Item>
        <Form.Item name="description" label="任务描述"><Input.TextArea maxLength={10000} /></Form.Item>
        <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><Select options={Object.entries(priorities).map(([value, label]) => ({ value, label }))} /></Form.Item>
        {can('task:assign') && <Form.Item name="assigneeId" label="负责人" extra="仅可分配给当前项目的在职成员。"><Select allowClear options={taskMembers.map((member) => ({ value: member.userId, label: `${member.name}（${member.role}）` }))} /></Form.Item>}
        <Form.Item name="startDate" label="开始日期"><Input type="date" /></Form.Item>
        <Form.Item name="dueDate" label="截止日期"><Input type="date" /></Form.Item>
      </Form>
    </Modal>
    <Modal title="更新任务" open={editing !== null} onCancel={() => setEditing(null)} onOk={() => editForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={editForm} layout="vertical" onFinish={(values) => void run(async () => { if (!editing || !selected) return; await updateTask(editing.id, { version: editing.version, ...values }); setEditing(null); await loadTasks(selected); })}>
        <Form.Item name="status" label="状态" rules={[{ required: true }]}><Select options={Object.entries(taskStatuses).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="progress" label="进度（%）" rules={[{ required: true, type: 'number', min: 0, max: 100 }]} extra="完成状态必须为 100%；其他状态的进度请遵守状态规则。"><InputNumber min={0} max={100} precision={0} /></Form.Item>
      </Form>
    </Modal>
    <Modal title={transition ? `项目${projectStatuses[transition]}` : '变更项目状态'} open={transition !== null} onCancel={() => setTransition(null)} onOk={() => reasonForm.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={reasonForm} layout="vertical" onFinish={(values) => void run(async () => { if (!selected || !transition) return; const project = await transitionProject(selected.id, { version: selected.version, targetStatus: transition, ...(values.reason ? { reason: values.reason } : {}) }); setTransition(null); reasonForm.resetFields(); await loadTasks(project); })}>
        <Form.Item name="reason" label="原因" rules={transition === 'cancelled' || transition === 'on_hold' ? [{ required: true, message: '请填写变更原因' }] : []}><Input.TextArea maxLength={500} /></Form.Item>
      </Form>
    </Modal>
    {commentTask && selected && <TaskComments task={commentTask} identity={identity} writable={!['completed', 'cancelled', 'archived'].includes(selected.status)} onClose={() => setCommentTask(null)} />}
  </div>;
}
