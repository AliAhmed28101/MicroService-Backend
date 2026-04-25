/**
 * Unit Tests — BalanceService
 *
 * Covers: findAll, findOne, upsertFromHcm (create + update paths),
 * acquireLock (found + not-found), isStale, syncFromHcmRealtime,
 * batchSync (success, partial failure, empty), getLastSyncStatus, audit.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';

import { BalanceService } from '../../src/balance/balance.service';
import { LeaveBalance, LeaveType } from '../../src/balance/leave-balance.entity';
import { AuditLog } from '../../src/entities/audit-log.entity';
import { HcmAdapter } from '../../src/hcm-sync/hcm-adapter.service';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return Object.assign(new LeaveBalance(), {
    id: 'bal-1',
    employeeId: 'EMP-001',
    locationId: 'LOC-NYC',
    leaveType: LeaveType.ANNUAL,
    totalBalance: 20,
    usedBalance: 5,
    pendingBalance: 2,
    hcmSyncedAt: new Date(Date.now() - 60_000), // 1 minute ago — fresh
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockBalanceRepo = {
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
};

const mockAuditRepo = {
  create: jest.fn(),
  save: jest.fn(),
};

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: { findOne: jest.fn() },
};

const mockDataSource = {
  createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
};

const mockHcmAdapter = {
  getBalance: jest.fn(),
  getBatchBalances: jest.fn(),
};

const mockConfig = { get: jest.fn((k: string, d: any) => d) };

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('BalanceService', () => {
  let service: BalanceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
    mockAuditRepo.create.mockReturnValue({});
    mockAuditRepo.save.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(LeaveBalance), useValue: mockBalanceRepo },
        { provide: getRepositoryToken(AuditLog), useValue: mockAuditRepo },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: HcmAdapter, useValue: mockHcmAdapter },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
  });

  // ── findAll ────────────────────────────────────────────────────────────────

  describe('findAll()', () => {
    it('returns all balances for an employee + location', async () => {
      const rows = [makeBalance(), makeBalance({ leaveType: LeaveType.SICK })];
      mockBalanceRepo.find.mockResolvedValue(rows);
      const result = await service.findAll('EMP-001', 'LOC-NYC');
      expect(result).toHaveLength(2);
      expect(mockBalanceRepo.find).toHaveBeenCalledWith({ where: { employeeId: 'EMP-001', locationId: 'LOC-NYC' } });
    });

    it('throws NotFoundException when no rows exist', async () => {
      mockBalanceRepo.find.mockResolvedValue([]);
      await expect(service.findAll('EMP-999', 'LOC-X')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findOne ────────────────────────────────────────────────────────────────

  describe('findOne()', () => {
    it('returns the specific balance row', async () => {
      const row = makeBalance();
      mockBalanceRepo.findOne.mockResolvedValue(row);
      const result = await service.findOne('EMP-001', 'LOC-NYC', LeaveType.ANNUAL);
      expect(result).toEqual(row);
    });

    it('throws NotFoundException when balance does not exist', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('EMP-001', 'LOC-NYC', LeaveType.SICK)).rejects.toThrow(NotFoundException);
    });
  });

  // ── availableBalance computed property ─────────────────────────────────────

  describe('LeaveBalance.availableBalance (computed)', () => {
    it('calculates correctly: total - used - pending', () => {
      const b = makeBalance({ totalBalance: 20, usedBalance: 5, pendingBalance: 3 });
      expect(b.availableBalance).toBe(12);
    });

    it('returns 0 when fully consumed', () => {
      const b = makeBalance({ totalBalance: 10, usedBalance: 7, pendingBalance: 3 });
      expect(b.availableBalance).toBe(0);
    });

    it('handles zero-balance row', () => {
      const b = makeBalance({ totalBalance: 0, usedBalance: 0, pendingBalance: 0 });
      expect(b.availableBalance).toBe(0);
    });
  });

  // ── upsertFromHcm ──────────────────────────────────────────────────────────

  describe('upsertFromHcm()', () => {
    const hcmData = { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 25 };

    it('creates a new row when none exists', async () => {
      mockBalanceRepo.findOne.mockResolvedValue(null);
      const newRow = makeBalance({ totalBalance: 25 });
      mockBalanceRepo.create.mockReturnValue(newRow);
      mockBalanceRepo.save.mockResolvedValue(newRow);

      const result = await service.upsertFromHcm(hcmData);
      expect(mockBalanceRepo.create).toHaveBeenCalledWith(expect.objectContaining({ totalBalance: 25, usedBalance: 0, pendingBalance: 0 }));
      expect(result.totalBalance).toBe(25);
    });

    it('updates totalBalance only when row already exists', async () => {
      const existing = makeBalance({ totalBalance: 20 });
      mockBalanceRepo.findOne.mockResolvedValue(existing);
      mockBalanceRepo.save.mockResolvedValue({ ...existing, totalBalance: 25 });

      await service.upsertFromHcm(hcmData);
      expect(existing.totalBalance).toBe(25); // mutated in place
      expect(existing.usedBalance).toBe(5);   // untouched
    });

    it('sets hcmSyncedAt on every upsert', async () => {
      const existing = makeBalance({ hcmSyncedAt: new Date(0) });
      mockBalanceRepo.findOne.mockResolvedValue(existing);
      mockBalanceRepo.save.mockResolvedValue(existing);

      await service.upsertFromHcm(hcmData);
      expect(existing.hcmSyncedAt.getTime()).toBeGreaterThan(0);
    });
  });

  // ── acquireLock ────────────────────────────────────────────────────────────

  describe('acquireLock()', () => {
    it('returns balance and runner when row found', async () => {
      const balance = makeBalance();
      mockQueryRunner.manager.findOne.mockResolvedValue(balance);

      const result = await service.acquireLock('EMP-001', 'LOC-NYC', LeaveType.ANNUAL);
      expect(result.balance).toEqual(balance);
      expect(result.runner).toBe(mockQueryRunner);
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
    });

    it('rolls back and throws NotFoundException when balance row does not exist', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null);

      await expect(service.acquireLock('EMP-NONE', 'LOC-X', LeaveType.ANNUAL))
        .rejects.toThrow(NotFoundException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  // ── isStale ────────────────────────────────────────────────────────────────

  describe('isStale()', () => {
    it('returns false for a recently synced balance (within threshold)', async () => {
      const fresh = makeBalance({ hcmSyncedAt: new Date(Date.now() - 5 * 60_000) }); // 5 min ago
      const result = await service.isStale(fresh);
      expect(result).toBe(false);
    });

    it('returns true when hcmSyncedAt is null', async () => {
      const noSync = makeBalance({ hcmSyncedAt: null });
      const result = await service.isStale(noSync);
      expect(result).toBe(true);
    });

    it('returns true when last sync exceeds the staleness threshold', async () => {
      const stale = makeBalance({ hcmSyncedAt: new Date(Date.now() - 60 * 60_000) }); // 60 min ago
      const result = await service.isStale(stale);
      expect(result).toBe(true);
    });
  });

  // ── syncFromHcmRealtime ────────────────────────────────────────────────────

  describe('syncFromHcmRealtime()', () => {
    it('calls HCM getBalance and upserts the result', async () => {
      const hcmData = { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 22 };
      mockHcmAdapter.getBalance.mockResolvedValue(hcmData);
      const updated = makeBalance({ totalBalance: 22 });
      mockBalanceRepo.findOne.mockResolvedValue(updated);
      mockBalanceRepo.save.mockResolvedValue(updated);

      const result = await service.syncFromHcmRealtime('EMP-001', 'LOC-NYC', LeaveType.ANNUAL);
      expect(mockHcmAdapter.getBalance).toHaveBeenCalledWith('EMP-001', 'LOC-NYC', LeaveType.ANNUAL);
      expect(result).toBeDefined();
    });
  });

  // ── batchSync ─────────────────────────────────────────────────────────────

  describe('batchSync()', () => {
    it('returns correct metrics on full success', async () => {
      const hcmData = [
        { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 20 },
        { employeeId: 'EMP-002', locationId: 'LOC-LA', leaveType: LeaveType.SICK, totalBalance: 10 },
      ];
      mockHcmAdapter.getBatchBalances.mockResolvedValue(hcmData);
      mockBalanceRepo.findOne.mockResolvedValue(null);
      mockBalanceRepo.create.mockReturnValue(makeBalance());
      mockBalanceRepo.save.mockResolvedValue(makeBalance());

      const result = await service.batchSync();
      expect(result).toEqual({ total: 2, succeeded: 2, failed: 0 });
    });

    it('counts failures individually and continues processing remaining records', async () => {
      const hcmData = [
        { employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, totalBalance: 20 },
        { employeeId: 'EMP-002', locationId: 'LOC-LA', leaveType: LeaveType.SICK, totalBalance: 10 },
        { employeeId: 'EMP-003', locationId: 'LOC-SF', leaveType: LeaveType.ANNUAL, totalBalance: 15 },
      ];
      mockHcmAdapter.getBatchBalances.mockResolvedValue(hcmData);
      mockBalanceRepo.findOne.mockResolvedValue(null);
      mockBalanceRepo.create.mockReturnValue(makeBalance());
      mockBalanceRepo.save
        .mockResolvedValueOnce(makeBalance())         // EMP-001 succeeds
        .mockRejectedValueOnce(new Error('DB error')) // EMP-002 fails
        .mockResolvedValueOnce(makeBalance());         // EMP-003 succeeds

      const result = await service.batchSync();
      expect(result).toEqual({ total: 3, succeeded: 2, failed: 1 });
    });

    it('returns zero totals for an empty HCM batch', async () => {
      mockHcmAdapter.getBatchBalances.mockResolvedValue([]);
      const result = await service.batchSync();
      expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
    });
  });

  // ── getLastSyncStatus ──────────────────────────────────────────────────────

  describe('getLastSyncStatus()', () => {
    it('returns lastSyncedAt as null when no rows have been synced', async () => {
      mockBalanceRepo.find.mockResolvedValue([]);
      const status = await service.getLastSyncStatus();
      expect(status.lastSyncedAt).toBeNull();
      expect(status.staleCount).toBe(0);
    });

    it('returns staleCount = 1 for a row with no hcmSyncedAt', async () => {
      mockBalanceRepo.find.mockResolvedValue([makeBalance({ hcmSyncedAt: null })]);
      const status = await service.getLastSyncStatus();
      expect(status.staleCount).toBe(1);
    });

    it('returns staleCount = 0 for recently synced rows', async () => {
      mockBalanceRepo.find.mockResolvedValue([makeBalance({ hcmSyncedAt: new Date() })]);
      const status = await service.getLastSyncStatus();
      expect(status.staleCount).toBe(0);
    });

    it('returns the most recent hcmSyncedAt across multiple rows', async () => {
      const older = makeBalance({ id: 'bal-1', hcmSyncedAt: new Date('2025-07-01T08:00:00Z') });
      const newer = makeBalance({ id: 'bal-2', hcmSyncedAt: new Date('2025-07-01T09:00:00Z') });
      mockBalanceRepo.find.mockResolvedValue([older, newer]);
      const status = await service.getLastSyncStatus();
      expect(status.lastSyncedAt).toEqual(newer.hcmSyncedAt);
    });
  });

  // ── audit ──────────────────────────────────────────────────────────────────

  describe('audit()', () => {
    it('saves an audit log entry with correct fields', async () => {
      const prev = { totalBalance: 20 };
      const next = { totalBalance: 25 };

      await service.audit('bal-1', 'SYNC', prev, next, 'system');

      expect(mockAuditRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        entityType: 'LeaveBalance',
        entityId: 'bal-1',
        action: 'SYNC',
        actorId: 'system',
        previousState: JSON.stringify(prev),
        newState: JSON.stringify(next),
      }));
      expect(mockAuditRepo.save).toHaveBeenCalled();
    });

    it('saves without actorId when not provided', async () => {
      await service.audit('bal-1', 'UPDATE', null, { totalBalance: 10 });
      expect(mockAuditRepo.create).toHaveBeenCalledWith(expect.objectContaining({ actorId: undefined }));
    });
  });
});