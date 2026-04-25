import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BalanceService } from '../src/balance/balance.service';
import { LeaveBalance } from '../src/balance/leave-balance.entity';
import { LeaveType } from '../src/common/enums/enums';

const mockBalance = (): Partial<LeaveBalance> => ({
  id: 'bal-1',
  employeeId: 'EMP-001',
  locationId: 'LOC-NYC',
  leaveType: LeaveType.ANNUAL,
  totalBalance: 20,
  usedBalance: 5,
  pendingBalance: 2,
  hcmSyncedAt: new Date(),
  version: 0,
  updatedAt: new Date(),
  createdAt: new Date(),
});

describe('BalanceService', () => {
  let service: BalanceService;
  let repo: any;
  let dataSource: any;

  beforeEach(async () => {
    const mockQueryRunner = {
      manager: {
        findOne: jest.fn(),
        save: jest.fn(),
      },
    };

    dataSource = { createQueryRunner: jest.fn(() => mockQueryRunner) };

    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn((x) => x),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: getRepositoryToken(LeaveBalance), useValue: repo },
        { provide: 'DataSource', useValue: dataSource },
        {
          provide: ConfigService,
          useValue: { get: jest.fn((key, def) => def) },
        },
      ],
    }).compile();

    service = module.get<BalanceService>(BalanceService);
    // inject the dataSource properly
    (service as any).dataSource = dataSource;
  });

  describe('getBalances', () => {
    it('returns formatted balances when rows exist', async () => {
      repo.find.mockResolvedValue([mockBalance()]);
      const result = await service.getBalances('EMP-001', 'LOC-NYC');
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0].available).toBe(13); // 20 - 5 - 2
    });

    it('throws NotFoundException when no rows found', async () => {
      repo.find.mockResolvedValue([]);
      await expect(service.getBalances('EMP-999', 'LOC-X')).rejects.toThrow(NotFoundException);
    });

    it('marks balance as stale when hcmSyncedAt is old', async () => {
      const old = mockBalance();
      old.hcmSyncedAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      repo.find.mockResolvedValue([old]);
      const result = await service.getBalances('EMP-001', 'LOC-NYC');
      expect(result.stale).toBe(true);
    });

    it('marks balance as fresh when hcmSyncedAt is recent', async () => {
      repo.find.mockResolvedValue([mockBalance()]); // syncedAt = now
      const result = await service.getBalances('EMP-001', 'LOC-NYC');
      expect(result.stale).toBe(false);
    });
  });

  describe('getBalance', () => {
    it('returns a single balance', async () => {
      repo.findOne.mockResolvedValue(mockBalance());
      const result = await service.getBalance('EMP-001', 'LOC-NYC', LeaveType.ANNUAL);
      expect(result.balance.total).toBe(20);
    });

    it('throws NotFoundException for missing balance', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.getBalance('EMP-999', 'LOC-NYC', LeaveType.ANNUAL),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('debitPending', () => {
    it('deducts from pendingBalance correctly', async () => {
      const row = mockBalance() as LeaveBalance;
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn((_, x) => x) } };
      await service.debitPending('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 3, qr as any);
      expect(row.pendingBalance).toBe(5); // 2 + 3
    });

    it('throws ConflictException when balance insufficient', async () => {
      const row = { ...mockBalance(), totalBalance: 5, usedBalance: 4, pendingBalance: 1 } as LeaveBalance;
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn() } };
      // available = 5 - 4 - 1 = 0, requesting 2 → should throw
      await expect(
        service.debitPending('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 2, qr as any),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException on exact 0 balance', async () => {
      const row = { ...mockBalance(), totalBalance: 10, usedBalance: 5, pendingBalance: 5 } as LeaveBalance;
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn() } };
      await expect(
        service.debitPending('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 1, qr as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('commitDebit', () => {
    it('moves pendingBalance to usedBalance', async () => {
      const row = mockBalance() as LeaveBalance; // pending=2, used=5
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn((_, x) => x) } };
      await service.commitDebit('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 2, qr as any);
      expect(row.usedBalance).toBe(7); // 5 + 2
      expect(row.pendingBalance).toBe(0); // 2 - 2
    });
  });

  describe('releasePending', () => {
    it('releases pending balance', async () => {
      const row = mockBalance() as LeaveBalance; // pending=2
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn((_, x) => x) } };
      await service.releasePending('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 2, qr as any);
      expect(row.pendingBalance).toBe(0);
    });

    it('does not go below 0', async () => {
      const row = { ...mockBalance(), pendingBalance: 1 } as LeaveBalance;
      const qr = { manager: { findOne: jest.fn().mockResolvedValue(row), save: jest.fn((_, x) => x) } };
      await service.releasePending('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 5, qr as any);
      expect(row.pendingBalance).toBe(0);
    });
  });

  describe('upsertFromHcm', () => {
    it('creates a new balance row when none exists', async () => {
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue({ totalBalance: 0, pendingBalance: 0, usedBalance: 0, version: 0 });
      repo.save.mockResolvedValue({ totalBalance: 15 });
      const result = await service.upsertFromHcm('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 15);
      expect(repo.save).toHaveBeenCalled();
    });

    it('updates existing balance row', async () => {
      const row = mockBalance() as LeaveBalance;
      repo.findOne.mockResolvedValue(row);
      repo.save.mockResolvedValue({ ...row, totalBalance: 25 });
      await service.upsertFromHcm('EMP-001', 'LOC-NYC', LeaveType.ANNUAL, 25);
      expect(row.totalBalance).toBe(25);
    });
  });

  describe('availableBalance computation', () => {
    it('correctly computes available = total - used - pending', () => {
      const row = mockBalance() as LeaveBalance;
      const formatted = service.formatBalance(row);
      expect(formatted.available).toBe(13); // 20 - 5 - 2
    });

    it('returns 0 available when fully consumed', () => {
      const row = { ...mockBalance(), totalBalance: 10, usedBalance: 7, pendingBalance: 3 } as LeaveBalance;
      const formatted = service.formatBalance(row);
      expect(formatted.available).toBe(0);
    });
  });
});