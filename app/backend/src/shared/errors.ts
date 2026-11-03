import {
  ERROR_CODES,
  statusOf,
  type ErrorCode,
  type FieldError,
  type ProblemDetail,
} from '@collab/shared/errors.js';

/**
 * 统一业务错误：路由层不感知状态码细节，一律抛 AppError，
 * 由全局错误处理器转换为 problem+json（docs/03-technical/api-design.md §3.4）。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail?: string;
  readonly errors?: FieldError[];

  constructor(code: ErrorCode, detail?: string, errors?: FieldError[]) {
    super(detail ?? ERROR_CODES[code].title);
    this.name = 'AppError';
    this.code = code;
    this.status = statusOf(code);
    this.detail = detail;
    this.errors = errors;
  }

  toProblem(requestId?: string, instance?: string): ProblemDetail {
    return {
      type: `https://collab-office.local/errors/${this.code.toLowerCase().replaceAll('_', '-')}`,
      title: ERROR_CODES[this.code].title,
      status: this.status,
      code: this.code,
      detail: this.detail,
      instance,
      requestId,
      errors: this.errors,
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
