import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { HcmAdapterService } from './hcm-adapter.service';
import { SyncError } from './sync-error.entity';
import { BalanceService } from '../balance/balance.service';

export interface SyncResult {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  syncedAt: string;
}

@Injectable()
export class HcmSyncService {
  private readonly logger = new Logger(HcmSyncService.name);
  private lastSyncResult: SyncResult | null = null;

  constructor(
    private readonly hcmAdapter: HcmAdapterService,
    private readonly balanceService: BalanceService,
    @InjectRepository(SyncError)
    private readonly syncErrorRepo: Repository<SyncError>,
    private readonly config: ConfigService,
  ) {}

  /** Helper to safely extract error messages */
  private getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err ?? 'Unknown error');
  }

  @Cron(process.env.SYNC_CRON ?? '*/15 * * * *')
  async scheduledBatchSync() {
    this.logger.log('Starting scheduled HCM batch sync');
    await this.runBatchSync();
  }

  async runBatchSync(employeeId?: string): Promise<SyncResult> {
    let records = [];
    try {
      records = await this.hcmAdapter.fetchBatch();
    } catch (err) {
      this.logger.error(`HCM batch fetch failed: ${this.getErrorMessage(err)}`);
      return { total: 0, succeeded: 0, failed: 1, skipped: 0, syncedAt: new Date().toISOString() };
    }

    if (employeeId) {
      records = records.filter((r) => r.employeeId === employeeId);
    }

    const result: SyncResult = {
      total: records.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      syncedAt: new Date().toISOString(),
    };

    for (const record of records) {
      try {
        await this.balanceService.upsertFromHcm(
          record.employeeId,
          record.locationId,
          record.leaveType,
          record.totalBalance,
          new Date(),
        );
        result.succeeded++;
      } catch (err) {
        const errorMessage = this.getErrorMessage(err);
        result.failed++;
        this.logger.warn(`Sync failed for ${record.employeeId}/${record.locationId}: ${errorMessage}`);
        
        await this.syncErrorRepo.save(
          this.syncErrorRepo.create({
            employeeId: record.employeeId,
            locationId: record.locationId,
            rawPayload: JSON.stringify(record),
            errorMessage: errorMessage,
            attemptCount: 1,
            nextRetryAt: new Date(Date.now() + 60_000),
          }),
        );
      }
    }

    if (result.total > 0 && result.failed / result.total > 0.05) {
      this.logger.error(`⚠ Sync failure rate ${((result.failed / result.total) * 100).toFixed(1)}% exceeds 5% threshold`);
    }

    this.lastSyncResult = result;
    this.logger.log(`Batch sync complete: ${JSON.stringify(result)}`);
    return result;
  }

  @Cron('*/5 * * * *')
  async retryFailedSyncRecords() {
    const due = await this.syncErrorRepo.find({
      where: { resolved: false },
      order: { nextRetryAt: 'ASC' },
      take: 50,
    });

    for (const error of due) {
      if (error.nextRetryAt && new Date() < error.nextRetryAt) continue;
      if (error.attemptCount >= 3) {
        this.logger.warn(`Sync error ${error.id} exceeded max retries — giving up`);
        error.resolved = true;
        await this.syncErrorRepo.save(error);
        continue;
      }
      try {
        const record = JSON.parse(error.rawPayload);
        await this.balanceService.upsertFromHcm(
          record.employeeId, record.locationId, record.leaveType, record.totalBalance, new Date(),
        );
        error.resolved = true;
        await this.syncErrorRepo.save(error);
      } catch (err) {
        error.attemptCount++;
        error.errorMessage = this.getErrorMessage(err); // Updated with current error
        const delays = [60_000, 300_000, 1_800_000];
        error.nextRetryAt = new Date(Date.now() + (delays[error.attemptCount - 1] ?? 1_800_000));
        await this.syncErrorRepo.save(error);
      }
    }
  }

  getSyncStatus() {
    return {
      lastSync: this.lastSyncResult,
      pendingErrors: null,
    };
  }
}