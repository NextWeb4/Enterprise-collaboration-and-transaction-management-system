import type { BootstrapRecordDocument } from './models.js';
import type { CoreRepositories } from './repositories.js';
import { AppError } from '../../shared/errors.js';

export class BootstrapService {
  constructor(private readonly repos: CoreRepositories) {}

  async latest(): Promise<BootstrapRecordDocument | undefined> {
    return (await this.repos.bootstrapRecords.list({ page: 1, pageSize: 1, reverse: true })).items[0];
  }

  async writeAndRead(message: string): Promise<{ record: BootstrapRecordDocument; readBack: BootstrapRecordDocument }> {
    const record = await this.repos.bootstrapRecords.create({ message, source: 'bootstrap' });
    const readBack = await this.repos.bootstrapRecords.get(record.id);
    if (!readBack) throw new AppError('STORAGE_UNAVAILABLE', 'LMDB 写入后读取失败');
    return { record, readBack };
  }
}
