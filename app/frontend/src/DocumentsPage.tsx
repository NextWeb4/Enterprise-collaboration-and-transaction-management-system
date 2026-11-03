import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, TreeSelect, Typography } from 'antd';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { documentCreateSchema, documentCategorySchema, documentGrantSchema, documentTagSchema, documentTagColors } from '@collab/shared/schemas.js';
import type { DocumentBatchRequest, DocumentBatchResponse, DocumentCategoryView, DocumentCreateInput, DocumentGrantInput, DocumentSearchInput, DocumentTagView, DocumentView, MeResponse } from '@collab/shared/schemas.js';
import { listProjects } from './api';
import * as docs from './documents-api';

const visibilityOptions = [{ value: 'restricted', label: '仅授权成员' }, { value: 'project', label: '项目成员' }, { value: 'organization', label: '组织全员' }];
const previewableMimeTypes = new Set(['application/pdf', 'image/png', 'image/jpeg']);
type BulkOperation = DocumentBatchRequest['operation'];
function errorText(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }
function size(bytes: number): string { return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function canPreview(mime: string | undefined): boolean { return mime !== undefined && previewableMimeTypes.has(mime); }
function categoryOptions(categories: DocumentCategoryView[]): { value: string; title: string }[] {
  const label = (item: DocumentCategoryView, depth = 0): string => {
    const parent = categories.find((entry) => entry.id === item.parentId);
    return parent && depth < 5 ? label(parent, depth + 1) + ' / ' + item.name : item.name;
  };
  return categories.map((item) => ({ value: item.id, title: label(item) }));
}
export function DocumentsPage({ identity }: { identity: MeResponse }): ReactNode {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } }));
  return <QueryClientProvider client={client}><DocumentWorkspace identity={identity} /></QueryClientProvider>;
}
function DocumentWorkspace({ identity }: { identity: MeResponse }): ReactNode {
  const client = useQueryClient();
  const [filter, setFilter] = useState<DocumentSearchInput>({ q: '', page: 1, pageSize: 20, archived: false });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<DocumentView | 'new' | null>(null);
  const [taxonomy, setTaxonomy] = useState(false);
  const [bulkSelection, setBulkSelection] = useState<Map<string, DocumentView>>(() => new Map());
  const [bulkOperation, setBulkOperation] = useState<BulkOperation | null>(null);
  const [bulkCategoryId, setBulkCategoryId] = useState<string | null>(null);
  const [bulkTagIds, setBulkTagIds] = useState<string[]>([]);
  const [batchResult, setBatchResult] = useState<{ response: DocumentBatchResponse; titles: Record<string, string> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canRead = identity.permissions.includes('document:read');
  const results = useQuery({ queryKey: ['documents', filter], queryFn: () => docs.searchDocuments(filter), enabled: canRead });
  const classifications = useQuery({ queryKey: ['document-classifications'], queryFn: docs.classifications, enabled: canRead });
  const detail = useQuery({ queryKey: ['document', selected], queryFn: () => docs.getDocument(selected!), enabled: selected !== null });
  const versions = useQuery({ queryKey: ['document-versions', selected], queryFn: () => docs.documentVersions(selected!), enabled: selected !== null });
  const projects = useQuery({ queryKey: ['document-project-options'], queryFn: listProjects, enabled: canRead && identity.permissions.includes('project:read') });
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError(null);
    try { await action(); await client.invalidateQueries(); } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const submitBatch = async (): Promise<void> => {
    if (!bulkOperation || bulkSelection.size === 0) return;
    const selected = [...bulkSelection.values()];
    const items = selected.map(({ id, version }) => ({ id, version }));
    let request: DocumentBatchRequest;
    if (bulkOperation === 'move_category') request = { operation: bulkOperation, categoryId: bulkCategoryId, items };
    else if (bulkOperation === 'add_tags') request = { operation: bulkOperation, tagIds: bulkTagIds, items };
    else request = { operation: bulkOperation, items };
    setBusy(true); setError(null);
    try {
      const response = await docs.batchDocuments(request);
      setBatchResult({ response, titles: Object.fromEntries(selected.map((doc) => [doc.id, doc.title])) });
      setBulkSelection(new Map());
      setBulkOperation(null);
      await client.invalidateQueries();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };
  const changeFilter = (patch: Partial<DocumentSearchInput>): void => setFilter((current) => ({ ...current, ...patch, page: 1 }));
  const categoryList = classifications.data?.categories ?? [];
  const tags = classifications.data?.tags ?? [];
  const listedDocuments = results.data?.data ?? [];
  const canManageDocuments = identity.permissions.includes('document:acl:manage');
  const current = detail.data;
  const canManage = current?.level === 'manage';
  if (!canRead) return <Alert type="warning" showIcon message="没有查看文档中心的权限" />;
  return <div className="page-stack">
    <div className="page-heading"><div><Typography.Title level={2}>文档中心</Typography.Title><Typography.Text type="secondary">共享知识，保留每一次版本。检索结果仅显示你有权访问的文档。</Typography.Text></div>
      <Space>{(identity.permissions.includes('document:category:manage') || identity.permissions.includes('document:tag:manage')) && <Button onClick={() => setTaxonomy(true)}>分类与标签</Button>}{identity.permissions.includes('document:create') && <Button type="primary" onClick={() => setEditing('new')}>上传文档</Button>}</Space></div>
    {(error || results.error || classifications.error) && <Alert type="error" showIcon message={error ?? errorText(results.error ?? classifications.error)} action={<Button onClick={() => void run(() => client.invalidateQueries())}>重试</Button>} />}
    <Card><Space wrap>
      <Input.Search aria-label="搜索文档标题、标签或正文" placeholder="搜索标题、标签或正文" allowClear onSearch={(q) => changeFilter({ q })} style={{ width: 240 }} />
      <TreeSelect aria-label="分类筛选" placeholder="全部分类（含下级）" allowClear treeData={categoryOptions(categoryList)} onChange={(categoryId: string | undefined) => changeFilter({ categoryId })} style={{ minWidth: 180 }} />
      <Select aria-label="标签筛选" placeholder="标签" mode="multiple" allowClear options={tags.map((tag) => ({ value: tag.id, label: tag.name }))} onChange={(tagIds: string[]) => changeFilter({ tagIds })} style={{ minWidth: 170 }} />
      <Select aria-label="项目筛选" placeholder="全部项目" allowClear options={(projects.data ?? []).map((project) => ({ value: project.id, label: project.name }))} onChange={(projectId: string | undefined) => changeFilter({ projectId })} style={{ minWidth: 170 }} />
      <Select aria-label="可见性筛选" placeholder="全部可见性" allowClear options={visibilityOptions} onChange={(visibility: DocumentView['visibility'] | undefined) => changeFilter({ visibility })} style={{ minWidth: 150 }} />
      <Checkbox checked={filter.ownerId === identity.user.id} onChange={(event) => changeFilter({ ownerId: event.target.checked ? identity.user.id : undefined })}>我的文档</Checkbox>
      <Checkbox checked={filter.archived} onChange={(event) => changeFilter({ archived: event.target.checked })}>已归档</Checkbox>
    </Space><Space wrap style={{ marginTop: 12 }}><Typography.Text type="secondary">更新时间</Typography.Text><Input aria-label="更新开始时间" type="datetime-local" onChange={(event) => changeFilter({ from: event.target.value ? new Date(event.target.value).toISOString() : undefined })} /><Input aria-label="更新结束时间" type="datetime-local" onChange={(event) => changeFilter({ to: event.target.value ? new Date(event.target.value).toISOString() : undefined })} /></Space></Card>
    <Card title="文档库" extra={<Typography.Text type="secondary">{results.data?.meta.total ?? 0} 份文档</Typography.Text>}>
      {canManageDocuments && bulkSelection.size > 0 && <Space wrap style={{ marginBottom: 12 }}>
        <Typography.Text>已选 {bulkSelection.size} / 100</Typography.Text>
        <Button disabled={busy} onClick={() => { setBulkCategoryId(null); setBulkOperation('move_category'); }}>批量移动分类</Button>
        <Button disabled={busy} onClick={() => { setBulkTagIds([]); setBulkOperation('add_tags'); }}>批量添加标签</Button>
        <Button disabled={busy} onClick={() => setBulkOperation('archive')}>批量归档</Button>
        <Button type="link" onClick={() => setBulkSelection(new Map())}>清除选择</Button>
      </Space>}
      <Table<DocumentView> rowKey="id" loading={results.isLoading} dataSource={listedDocuments} rowSelection={canManageDocuments ? {
        selectedRowKeys: [...bulkSelection.keys()], preserveSelectedRowKeys: true,
        getCheckboxProps: (doc) => ({ disabled: doc.level !== 'manage' || doc.status !== 'active' }),
        onChange: (keys) => {
          if (keys.length > 100) { setError('批量操作最多选择 100 份文档。'); return; }
          const selectedIds = new Set(keys.map(String));
          setBulkSelection((currentSelection) => {
            const next = new Map(currentSelection);
            for (const doc of listedDocuments) {
              if (selectedIds.has(doc.id)) next.set(doc.id, doc); else next.delete(doc.id);
            }
            return next;
          });
        },
      } : undefined} locale={{ emptyText: <Empty description="没有符合条件的文档" /> }} scroll={{ x: 760 }} pagination={{ current: filter.page ?? 1, pageSize: 20, total: results.data?.meta.total ?? 0, onChange: (page) => setFilter((currentFilter) => ({ ...currentFilter, page })), showSizeChanger: false }} columns={[
        { title: '文档', render: (_: unknown, doc) => <div><Button type="link" onClick={() => setSelected(doc.id)}>{doc.title}</Button><div><Typography.Text type="secondary">{doc.currentFile?.fileName} · V{doc.versionCount}</Typography.Text></div></div> },
        { title: '分类 / 标签', render: (_: unknown, doc) => <Space wrap>{doc.categoryId && <Tag>{categoryList.find((item) => item.id === doc.categoryId)?.name}</Tag>}{doc.tagIds.map((id) => { const tag = tags.find((item) => item.id === id); return tag ? <Tag key={id} color={tag.color}>{tag.name}</Tag> : null; })}</Space> },
        { title: '范围', render: (_: unknown, doc) => visibilityOptions.find((item) => item.value === doc.visibility)?.label },
        { title: '大小', render: (_: unknown, doc) => doc.currentFile ? size(doc.currentFile.size) : '—' },
        { title: '更新时间', render: (_: unknown, doc) => new Date(doc.updatedAt).toLocaleString() },
        { title: '操作', render: (_: unknown, doc) => <Space><Button href={docs.documentDownloadUrl(doc.id)}>下载</Button>{canPreview(doc.currentFile?.mime) && <Button href={docs.documentPreviewUrl(doc.id)} target="_blank" rel="noopener noreferrer">预览</Button>}</Space> },
      ]} />
    </Card>
    <Modal title={bulkOperation === 'move_category' ? '批量移动分类' : bulkOperation === 'add_tags' ? '批量添加标签' : '批量归档'} open={bulkOperation !== null} onCancel={() => setBulkOperation(null)} onOk={() => void submitBatch()} confirmLoading={busy} okButtonProps={{ disabled: bulkSelection.size === 0 || (bulkOperation === 'add_tags' && bulkTagIds.length === 0) }} destroyOnClose>
      {bulkOperation === 'move_category' && <Form.Item label="目标分类"><TreeSelect aria-label="批量目标分类" value={bulkCategoryId ?? undefined} placeholder="根目录" allowClear treeData={categoryOptions(categoryList)} onChange={(value: string | undefined) => setBulkCategoryId(value ?? null)} /></Form.Item>}
      {bulkOperation === 'add_tags' && <Form.Item label="要添加的标签"><Select aria-label="批量添加标签" value={bulkTagIds} mode="multiple" maxCount={10} options={tags.map((tag) => ({ value: tag.id, label: tag.name }))} onChange={setBulkTagIds} /></Form.Item>}
      {bulkOperation === 'archive' && <Alert type="warning" showIcon message={`将归档已选择的 ${bulkSelection.size} 份文档。归档后内容与权限只读。`} />}
      <Typography.Paragraph type="secondary">逐项校验管理权限和版本；失败项不会阻止其他项提交，结果会列出每项状态。</Typography.Paragraph>
    </Modal>
    <Modal title="批量操作结果" open={batchResult !== null} onCancel={() => setBatchResult(null)} onOk={() => setBatchResult(null)} cancelButtonProps={{ style: { display: 'none' } }} destroyOnClose>
      {batchResult && <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text>成功 {batchResult.response.succeeded} 项，失败 {batchResult.response.failed} 项。</Typography.Text>
        {batchResult.response.results.map((item) => <Typography.Text key={item.id} type={item.success ? 'success' : 'danger'}>{item.success ? '成功' : `失败 · ${item.code} · ${item.message}`} · {batchResult.titles[item.id] ?? item.id}</Typography.Text>)}
      </Space>}
    </Modal>
    <Drawer title={current?.title ?? '文档详情'} width={760} open={selected !== null} onClose={() => setSelected(null)} destroyOnClose>
      {detail.isLoading ? <Spin /> : detail.error ? <Alert type="error" message={errorText(detail.error)} action={<Button onClick={() => void detail.refetch()}>重试</Button>} /> : current && <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {error && <Alert type="error" showIcon message={error} />}
        {current.readOnly && <Alert type="info" message="文档或关联项目已归档，内容与权限只读。" />}
        <Descriptions size="small" column={1} items={[{ key: 'description', label: '说明', children: <span style={{ whiteSpace: 'pre-wrap' }}>{current.description || '暂无说明'}</span> }, { key: 'owner', label: '所有者', children: current.ownerId === identity.user.id ? '我' : current.ownerId }, { key: 'access', label: '我的权限', children: ({ view: '查看', edit: '编辑', manage: '管理' })[current.level] }, { key: 'version', label: '当前版本', children: 'V' + current.versionCount }]} />
        <Space wrap><Button type="primary" href={docs.documentDownloadUrl(current.id)}>下载当前版本</Button>{canPreview(current.currentFile?.mime) && <Button href={docs.documentPreviewUrl(current.id)} target="_blank" rel="noopener noreferrer">预览当前版本</Button>}{!current.readOnly && current.level !== 'view' && identity.permissions.includes('document:update') && <Button onClick={() => setEditing(current)}>编辑信息</Button>}
          {!current.readOnly && canManage && identity.permissions.includes('document:acl:manage') && <Popconfirm title="归档后内容和权限将只读，确认归档？" onConfirm={() => run(() => docs.archiveDocument(current.id, current.version))}><Button loading={busy}>归档</Button></Popconfirm>}
          {canManage && identity.permissions.includes('document:delete') && <Popconfirm title="删除此文档？界面不提供恢复。" onConfirm={() => run(async () => { await docs.deleteDocument(current.id, current.version); setSelected(null); })}><Button danger loading={busy}>删除</Button></Popconfirm>}
        </Space>
        <Tabs items={[
          { key: 'versions', label: '版本记录', children: <Space direction="vertical" style={{ width: '100%' }}>{!current.readOnly && current.level !== 'view' && identity.permissions.includes('document:version:create') && <VersionUpload document={current} run={run} busy={busy} />}{versions.error && <Alert type="error" message={errorText(versions.error)} />}<Table rowKey="id" loading={versions.isLoading} dataSource={versions.data ?? []} pagination={false} columns={[{ title: '版本', dataIndex: 'versionNo', render: (value: number) => 'V' + value }, { title: '文件 / 备注', render: (_: unknown, version) => <div>{version.fileName}<br /><Typography.Text type="secondary">{version.versionNote || '无备注'} · {size(version.size)}</Typography.Text><details><summary>SHA-256 与上传记录</summary><Typography.Text code style={{ overflowWrap: 'anywhere' }}>{version.sha256}</Typography.Text><div>{version.uploadedBy} · {new Date(version.createdAt).toLocaleString()}</div></details></div> }, { title: '操作', render: (_: unknown, version) => <Space><Button href={docs.documentDownloadUrl(current.id, version.id)}>下载</Button>{canPreview(version.mime) && <Button href={docs.documentPreviewUrl(current.id, version.id)} target="_blank" rel="noopener noreferrer">预览</Button>}{!current.readOnly && current.level !== 'view' && identity.permissions.includes('document:version:create') && version.id !== current.currentVersionId && <Popconfirm title="将此历史版本复制为新的当前版本？历史记录不会被覆盖。" onConfirm={() => run(() => docs.restoreVersion(current.id, version.id, current.version, `恢复自 V${version.versionNo}`))}><Button>恢复为当前</Button></Popconfirm>}</Space> }]} /></Space> },
          ...(!current.readOnly && canManage && identity.permissions.includes('document:acl:manage') ? [{ key: 'acl', label: '访问授权', children: <DocumentAcl document={current} run={run} busy={busy} /> }] : []),
        ]} />
      </Space>}
    </Drawer>
    {editing && <DocumentEditor document={editing} categories={categoryList} tags={tags} projects={projects.data ?? []} onClose={() => setEditing(null)} onSave={(file, input) => run(async () => {
      if (editing === 'new') { if (!file) throw new Error('请选择文件'); const saved = await docs.uploadDocument(file, input); setSelected(saved.id); }
      else { const { projectId: _projectId, versionNote: _note, ...fields } = input; await docs.updateDocument(editing.id, { ...fields, version: editing.version }); }
      setEditing(null);
    })} busy={busy} error={error} />}
    <Modal title="分类与标签" open={taxonomy} footer={null} width={720} onCancel={() => setTaxonomy(false)} destroyOnClose><Taxonomy categories={categoryList} tags={tags} identity={identity} run={run} error={error} /></Modal>
  </div>;
}
function DocumentEditor({ document, categories, tags, projects, onClose, onSave, busy, error }: { document: DocumentView | 'new'; categories: DocumentCategoryView[]; tags: DocumentTagView[]; projects: { id: string; name: string }[]; onClose: () => void; onSave: (file: File | null, input: DocumentCreateInput) => Promise<void>; busy: boolean; error: string | null }): ReactNode {
  const [file, setFile] = useState<File | null>(null);
  const form = useForm<DocumentCreateInput>({ resolver: zodResolver(documentCreateSchema), defaultValues: document === 'new' ? { title: '', description: '', visibility: 'restricted', categoryId: null, tagIds: [], projectId: null, versionNote: '' } : { title: document.title, description: document.description, visibility: document.visibility, categoryId: document.categoryId, tagIds: document.tagIds, projectId: document.projectId, versionNote: '' } });
  return <Modal title={document === 'new' ? '上传文档' : '编辑文档信息'} open onCancel={onClose} onOk={() => void form.handleSubmit((values) => onSave(file, values))()} confirmLoading={busy} destroyOnClose>
    {error && <Alert type="error" message={error} />}<Form layout="vertical">
      {document === 'new' && <Form.Item label="文件"><Input aria-label="文档文件" type="file" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv" onChange={(event) => { const chosen = event.target.files?.[0] ?? null; setFile(chosen); if (chosen && !form.getValues('title')) form.setValue('title', chosen.name.slice(0, 100)); }} /></Form.Item>}
      <Form.Item label="标题" validateStatus={form.formState.errors.title ? 'error' : undefined} help={form.formState.errors.title?.message}><Controller name="title" control={form.control} render={({ field }) => <Input {...field} maxLength={100} />} /></Form.Item>
      <Form.Item label="说明"><Controller name="description" control={form.control} render={({ field }) => <Input.TextArea {...field} maxLength={1000} rows={4} />} /></Form.Item>
      <Form.Item label="分类"><Controller name="categoryId" control={form.control} render={({ field }) => <TreeSelect {...field} value={field.value ?? undefined} allowClear treeData={categoryOptions(categories)} onChange={(value: string | undefined) => field.onChange(value ?? null)} />} /></Form.Item>
      <Form.Item label="标签（最多 10 个）"><Controller name="tagIds" control={form.control} render={({ field }) => <Select {...field} mode="multiple" maxCount={10} options={tags.map((tag) => ({ value: tag.id, label: tag.name }))} />} /></Form.Item>
      {document === 'new' && <Form.Item label="关联项目"><Controller name="projectId" control={form.control} render={({ field }) => <Select {...field} allowClear options={projects.map((project) => ({ value: project.id, label: project.name }))} onChange={(value: string | undefined) => field.onChange(value ?? null)} />} /></Form.Item>}
      <Form.Item label="可见性"><Controller name="visibility" control={form.control} render={({ field }) => <Select {...field} disabled={document !== 'new' && document.level !== 'manage'} options={visibilityOptions} />} /></Form.Item>
      {document === 'new' && <Form.Item label="版本说明"><Controller name="versionNote" control={form.control} render={({ field }) => <Input {...field} maxLength={200} />} /></Form.Item>}
      {Object.values(form.formState.errors).length > 0 && <Alert type="error" message="请检查必填字段及长度。" />}
    </Form>
  </Modal>;
}
function VersionUpload({ document, run, busy }: { document: DocumentView; run: (action: () => Promise<unknown>) => Promise<void>; busy: boolean }): ReactNode {
  const [file, setFile] = useState<File | null>(null); const [note, setNote] = useState('');
  return <Card size="small" title="追加新版本"><Space direction="vertical" style={{ width: '100%' }}><Input aria-label="新版本文件" type="file" accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.md,.csv" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><Input aria-label="版本说明" placeholder="本次版本说明（可选）" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} /><Button loading={busy} disabled={!file} onClick={() => void run(async () => { if (file) await docs.uploadVersion(document.id, file, document.version, note); setFile(null); setNote(''); })}>上传新版本</Button></Space></Card>;
}
function DocumentAcl({ document, run, busy }: { document: DocumentView; run: (action: () => Promise<unknown>) => Promise<void>; busy: boolean }): ReactNode {
  const grants = useQuery({ queryKey: ['document-grants', document.id], queryFn: () => docs.documentGrants(document.id) });
  const subjects = useQuery({ queryKey: ['document-subjects', document.id], queryFn: () => docs.documentSubjects(document.id) });
  const form = useForm<DocumentGrantInput>({ resolver: zodResolver(documentGrantSchema), defaultValues: { subjectType: 'user', subjectId: '', permission: 'view', includeDescendants: false } });
  const subjectType = useWatch({ control: form.control, name: 'subjectType' });
  const options = subjects.data?.[subjectType === 'user' ? 'users' : subjectType === 'role' ? 'roles' : 'departments'] ?? [];
  return <Space direction="vertical" style={{ width: '100%' }}>
    {(grants.error || subjects.error) && <Alert type="error" message={errorText(grants.error ?? subjects.error)} />}
    <Alert type="info" message="所有者始终可管理。显式授权只能扩大访问；撤销后立即按当前权限重新校验。" />
    <Form layout="vertical" onFinish={() => void form.handleSubmit((fields) => run(() => docs.saveDocumentGrant(document.id, fields)))()}>
      <Space wrap><Controller name="subjectType" control={form.control} render={({ field }) => <Select {...field} aria-label="授权对象类型" options={[{ value: 'user', label: '用户' }, { value: 'role', label: '系统角色' }, { value: 'department', label: '部门' }]} onChange={(value) => { field.onChange(value); form.setValue('subjectId', ''); form.setValue('includeDescendants', false); }} />} />
        <Controller name="subjectId" control={form.control} render={({ field }) => <Select {...field} aria-label="授权对象" showSearch optionFilterProp="label" style={{ minWidth: 180 }} options={options.map((subject) => ({ value: subject.id, label: subject.name }))} />} />
        <Controller name="permission" control={form.control} render={({ field }) => <Select {...field} aria-label="授权级别" options={[{ value: 'view', label: '查看' }, { value: 'edit', label: '编辑' }, { value: 'manage', label: '管理' }]} />} />
        {subjectType === 'department' && <Controller name="includeDescendants" control={form.control} render={({ field }) => <Checkbox checked={field.value} onChange={(event) => field.onChange(event.target.checked)}>包含子部门</Checkbox>} />}<Button htmlType="submit" type="primary" loading={busy}>保存授权</Button></Space>
      {form.formState.errors.subjectId && <Typography.Text type="danger">请选择授权对象</Typography.Text>}
    </Form>
    <Table rowKey="id" loading={grants.isLoading} dataSource={grants.data ?? []} pagination={false} columns={[{ title: '对象', render: (_: unknown, grant) => { const list = subjects.data?.[grant.subjectType === 'user' ? 'users' : grant.subjectType === 'role' ? 'roles' : 'departments']; return (list?.find((item) => item.id === grant.subjectId)?.name ?? grant.subjectId) + (grant.includeDescendants ? '（含子部门）' : ''); } }, { title: '权限', dataIndex: 'permission' }, { title: '操作', render: (_: unknown, grant) => <Popconfirm title="撤销此授权？" onConfirm={() => run(() => docs.revokeDocumentGrant(document.id, grant.id))}><Button danger disabled={grant.subjectType === 'user' && grant.subjectId === document.ownerId}>撤销</Button></Popconfirm> }]} />
  </Space>;
}
function Taxonomy({ categories, tags, identity, run, error }: { categories: DocumentCategoryView[]; tags: DocumentTagView[]; identity: MeResponse; run: (action: () => Promise<unknown>) => Promise<void>; error: string | null }): ReactNode {
  const [category, setCategory] = useState<DocumentCategoryView | null>(null); const [tag, setTag] = useState<DocumentTagView | null>(null);
  const categoryForm = useForm({ resolver: zodResolver(documentCategorySchema), defaultValues: { name: '', parentId: null as string | null, sortOrder: 0 } });
  const tagForm = useForm<{ name: string; color: typeof documentTagColors[number] }>({ resolver: zodResolver(documentTagSchema), defaultValues: { name: '', color: 'blue' } });
  return <>{error && <Alert type="error" message={error} />}<Tabs items={[
    { key: 'categories', label: '分类', children: <Space direction="vertical" style={{ width: '100%' }}>{identity.permissions.includes('document:category:manage') && <Form layout="vertical" onFinish={() => void categoryForm.handleSubmit((fields) => run(async () => { await docs.saveCategory(category?.id ?? null, { ...fields, ...(category ? { version: category.version } : {}) }); setCategory(null); categoryForm.reset({ name: '', parentId: null, sortOrder: 0 }); }))()}><Space wrap><Controller name="name" control={categoryForm.control} render={({ field }) => <Input {...field} aria-label="分类名称" placeholder="分类名称（2–50 字）" maxLength={50} />} /><Controller name="parentId" control={categoryForm.control} render={({ field }) => <Select {...field} aria-label="父分类" placeholder="顶级分类" allowClear options={categories.filter((item) => item.id !== category?.id).map((item) => ({ value: item.id, label: item.name }))} onChange={(value: string | undefined) => field.onChange(value ?? null)} style={{ minWidth: 160 }} />} /><Controller name="sortOrder" control={categoryForm.control} render={({ field }) => <InputNumber {...field} aria-label="分类排序" min={0} max={1000000} />} /><Button htmlType="submit">{category ? '保存分类' : '新增分类'}</Button>{category && <Button onClick={() => { setCategory(null); categoryForm.reset({ name: '', parentId: null, sortOrder: 0 }); }}>取消编辑</Button>}</Space>{categoryForm.formState.errors.name && <Typography.Text type="danger">分类名称需要 2–50 字</Typography.Text>}</Form>}<Table rowKey="id" dataSource={categories} pagination={false} columns={[{ title: '分类', render: (_: unknown, item) => categoryOptions(categories).find((option) => option.value === item.id)?.title }, { title: '排序', dataIndex: 'sortOrder' }, { title: '操作', render: (_: unknown, item) => identity.permissions.includes('document:category:manage') && <Space><Button onClick={() => { setCategory(item); categoryForm.reset({ name: item.name, parentId: item.parentId, sortOrder: item.sortOrder }); }}>编辑</Button><Popconfirm title="删除此分类？必须没有文档或子分类。" onConfirm={() => run(() => docs.deleteCategory(item.id, item.version))}><Button danger>删除</Button></Popconfirm></Space> }]} /></Space> },
    { key: 'tags', label: '标签', children: <Space direction="vertical" style={{ width: '100%' }}>{identity.permissions.includes('document:tag:manage') && <Form onFinish={() => void tagForm.handleSubmit((fields) => run(async () => { await docs.saveTag(tag?.id ?? null, { ...fields, ...(tag ? { version: tag.version } : {}) }); setTag(null); tagForm.reset({ name: '', color: 'blue' }); }))()}><Space><Controller name="name" control={tagForm.control} render={({ field }) => <Input {...field} aria-label="标签名称" placeholder="标签名称" maxLength={20} />} /><Controller name="color" control={tagForm.control} render={({ field }) => <Select {...field} aria-label="标签颜色" options={documentTagColors.map((color) => ({ value: color, label: <Tag color={color}>{color}</Tag> }))} />} /><Button htmlType="submit">{tag ? '保存标签' : '新增标签'}</Button>{tag && <Button onClick={() => { setTag(null); tagForm.reset({ name: '', color: 'blue' }); }}>取消编辑</Button>}</Space>{tagForm.formState.errors.name && <Typography.Text type="danger">请输入标签名称</Typography.Text>}</Form>}<Table rowKey="id" dataSource={tags} pagination={false} columns={[{ title: '标签', render: (_: unknown, item) => <Tag color={item.color}>{item.name}</Tag> }, { title: '操作', render: (_: unknown, item) => identity.permissions.includes('document:tag:manage') && <Space><Button onClick={() => { setTag(item); tagForm.reset({ name: item.name, color: item.color }); }}>编辑</Button><Popconfirm title="删除此标签？将自动解除文档关联。" onConfirm={() => run(() => docs.deleteTag(item.id, item.version))}><Button danger>删除</Button></Popconfirm></Space> }]} /></Space> },
  ]} /></>;
}
