/**
 * 环境配置：启动时 Zod 校验，缺失/非法立即失败（docs/00-project/project-init.md §5.1）。
 * 数据目录安全检查为尽力而为：拒绝 UNC 路径与 OneDrive/同步目录路径（D-028）。
 */
import { z } from 'zod';
import { posix, resolve } from 'node:path';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  DATA_DIR: z.string().min(1),
  WEB_ORIGIN: z.string().min(1).optional(),
  SESSION_COOKIE_NAME: z.string().min(1).max(64).default('collab_session'),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(10_080).default(480),
  SESSION_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(25),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  TRUST_PROXY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly isProduction: boolean;
  readonly port: number;
  readonly host: string;
  readonly dataDir: string;
  readonly webOrigin: string;
  readonly sessionCookieName: string;
  readonly sessionIdleMinutes: number;
  readonly sessionAbsoluteDays: number;
  readonly maxUploadMb: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly trustProxy: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`环境变量校验失败: ${issues}`);
  }
  const values = parsed.data;
  assertLocalDataDir(values.DATA_DIR);
  return {
    nodeEnv: values.NODE_ENV,
    isProduction: values.NODE_ENV === 'production',
    port: values.PORT,
    host: values.HOST,
    dataDir: values.DATA_DIR,
    webOrigin: values.WEB_ORIGIN ?? (values.NODE_ENV === 'production' ? `http://127.0.0.1:${values.PORT}` : 'http://127.0.0.1:5173'),
    sessionCookieName: values.SESSION_COOKIE_NAME,
    sessionIdleMinutes: values.SESSION_IDLE_MINUTES,
    sessionAbsoluteDays: values.SESSION_ABSOLUTE_DAYS,
    maxUploadMb: values.MAX_UPLOAD_MB,
    logLevel: values.LOG_LEVEL,
    trustProxy: values.TRUST_PROXY,
  };
}

/** 尽力而为的本地盘检查：拒绝 UNC 网络路径与 OneDrive/同步目录（docs/03-technical/data-storage-design.md §4） */
export function assertLocalDataDir(dataDir: string, platform: NodeJS.Platform = process.platform): void {
  const normalized = dataDir.replaceAll('/', '\\');
  if (normalized.startsWith('\\\\')) {
    throw new ConfigError(`DATA_DIR 不能是网络共享路径(UNC): ${dataDir}`);
  }
  const segments = resolve(dataDir).replaceAll('/', '\\').split('\\').map((segment) => segment.toLowerCase());
  if (segments.some((segment) => segment.includes('onedrive') || segment.includes('dropbox'))) {
    throw new ConfigError(`DATA_DIR 不能位于同步目录(OneDrive/Dropbox 等)内: ${dataDir}`);
  }
  if (platform !== 'win32' && posix.isAbsolute(dataDir)) return;
  if (/^[a-zA-Z]:/.test(normalized) === false && normalized.startsWith('.')) {
    // 相对路径允许（开发默认 ./），但要求工作目录在本地盘；此处仅提示性检查
    return;
  }
  if (!/^[a-zA-Z]:/.test(normalized) && !normalized.startsWith('.')) {
    throw new ConfigError(`DATA_DIR 必须是盘符路径或相对路径: ${dataDir}`);
  }
}
