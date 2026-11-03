import { v7 as uuidV7 } from 'uuid';
import { AppError } from './errors.js';

/** UUIDv7 主键（决策 D-019） */
export function newId(): string {
  return uuidV7();
}

/** 复合键分隔符：ASCII Unit Separator，转义书写避免真实控制字符（docs/03-technical/data-storage-design.md §9） */
export const KEY_SEP = '\u001F';

export function joinKey(...parts: readonly string[]): string {
  return parts.join(KEY_SEP);
}

/** 数字索引键：零填充 12 位 */
export function pad12(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1e12) {
    throw new AppError('INTERNAL_ERROR', `序号超出可编码范围: ${String(value)}`);
  }
  return String(value).padStart(12, '0');
}

/** 前缀范围：start/end 使 range 恰好覆盖该前缀下所有键 */
export function prefixRange(prefix: string): { start: string; end: string } {
  return { start: `${prefix}${KEY_SEP}`, end: `${prefix}${KEY_SEP}\uffff` };
}

/** 键字段校验：拒绝控制字符与超长（docs/03-technical/data-storage-design.md §9/§20） */
export function assertValidKeyPart(part: string): void {
  if (part.length === 0) {
    throw new AppError('INTERNAL_ERROR', '键字段不能为空');
  }
  if (part.length > 512) {
    throw new AppError('INTERNAL_ERROR', '键字段过长');
  }
  if ([...part].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) {
    throw new AppError('INTERNAL_ERROR', '键字段包含非法控制字符');
  }
}
