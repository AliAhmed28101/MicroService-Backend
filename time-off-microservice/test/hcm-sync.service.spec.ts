import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { HcmSyncService } from '../src/hcm-sync/hcm-sync.service';
import { SyncError } from '../src/hcm-sync/sync-error.entity';
import { HcmAdapterService } from '../src/hcm-sync/hcm-adapter.service';
import { BalanceService } from '../src/balance/balance.service';
import { LeaveType } from '../src/common/enums/enums';

const mockBatchRecords = [
  { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 20 },
  { employeeId: 'EMP-002', locationId: 'LOC-LA', leaveType: LeaveType.SICK, totalBalance: 10 },
  { employeeId: 'EMP-003', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 15 },
];

describe('HcmSyncService', () => {
  let service: HcmSyncService;
  let hcmAdapter: any;
  let balanceService: any;
  let syncErrorRepo: any;

  beforeEach(async () => {
    hcmAdapter = {
      fetchBatch: jest.fn().mockResolvedValue(mockBatchRecords),
    };

    balanceService = {
      upsertFromHcm: jest.fn().mockResolvedValue({}),
    };

    syncErrorRepo = {
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve(data)),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmSyncService,
        { provide: HcmAdapterService, useValue: hcmAdapter },
        { provide: BalanceService, useValue: balanceService },
        { provide: getRepositoryToken(SyncError), useValue: syncErrorRepo },
        { provide: ConfigService, useValue: { get: jest.fn((k, d) => d) } },
      ],
    }).compile();

    service = module.get<HcmSyncService>(HcmSyncService);
  });

  describe('runBatchSync', () => {
    it('syncs all records and reports correct counts', async () => {
      const result = await service.runBatchSync();
      expect(result.total).toBe(3);
      expect(result.succeeded).toBe(3);
      expect(result.failed).toBe(0);
      expect(balanceService.upsertFromHcm).toHaveBeenCalledTimes(3);
    });

    it('handles partial failures gracefully — writes to sync_errors', async () => {
      balanceService.upsertFromHcm
        .mockResolvedValueOnce({})  // EMP-001: OK
        .mockRejectedValueOnce(new Error('DB error')) // EMP-002: fail
        .mockResolvedValueOnce({});  // EMP-003: OK

      const result = await service.runBatchSync();
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(1);
      expect(syncErrorRepo.save).toHaveBeenCalledTimes(1);
    });

    it('handles HCM batch fetch failure gracefully', async () => {
      hcmAdapter.fetchBatch.mockRejectedValue(new Error('HCM down'));
      const result = await service.runBatchSync();
      expect(result.failed).toBe(1);
      expect(result.succeeded).toBe(0);
    });

    it('filters by employeeId when provided', async () => {
      const result = await service.runBatchSync('EMP-001');
      expect(result.total).toBe(1);
      expect(balanceService.upsertFromHcm).toHaveBeenCalledTimes(1);
      expect(balanceService.upsertFromHcm).toHaveBeenCalledWith(
        'EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 20, expect.any(Date),
      );
    });

    it('updates lastSyncResult after running', async () => {
      await service.runBatchSync();
      const status = service.getSyncStatus();
      expect(status.lastSync).not.toBeNull();
      expect(status.lastSync.total).toBe(3);
    });

    it('simulates anniversary accrual — balance updated to new total', async () => {
      // Simulate HCM sending a higher balance after anniversary
      hcmAdapter.fetchBatch.mockResolvedValue([
        { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 25 },
      ]);
      await service.runBatchSync();
      expect(balanceService.upsertFromHcm).toHaveBeenCalledWith(
        'EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 25, expect.any(Date),
      );
    });
  });

  describe('retryFailedSyncRecords', () => {
    it('retries pending sync errors', async () => {
      const dueError = {
        id: 'err-1',
        resolved: false,
        attemptCount: 1,
        nextRetryAt: new Date(Date.now() - 1000), // past due
        rawPayload: JSON.stringify({
          employeeId: 'EMP-002', locationId: 'LOC-LA',
          leaveType: LeaveType.SICK, totalBalance: 10,
        }),
      };
      syncErrorRepo.find.mockResolvedValue([dueError]);
      await service.retryFailedSyncRecords();
      expect(balanceService.upsertFromHcm).toHaveBeenCalledTimes(1);
      expect(dueError.resolved).toBe(true);
    });

    it('marks error as resolved after max attempts', async () => {
      const maxedError = {
        id: 'err-2',
        resolved: false,
        attemptCount: 3,
        nextRetryAt: new Date(Date.now() - 1000),
        rawPayload: JSON.stringify({}),
      };
      syncErrorRepo.find.mockResolvedValue([maxedError]);
      await service.retryFailedSyncRecords();
      expect(maxedError.resolved).toBe(true);
      expect(balanceService.upsertFromHcm).not.toHaveBeenCalled();
    });

    it('skips errors that are not yet due', async () => {
      const notDue = {
        id: 'err-3',
        resolved: false,
        attemptCount: 1,
        nextRetryAt: new Date(Date.now() + 60_000), // future
        rawPayload: '{}',
      };
      syncErrorRepo.find.mockResolvedValue([notDue]);
      await service.retryFailedSyncRecords();
      expect(balanceService.upsertFromHcm).not.toHaveBeenCalled();
    });
  });
});