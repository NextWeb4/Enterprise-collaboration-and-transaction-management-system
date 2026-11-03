import { useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Form, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { moveTask } from './api';
import type { Task } from './api';

type BoardStatus = Exclude<Task['status'], 'cancelled'>;
const statuses: { value: BoardStatus; label: string }[] = [{ value: 'todo', label: '待处理' }, { value: 'in_progress', label: '进行中' }, { value: 'in_review', label: '待验收' }, { value: 'done', label: '已完成' }];
export function TaskBoard({ tasks, writable, onRefresh }: { tasks: Task[]; writable: boolean; onRefresh: () => Promise<void> }): ReactNode {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [form] = Form.useForm<{ targetStatus: BoardStatus; targetIndex: number; progress: number }>();
  const run = async (task: Task, targetStatus: BoardStatus, targetIndex: number, progress?: number): Promise<void> => {
    setBusy(true); setError(null);
    try { await moveTask(task.id, { version: task.version, targetStatus, targetIndex, ...(progress === undefined ? {} : { progress }) }); setEditing(null); await onRefresh(); }
    catch (err) { setError(err instanceof Error ? err.message : '移动任务失败'); }
    finally { setBusy(false); }
  };
  return <div>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
    <div className="task-board">{statuses.map((status) => {
      const column = tasks.filter((task) => task.status === status.value).sort((a, b) => (a.boardOrder ?? 0) - (b.boardOrder ?? 0) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
      return <section className="task-board-column" key={status.value} aria-label={status.label}><Typography.Text strong>{status.label} · {column.length}</Typography.Text>
        {column.map((task, index) => <Card key={task.id} size="small" title={task.taskKey}><Typography.Paragraph>{task.title}</Typography.Paragraph><Typography.Text type="secondary">进度 {task.progress}%</Typography.Text>{writable && <div><Space wrap><Button size="small" disabled={busy || index === 0} aria-label={`${task.taskKey} 上移`} onClick={() => void run(task, status.value, index - 1)}>上移</Button><Button size="small" disabled={busy || index === column.length - 1} aria-label={`${task.taskKey} 下移`} onClick={() => void run(task, status.value, index + 1)}>下移</Button><Button size="small" onClick={() => { setEditing(task); form.setFieldsValue({ targetStatus: status.value, targetIndex: index, progress: task.progress }); }}>移动</Button></Space></div>}</Card>)}
      </section>;
    })}</div>
    <Modal title={`移动 ${editing?.taskKey ?? ''}`} open={editing !== null} onCancel={() => setEditing(null)} onOk={() => form.submit()} confirmLoading={busy} destroyOnClose>
      <Form form={form} layout="vertical" onFinish={(values) => { if (editing) void run(editing, values.targetStatus, values.targetIndex, values.progress); }}>
        <Form.Item name="targetStatus" label="目标状态" rules={[{ required: true }]}><Select options={statuses} /></Form.Item>
        <Form.Item name="targetIndex" label="目标位置（从 0 开始）" rules={[{ required: true, type: 'number', min: 0 }]}><InputNumber min={0} precision={0} /></Form.Item>
        <Form.Item name="progress" label="进度（%）" rules={[{ required: true, type: 'number', min: 0, max: 100 }]} extra="完成任务须填 100%，待验收进度须大于 0。"><InputNumber min={0} max={100} precision={0} /></Form.Item>
      </Form>
    </Modal>
  </div>;
}
