import { api, type Account } from './api';

export function enableAccount(id: string, version: number): Promise<Account> {
  return api(`/users/${encodeURIComponent(id)}/enable`, { method: 'POST', body: JSON.stringify({ version }) });
}
export function resetAccountPassword(id: string, version: number): Promise<{ user: Account; temporaryPassword: string }> {
  return api(`/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: JSON.stringify({ version }) });
}
export function forceLogoutAccount(id: string, version: number): Promise<{ revokedSessions: number }> {
  return api(`/users/${encodeURIComponent(id)}/force-logout`, { method: 'POST', body: JSON.stringify({ version }) });
}
