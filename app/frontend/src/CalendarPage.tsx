import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Button, Calendar, Card, DatePicker, Empty, Form, Input, Modal, Popconfirm, Select, Segmented, Space, Spin, Tag, Typography } from 'antd';
import type { MeResponse } from '@collab/shared/schemas.js';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { listProjects } from './api';
import type { Project } from './api';
import { createCalendarEvent, deleteCalendarEvent, getCalendarEvent, listCalendarEvents, listCalendarParticipants, respondCalendarEvent, updateCalendarEvent } from './calendar-api';
import type { CalendarEvent, CalendarInput, CalendarKind, CalendarResponse } from './calendar-api';
import './calendar.css';

type FormValues = { kind: CalendarKind; projectId?: string; title: string; description?: string; location?: string; startAt: string; endAt: string; reminderMinutes?: 5 | 15 | 30 | 60 | null; participantIds?: string[] };
const kinds: Record<CalendarKind, string> = { personal: '个人日程', milestone: '项目里程碑', meeting: '会议' };
const responses: Record<Exclude<CalendarResponse, 'pending'>, string> = { accepted: '接受', declined: '拒绝', tentative: '待定' };

function dateInZone(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)?.value).join('-');
}
function todayInZone(timezone: string): Dayjs {
  const date = dateInZone(new Date().toISOString(), timezone);
  return dayjs(`${date}T12:00:00`);
}
function formatInZone(value: string, timezone: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
function inputInZone(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
function instantFromZone(value: string, timezone: string): string {
  const [date, time] = value.split('T');
  if (!date || !time) throw new Error('请填写完整时间');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const target = Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const represented = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
    instant += target - represented;
  }
  return new Date(instant).toISOString();
}
function monday(value: Dayjs): Dayjs { return value.subtract((value.day() + 6) % 7, 'day').startOf('day'); }

export function CalendarPage({ identity }: { identity: MeResponse }): ReactNode {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const timezone = identity.organization?.timezone ?? 'Asia/Shanghai';
  const [selectedDate, setSelectedDate] = useState(() => todayInZone(timezone));
  const [view, setView] = useState<'month' | 'week'>('month');
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [lastOpenedEvent, setLastOpenedEvent] = useState<string | null>(null);
  const [form] = Form.useForm<FormValues>();
  const can = (permission: string): boolean => identity.permissions.includes(permission);
  const canRead = identity.permissions.includes('calendar:read');

  const load = useCallback(async (): Promise<void> => {
    setLoading(true); setError(null);
    try {
      const from = view === 'month' ? selectedDate.startOf('month').subtract(7, 'day').startOf('day') : monday(selectedDate);
      const to = view === 'month' ? selectedDate.endOf('month').add(7, 'day').endOf('day') : monday(selectedDate).add(7, 'day');
      const result = await listCalendarEvents({ from: from.toDate().toISOString(), to: to.toDate().toISOString() });
      setEvents(result.data);
    } catch (err) { setError(err instanceof Error ? err.message : '日历加载失败'); }
    finally { setLoading(false); }
  }, [selectedDate, view]);

  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void Promise.all([listProjects().catch(() => [] as Project[]), listCalendarParticipants().catch(() => [] as Array<{ id: string; name: string }>)]).then(([loadedProjects, loadedPeople]) => {
      if (active) { setProjects(loadedProjects); setPeople(loadedPeople); }
    });
    return () => { active = false; };
  }, [canRead, identity.permissions]);
  useEffect(() => {
    if (!canRead) return;
    queueMicrotask(() => {
      void load();
    });
  }, [canRead, load]);
  useEffect(() => {
    const eventId = new URLSearchParams(window.location.search).get('event');
    if (!eventId || eventId === lastOpenedEvent || !canRead) return;
    let active = true;
    void getCalendarEvent(eventId).then((event) => {
      if (active) { setSelectedDate(dayjs(`${dateInZone(event.startAt, timezone)}T12:00:00`)); setLastOpenedEvent(eventId); }
    }).catch(() => setLastOpenedEvent(eventId));
    return () => { active = false; };
  }, [canRead, lastOpenedEvent, timezone]);

  const grouped = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const date = dateInZone(event.startAt, timezone);
      map.set(date, [...(map.get(date) ?? []), event]);
    }
    return map;
  }, [events, timezone]);
  const selectedKey = selectedDate.format('YYYY-MM-DD');
  const selectedEvents = grouped.get(selectedKey) ?? [];
  const selectedProject = (projectId: string | null): Project | undefined => projects.find((project) => project.id === projectId);
  const openCreate = (): void => {
    const start = selectedDate.hour(10).minute(0).second(0);
    form.resetFields();
    form.setFieldsValue({ kind: 'personal', title: '', startAt: inputInZone(start.toDate().toISOString(), timezone), endAt: inputInZone(start.add(1, 'hour').toDate().toISOString(), timezone), reminderMinutes: null, participantIds: [] });
    setEditing(null); setConflictNotice(null); setCreating(true);
  };
  const openEdit = (event: CalendarEvent): void => {
    form.setFieldsValue({ kind: event.kind, projectId: event.projectId ?? undefined, title: event.title, description: event.description, location: event.location, startAt: inputInZone(event.startAt, timezone), endAt: inputInZone(event.endAt, timezone), reminderMinutes: event.reminderMinutes, participantIds: event.participants.filter((participant) => participant.response !== 'declined').map((participant) => participant.userId) });
    setEditing(event); setConflictNotice(null); setCreating(true);
  };
  const submit = async (values: FormValues): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const input: CalendarInput = { kind: values.kind, projectId: values.projectId || null, title: values.title.trim(), description: values.description ?? '', location: values.location ?? '', startAt: instantFromZone(values.startAt, timezone), endAt: instantFromZone(values.endAt, timezone), reminderMinutes: values.reminderMinutes ?? null, participantIds: values.kind === 'meeting' ? values.participantIds ?? [] : [] };
      const result = editing ? await updateCalendarEvent(editing.id, editing.version, input) : await createCalendarEvent(input);
      if (result.conflicts.length) setConflictNotice(`发现 ${result.conflicts.length} 个参与人时段冲突；日程已保存，请确认时间安排。`);
      setCreating(false); await load();
    } catch (err) { setError(err instanceof Error ? err.message : '保存日程失败'); }
    finally { setBusy(false); }
  };
  const remove = async (event: CalendarEvent): Promise<void> => {
    setBusy(true); setError(null);
    try { await deleteCalendarEvent(event.id, event.version); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '删除日程失败'); }
    finally { setBusy(false); }
  };
  const respond = async (event: CalendarEvent, response: Exclude<CalendarResponse, 'pending'>): Promise<void> => {
    setBusy(true); setError(null);
    try { await respondCalendarEvent(event.id, event.version, response); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '更新会议响应失败'); }
    finally { setBusy(false); }
  };
  const renderEvents = (items: CalendarEvent[]): ReactNode => items.length ? items.map((event) => {
    const own = event.ownerId === identity.user.id;
    const participant = event.participants.find((item) => item.userId === identity.user.id);
    const project = selectedProject(event.projectId);
    return <div key={event.id} className="calendar-event-row">
      <div className="calendar-event-main">
        <Typography.Text strong>{formatInZone(event.startAt, timezone)}–{formatInZone(event.endAt, timezone).slice(-5)} {event.title}</Typography.Text>
        <Space wrap size={4}><Tag>{kinds[event.kind]}</Tag>{project && <Tag color="blue">{project.key}</Tag>}{participant && <Tag color={participant.response === 'accepted' ? 'green' : participant.response === 'declined' ? 'red' : 'gold'}>{participant.response === 'pending' ? '待响应' : responses[participant.response]}</Tag>}{event.location && <Typography.Text type="secondary">{event.location}</Typography.Text>}</Space>
        {own && event.participants.length > 0 && <Typography.Text type="secondary">响应：{event.participants.map((item) => `${people.find((person) => person.id === item.userId)?.name ?? '内部账号'} ${item.response === 'pending' ? '待响应' : responses[item.response]}`).join('、')}</Typography.Text>}
      </div>
      <Space wrap>
        {participant && participant.response !== 'declined' && <Select aria-label="会议响应" size="small" value={participant.response === 'pending' ? undefined : participant.response} placeholder="响应邀请" style={{ width: 108 }} onChange={(value: Exclude<CalendarResponse, 'pending'>) => void respond(event, value)} options={Object.entries(responses).map(([value, label]) => ({ value, label }))} disabled={!can('calendar:respond') || busy} />}
        {own && can('calendar:update') && <Button size="small" onClick={() => openEdit(event)}>编辑</Button>}
        {own && can('calendar:delete') && <Popconfirm title="删除此日程？" onConfirm={() => void remove(event)}><Button size="small" danger loading={busy}>删除</Button></Popconfirm>}
      </Space>
    </div>;
  }) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当天没有日程" />;

  if (!can('calendar:read')) return <Alert type="error" showIcon message="没有日历读取权限" />;
  const newButton = can('calendar:create') ? <Button type="primary" onClick={openCreate}>新建日程</Button> : null;
  const calendarCell = (date: Dayjs): ReactNode => {
    const count = grouped.get(date.format('YYYY-MM-DD'))?.length ?? 0;
    return count ? <div className="calendar-dot-count">{count} 项</div> : null;
  };
  return <div className="calendar-page">
    <Card title="日程与会议" extra={<Space><Segmented value={view} onChange={(value) => setView(value as 'month' | 'week')} options={[{ label: '月', value: 'month' }, { label: '周', value: 'week' }]} />{newButton}</Space>}>
      <Alert type="info" showIcon message="提醒在登录后打开日历时检查并补发；应用当前没有后台调度器，无法保证离线期间准点送达。" />
      {error && <Alert style={{ marginTop: 12 }} type="error" showIcon message={error} description={<Button size="small" onClick={() => void load()}>重试</Button>} />}
      {conflictNotice && <Alert style={{ marginTop: 12 }} type="warning" showIcon closable message={conflictNotice} onClose={() => setConflictNotice(null)} />}
      {loading ? <div className="calendar-loading"><Spin /></div> : <div className="calendar-layout">
        <div className="calendar-picker">
          {view === 'month' ? <Calendar fullscreen={false} value={selectedDate} onSelect={setSelectedDate} cellRender={(_date, info) => info.type === 'date' ? calendarCell(_date) : null} /> : <><DatePicker picker="week" value={selectedDate} onChange={(date) => date && setSelectedDate(date)} /><div className="calendar-week-days">{Array.from({ length: 7 }, (_, index) => monday(selectedDate).add(index, 'day')).map((date) => <Button key={date.format('YYYY-MM-DD')} type={date.isSame(selectedDate, 'day') ? 'primary' : 'default'} onClick={() => setSelectedDate(date)}>{date.format('ddd MM/DD')}<br />{grouped.get(date.format('YYYY-MM-DD'))?.length ?? 0} 项</Button>)}</div></>}
        </div>
        <section className="calendar-agenda" aria-label="选中日期的日程">
          <Typography.Title level={5}>{selectedDate.format('YYYY年MM月DD日')}</Typography.Title>
          {renderEvents(selectedEvents)}
        </section>
      </div>}
    </Card>
    <Modal title={editing ? '编辑日程' : '新建日程'} open={creating} onCancel={() => setCreating(false)} onOk={() => form.submit()} confirmLoading={busy} destroyOnHidden width={640}>
      <Form form={form} layout="vertical" initialValues={{ kind: 'personal', reminderMinutes: null, participantIds: [] }} onFinish={(values) => void submit(values)}>
        <Form.Item name="kind" label="类型" rules={[{ required: true }]}><Select options={Object.entries(kinds).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(before, after) => before.kind !== after.kind}>{({ getFieldValue }) => getFieldValue('kind') !== 'personal' ? <Form.Item name="projectId" label="关联项目"><Select allowClear showSearch optionFilterProp="label" options={projects.filter((project) => !['completed', 'cancelled', 'archived'].includes(project.status)).map((project) => ({ value: project.id, label: `${project.key} ${project.name}` }))} /></Form.Item> : null}</Form.Item>
        <Form.Item name="title" label="主题" rules={[{ required: true, max: 120 }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea maxLength={2000} rows={3} /></Form.Item>
        <Form.Item name="location" label="地点"><Input maxLength={160} /></Form.Item>
        <Space wrap>
          <Form.Item name="startAt" label={`开始时间（${timezone}）`} rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
          <Form.Item name="endAt" label={`结束时间（${timezone}）`} rules={[{ required: true }]}><Input type="datetime-local" /></Form.Item>
        </Space>
        <Form.Item name="reminderMinutes" label="提前提醒"><Select allowClear placeholder="不提醒" options={[5, 15, 30, 60].map((minutes) => ({ value: minutes, label: `提前 ${minutes} 分钟` }))} /></Form.Item>
        <Form.Item noStyle shouldUpdate={(before, after) => before.kind !== after.kind}>{({ getFieldValue }) => getFieldValue('kind') === 'meeting' ? <Form.Item name="participantIds" label="会议参与人"><Select mode="multiple" showSearch optionFilterProp="label" options={people.map((person) => ({ value: person.id, label: person.name }))} /></Form.Item> : null}</Form.Item>
      </Form>
    </Modal>
  </div>;
}
