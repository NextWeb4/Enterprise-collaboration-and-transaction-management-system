import type { DocumentBatchRequest, DocumentBatchResponse, DocumentCategoryInput, DocumentCategoryView, DocumentCreateInput, DocumentGrantInput, DocumentGrantView, DocumentSearchInput, DocumentTagInput, DocumentTagView, DocumentUpdateInput, DocumentVersionView, DocumentView } from '@collab/shared/schemas.js';
import { api, apiPage } from './api';
export interface DocumentSubjects { users: { id: string; name: string }[]; roles: { id: string; name: string }[]; departments: { id: string; name: string }[] }
export function searchDocuments(input: DocumentSearchInput): ReturnType<typeof apiPage<DocumentView>> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== '' && (!Array.isArray(value) || value.length)) search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  return apiPage<DocumentView>('/documents?' + search.toString());
}
export function getDocument(id: string): Promise<DocumentView> { return api('/documents/' + id); }
export function classifications(): Promise<{ categories: DocumentCategoryView[]; tags: DocumentTagView[] }> { return api('/documents/classifications'); }
export function uploadDocument(file: File, metadata: DocumentCreateInput): Promise<DocumentView> {
  const body = new FormData(); body.append('metadata', JSON.stringify(metadata)); body.append('file', file);
  return api('/documents', { method: 'POST', body });
}
export function uploadVersion(id: string, file: File, version: number, note: string): Promise<DocumentView> {
  const body = new FormData(); body.append('metadata', JSON.stringify({ version, note })); body.append('file', file);
  return api('/documents/' + id + '/versions', { method: 'POST', body });
}
export function updateDocument(id: string, input: DocumentUpdateInput): Promise<DocumentView> { return api('/documents/' + id, { method: 'PATCH', body: JSON.stringify(input) }); }
export function archiveDocument(id: string, version: number): Promise<DocumentView> { return api('/documents/' + id + '/archive', { method: 'POST', body: JSON.stringify({ version }) }); }
export function batchDocuments(input: DocumentBatchRequest): Promise<DocumentBatchResponse> { return api('/documents/batch', { method: 'POST', body: JSON.stringify(input) }); }
export function deleteDocument(id: string, version: number): Promise<{ success: boolean }> { return api('/documents/' + id, { method: 'DELETE', body: JSON.stringify({ version }) }); }
export function documentVersions(id: string): Promise<DocumentVersionView[]> { return api('/documents/' + id + '/versions'); }
export function restoreVersion(id: string, sourceVersionId: string, version: number, note = ''): Promise<DocumentView> { return api('/documents/' + id + '/versions/' + sourceVersionId + '/restore', { method: 'POST', body: JSON.stringify({ version, note }) }); }
export function documentGrants(id: string): Promise<DocumentGrantView[]> { return api('/documents/' + id + '/acl'); }
export function documentSubjects(id: string): Promise<DocumentSubjects> { return api('/documents/' + id + '/acl-subjects'); }
export function saveDocumentGrant(id: string, fields: DocumentGrantInput): Promise<DocumentGrantView> { return api('/documents/' + id + '/acl', { method: 'PUT', body: JSON.stringify(fields) }); }
export function revokeDocumentGrant(id: string, grantId: string): Promise<{ success: boolean }> { return api('/documents/' + id + '/acl/' + grantId, { method: 'DELETE' }); }
export function saveCategory(id: string | null, fields: DocumentCategoryInput & { version?: number }): Promise<DocumentCategoryView> { return api('/document-categories' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(fields) }); }
export function deleteCategory(id: string, version: number): Promise<{ success: boolean }> { return api('/document-categories/' + id, { method: 'DELETE', body: JSON.stringify({ version }) }); }
export function saveTag(id: string | null, fields: DocumentTagInput & { version?: number }): Promise<DocumentTagView> { return api('/document-tags' + (id ? '/' + id : ''), { method: id ? 'PATCH' : 'POST', body: JSON.stringify(fields) }); }
export function deleteTag(id: string, version: number): Promise<{ success: boolean }> { return api('/document-tags/' + id, { method: 'DELETE', body: JSON.stringify({ version }) }); }
export function documentDownloadUrl(id: string, versionId?: string): string {
  const origin = import.meta.env.DEV ? (import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000') : '';
  return origin + '/api/v1/documents/' + id + (versionId ? '/versions/' + versionId : '') + '/download';
}
export function documentPreviewUrl(id: string, versionId?: string): string {
  const origin = import.meta.env.DEV ? (import.meta.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:3000') : '';
  return origin + '/api/v1/documents/' + id + (versionId ? '/versions/' + versionId : '') + '/preview';
}
