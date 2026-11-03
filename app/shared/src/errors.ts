/**
 * 统一错误码与 problem+json 类型（来源：docs/03-technical/api-design.md §3.4/§10）。
 * code 是稳定契约；HTTP 状态码由本表统一决定。
 */

export interface FieldError {
  readonly path: string;
  readonly message: string;
}

interface ErrorCodeDef {
  readonly status: number;
  readonly title: string;
}

export const ERROR_CODES = {
  INTERNAL_ERROR: { status: 500, title: 'Internal Server Error' },
  VALIDATION_FAILED: { status: 422, title: 'Validation Failed' },
  UNAUTHENTICATED: { status: 401, title: 'Unauthenticated' },
  INVALID_CREDENTIALS: { status: 401, title: 'Invalid Credentials' },
  ACCOUNT_LOCKED: { status: 401, title: 'Account Locked' },
  ACCOUNT_DISABLED: { status: 401, title: 'Account Disabled' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  PASSWORD_CHANGE_REQUIRED: { status: 403, title: 'Password Change Required' },
  CSRF_INVALID: { status: 403, title: 'CSRF Validation Failed' },
  NOT_FOUND: { status: 404, title: 'Not Found' },
  VERSION_CONFLICT: { status: 409, title: 'Version Conflict' },
  USER_EMAIL_TAKEN: { status: 409, title: 'Email Already Taken' },
  LAST_ADMIN_PROTECTED: { status: 409, title: 'Last Admin Protected' },
  RATE_LIMITED: { status: 429, title: 'Too Many Requests' },
  FILE_TOO_LARGE: { status: 413, title: 'File Too Large' },
  FILE_TYPE_UNSUPPORTED: { status: 415, title: 'File Type Unsupported' },
  FILE_INVALID: { status: 415, title: 'File Invalid' },
  FILE_MISSING: { status: 410, title: 'File Missing' },
  FILE_CHECKSUM_MISMATCH: { status: 409, title: 'File Checksum Mismatch' },
  STORAGE_UNAVAILABLE: { status: 503, title: 'Storage Unavailable' },
  STORAGE_CORRUPTED: { status: 503, title: 'Storage Corrupted' },
  INITIALIZATION_REQUIRED: { status: 503, title: 'Initialization Required' },
  PROJECT_KEY_TAKEN: { status: 409, title: 'Project Key Taken' },
  PROJECT_STATE_INVALID: { status: 409, title: 'Project State Invalid' },
  PROJECT_HAS_OPEN_TASKS: { status: 409, title: 'Project Has Open Tasks' },
  TASK_STATE_INVALID: { status: 409, title: 'Task State Invalid' },
  TASK_PROGRESS_INVALID: { status: 422, title: 'Task Progress Invalid' },
  COMMENT_EDIT_WINDOW_EXPIRED: { status: 409, title: 'Comment Edit Window Expired' },
  WORKFLOW_TEMPLATE_MISSING: { status: 409, title: 'Workflow Template Missing' },
  APPROVER_UNRESOLVED: { status: 422, title: 'Approver Unresolved' },
  SELF_APPROVAL_FORBIDDEN: { status: 422, title: 'Self Approval Forbidden' },
  APPLICATION_STATE_INVALID: { status: 409, title: 'Application State Invalid' },
  APPROVAL_ALREADY_DECIDED: { status: 409, title: 'Approval Already Decided' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, title: 'Idempotency Key Reused' },
  CURRENT_APPROVER_ACTIVE: { status: 409, title: 'Current Approver Active' },
  WEAK_PASSWORD: { status: 422, title: 'Weak Password' },
} as const satisfies Record<string, ErrorCodeDef>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function statusOf(code: ErrorCode): number {
  return ERROR_CODES[code].status;
}

/** RFC 9457 problem+json 响应体（超集，含稳定 code 与 requestId） */
export interface ProblemDetail {
  type?: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: FieldError[];
}
