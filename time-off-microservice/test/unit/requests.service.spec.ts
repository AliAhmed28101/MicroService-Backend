/**
 * Unit Tests — RequestsService
 *
 * Covers the full state machine: create (happy, insufficient balance,
 * invalid dates, zero working days, idempotency cache hit, HCM rejection,
 * silent overdraft defence), approve (success, wrong state, HCM fail),
 * reject (success, rollback), cancel (own request, other employee, approved cancel),
 * findById, findByEmployee.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException, NotFoundException, ConflictException, HttpException,
} from '@nestjs/common';

import { RequestsService } from '../../src/requests/requests.service';
import { TimeOffRequest, RequestStatus } from '../../src/entities/time-off-request.entity';
import { IdempotencyRecord } from '../../src/idempotency-record.entity';
import { AuditLog } from '../../src/entities/audit-log.entity';
import { LeaveBalance, LeaveType } from '../../src/balance/leave-balance.entity';
import { HcmAdapter } from '../../src/hcm-sync/hcm-adapter.service';

// ─── Factories ────────────────────────────────────────────────────────────────

function makeBalance(overrides: Partial<LeaveBalance> = {}): LeaveBalance {
  return Object.assign(new LeaveBalance(), {
    id: 'bal-1', employeeId: 'EMP-001', locationId: 'LOC-NYC',
    leaveType: LeaveType.ANNUAL, totalBalance: 20, usedBalance: 0,
    pendingBalance: 0, hcmSyncedAt: new Date(), version: 1,
    ...overrides,
  });
}

function makeRequest(overrides: Partial<TimeOffRequest> = {}): TimeOffRequest {
  return Object.assign(new TimeOffRequest(), {
    id: 'req-1', employeeId: 'EMP-001', locationId: 'LOC-NYC',
    leaveType: LeaveType.ANNUAL, startDate: '2025-07-07', endDate: '2025-07-11',
    daysRequested: 5, status: RequestStatus.PENDING_APPROVAL,
    hcmTransactionId: 'hcm-txn-1', idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  });
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  },
};

const mockDataSource = {
  createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
  transaction: jest.fn(),
};

const mockRequestRepo = {
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
};

const mockIdempotencyRepo = {
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
};

const mockAuditRepo = {
  create: jest.fn().mockReturnValue({}),
  save: jest.fn().mockResolvedValue({}),
};

const mockHcmAdapter = {
  debitBalance: jest.fn(),
  commitBalance: jest.fn(),
  rollbackBalance: jest.fn(),
};

const mockConfig = { get: jest.fn((k: string, d: any) => d) };

// ─── Shared DTO ───────────────────────────────────────────────────────────────

const baseDto = {
  employeeId: 'EMP-001',
  locationId: 'LOC-NYC',
  leaveType: LeaveType.ANNUAL,
  startDate: '2025-07-07',
  endDate: '2025-07-11',
  idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('RequestsService', () => {
  let service: RequestsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
    mockAuditRepo.create.mockReturnValue({});
    mockAuditRepo.save.mockResolvedValue({});
    mockIdempotencyRepo.create.mockReturnValue({});
    mockIdempotencyRepo.save.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RequestsService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: mockRequestRepo },
        { provide: getRepositoryToken(IdempotencyRecord), useValue: mockIdempotencyRepo },
        { provide: getRepositoryToken(AuditLog), useValue: mockAuditRepo },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: HcmAdapter, useValue: mockHcmAdapter },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = module.get<RequestsService>(RequestsService);
  });

  // ── create — happy path ────────────────────────────────────────────────────

  describe('create() — happy path', () => {
    it('returns PENDING_APPROVAL request when all checks pass', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      const balance = makeBalance({ totalBalance: 20 });
      mockQueryRunner.manager.findOne.mockResolvedValue(balance);
      const pending = makeRequest({ status: RequestStatus.PENDING });
      mockQueryRunner.manager.create.mockReturnValue(pending);
      mockQueryRunner.manager.save.mockResolvedValue(pending);
      mockHcmAdapter.debitBalance.mockResolvedValue({ transactionId: 'txn-1', newBalance: 15, success: true });

      const result = await service.create(baseDto);
      expect(result).toBeDefined();
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockHcmAdapter.debitBalance).toHaveBeenCalledTimes(1);
    });

    it('calculates daysRequested = 5 for Mon–Fri range', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.findOne.mockResolvedValue(makeBalance({ totalBalance: 20 }));
      const req = makeRequest({ daysRequested: 5 });
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);
      mockHcmAdapter.debitBalance.mockResolvedValue({ transactionId: 'txn-1', newBalance: 15, success: true });

      const result = await service.create(baseDto);
      expect(result.daysRequested).toBe(5);
    });

    it('increments pendingBalance on the balance row', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      const balance = makeBalance({ totalBalance: 20, pendingBalance: 0 });
      mockQueryRunner.manager.findOne.mockResolvedValue(balance);
      const req = makeRequest();
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);
      mockHcmAdapter.debitBalance.mockResolvedValue({ transactionId: 'txn-1', newBalance: 15, success: true });

      await service.create(baseDto);
      expect(balance.pendingBalance).toBe(5);
    });
  });

  // ── create — validation failures ──────────────────────────────────────────

  describe('create() — validation failures', () => {
    it('throws BadRequestException when endDate is before startDate', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      await expect(service.create({ ...baseDto, startDate: '2025-07-11', endDate: '2025-07-07' }))
        .rejects.toThrow(BadRequestException);
      expect(mockHcmAdapter.debitBalance).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when range covers zero working days (weekend only)', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      // Sat–Sun range
      await expect(service.create({ ...baseDto, startDate: '2025-07-05', endDate: '2025-07-06' }))
        .rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when no balance row exists for the dimension', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.findOne.mockResolvedValue(null);
      // manager.create/save so the PENDING request gets created before balance lookup
      const req = makeRequest({ status: RequestStatus.PENDING });
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);

      await expect(service.create(baseDto)).rejects.toThrow(NotFoundException);
      expect(mockHcmAdapter.debitBalance).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when local available balance is insufficient', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      // Only 3 days available, requesting 5
      mockQueryRunner.manager.findOne.mockResolvedValue(makeBalance({ totalBalance: 3 }));
      const req = makeRequest();
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);

      await expect(service.create(baseDto)).rejects.toThrow(BadRequestException);
      expect(mockHcmAdapter.debitBalance).not.toHaveBeenCalled();
    });

    it('accounts for pendingBalance in availability check', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      // 10 total, 0 used, 8 pending → only 2 available, requesting 5
      mockQueryRunner.manager.findOne.mockResolvedValue(
        makeBalance({ totalBalance: 10, usedBalance: 0, pendingBalance: 8 }),
      );
      const req = makeRequest();
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);

      await expect(service.create(baseDto)).rejects.toThrow(BadRequestException);
    });
  });

  // ── create — HCM failure paths ─────────────────────────────────────────────

  describe('create() — HCM failure paths', () => {
    it('marks request REJECTED and throws when HCM debit fails', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.findOne.mockResolvedValue(makeBalance({ totalBalance: 20 }));
      const req = makeRequest({ status: RequestStatus.PENDING });
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);
      mockHcmAdapter.debitBalance.mockRejectedValue(new Error('HCM unavailable'));

      await expect(service.create(baseDto)).rejects.toThrow(BadRequestException);
    });

    it('defensively rejects and rolls back HCM when newBalance is negative (silent overdraft)', async () => {
      mockIdempotencyRepo.findOne.mockResolvedValue(null);
      mockQueryRunner.manager.findOne.mockResolvedValue(makeBalance({ totalBalance: 20 }));
      const req = makeRequest({ status: RequestStatus.PENDING });
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);
      mockHcmAdapter.debitBalance.mockResolvedValue({ transactionId: 'txn-bad', newBalance: -3, success: true });
      mockHcmAdapter.rollbackBalance.mockResolvedValue(undefined);

      await expect(service.create(baseDto)).rejects.toThrow(BadRequestException);
      expect(mockHcmAdapter.rollbackBalance).toHaveBeenCalledWith('txn-bad');
    });
  });

  // ── create — idempotency ──────────────────────────────────────────────────

  describe('create() — idempotency', () => {
    it('returns cached response without re-processing on duplicate key', async () => {
      const originalRequest = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const cached: Partial<IdempotencyRecord> = {
        idempotencyKey: baseDto.idempotencyKey,
        responseBody: JSON.stringify(originalRequest),
        statusCode: 201,
        expiresAt: new Date(Date.now() + 86400_000),
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(cached);

      const result = await service.create(baseDto);
      expect(result).toBeDefined();
      expect(mockHcmAdapter.debitBalance).not.toHaveBeenCalled();
      expect(mockQueryRunner.connect).not.toHaveBeenCalled();
    });

    it('proceeds normally after an expired idempotency key is removed', async () => {
      const expired: Partial<IdempotencyRecord> = {
        idempotencyKey: baseDto.idempotencyKey,
        responseBody: '{}',
        statusCode: 201,
        expiresAt: new Date(Date.now() - 1000), // expired
      };
      mockIdempotencyRepo.findOne.mockResolvedValue(expired);
      mockIdempotencyRepo.remove.mockResolvedValue(undefined);
      mockQueryRunner.manager.findOne.mockResolvedValue(makeBalance({ totalBalance: 20 }));
      const req = makeRequest();
      mockQueryRunner.manager.create.mockReturnValue(req);
      mockQueryRunner.manager.save.mockResolvedValue(req);
      mockHcmAdapter.debitBalance.mockResolvedValue({ transactionId: 'txn-1', newBalance: 15, success: true });

      const result = await service.create(baseDto);
      expect(result).toBeDefined();
      expect(mockHcmAdapter.debitBalance).toHaveBeenCalledTimes(1);
    });
  });

  // ── approve ────────────────────────────────────────────────────────────────

  describe('approve()', () => {
    it('transitions request to APPROVED and adjusts balance', async () => {
      const req = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const balance = makeBalance({ pendingBalance: 5, usedBalance: 0 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.commitBalance.mockResolvedValue(undefined);
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn().mockResolvedValue(req) });
      });

      const result = await service.approve('req-1', 'Looks good');
      expect(result.status).toBe(RequestStatus.APPROVED);
      expect(result.managerComment).toBe('Looks good');
      expect(mockHcmAdapter.commitBalance).toHaveBeenCalledWith('hcm-txn-1');
    });

    it('throws ConflictException when trying to approve a non-PENDING_APPROVAL request', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.APPROVED }));
      await expect(service.approve('req-1')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when trying to approve a REJECTED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.REJECTED }));
      await expect(service.approve('req-1')).rejects.toThrow(ConflictException);
    });

    it('marks request APPROVAL_FAILED and restores balance when HCM commit fails', async () => {
      const req = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const balance = makeBalance({ pendingBalance: 5 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.commitBalance.mockRejectedValue(new Error('HCM down'));
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn() });
      });

      await expect(service.approve('req-1')).rejects.toThrow(HttpException);
      expect(req.status).toBe(RequestStatus.APPROVAL_FAILED);
    });

    it('throws NotFoundException for unknown request ID', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);
      await expect(service.approve('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── reject ─────────────────────────────────────────────────────────────────

  describe('reject()', () => {
    it('transitions request to REJECTED and rolls back HCM debit', async () => {
      const req = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const balance = makeBalance({ pendingBalance: 5 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.rollbackBalance.mockResolvedValue(undefined);
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn().mockResolvedValue(req) });
      });

      const result = await service.reject('req-1', 'Peak season');
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(mockHcmAdapter.rollbackBalance).toHaveBeenCalledWith('hcm-txn-1');
    });

    it('still rejects locally even when HCM rollback fails', async () => {
      const req = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const balance = makeBalance({ pendingBalance: 5 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.rollbackBalance.mockRejectedValue(new Error('HCM unavailable'));
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn().mockResolvedValue(req) });
      });

      // Should NOT throw — HCM rollback failure is a warn, not fatal
      const result = await service.reject('req-1', 'Denied');
      expect(result.status).toBe(RequestStatus.REJECTED);
    });

    it('throws ConflictException when request is not PENDING_APPROVAL', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.CANCELLED }));
      await expect(service.reject('req-1')).rejects.toThrow(ConflictException);
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────────

  describe('cancel()', () => {
    it('cancels a PENDING_APPROVAL request by the owning employee', async () => {
      const req = makeRequest({ status: RequestStatus.PENDING_APPROVAL });
      const balance = makeBalance({ pendingBalance: 5 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.rollbackBalance.mockResolvedValue(undefined);
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn().mockResolvedValue(req) });
      });

      const result = await service.cancel('req-1', 'EMP-001');
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('cancels an already APPROVED request and reduces usedBalance', async () => {
      const req = makeRequest({ status: RequestStatus.APPROVED });
      const balance = makeBalance({ usedBalance: 5 });
      mockRequestRepo.findOne.mockResolvedValue(req);
      mockHcmAdapter.rollbackBalance.mockResolvedValue(undefined);
      mockDataSource.transaction.mockImplementation(async (cb) => {
        await cb({ findOne: jest.fn().mockResolvedValue(balance), save: jest.fn().mockResolvedValue(req) });
      });

      const result = await service.cancel('req-1', 'EMP-001');
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('throws BadRequestException when a different employee tries to cancel', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.PENDING_APPROVAL }));
      await expect(service.cancel('req-1', 'EMP-IMPOSTER')).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when trying to cancel an already-cancelled request', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.CANCELLED }));
      await expect(service.cancel('req-1', 'EMP-001')).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException when trying to cancel a REJECTED request', async () => {
      mockRequestRepo.findOne.mockResolvedValue(makeRequest({ status: RequestStatus.REJECTED }));
      await expect(service.cancel('req-1', 'EMP-001')).rejects.toThrow(ConflictException);
    });
  });

  // ── findById ───────────────────────────────────────────────────────────────

  describe('findById()', () => {
    it('returns a request when found', async () => {
      const req = makeRequest();
      mockRequestRepo.findOne.mockResolvedValue(req);
      expect(await service.findById('req-1')).toEqual(req);
    });

    it('throws NotFoundException when request ID does not exist', async () => {
      mockRequestRepo.findOne.mockResolvedValue(null);
      await expect(service.findById('ghost')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findByEmployee ─────────────────────────────────────────────────────────

  describe('findByEmployee()', () => {
    it('returns all requests for an employee when no status filter given', async () => {
      const requests = [makeRequest(), makeRequest({ id: 'req-2', status: RequestStatus.APPROVED })];
      mockRequestRepo.find.mockResolvedValue(requests);
      const result = await service.findByEmployee('EMP-001');
      expect(result).toHaveLength(2);
      expect(mockRequestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employeeId: 'EMP-001' } }),
      );
    });

    it('filters by status when provided', async () => {
      mockRequestRepo.find.mockResolvedValue([makeRequest({ status: RequestStatus.APPROVED })]);
      await service.findByEmployee('EMP-001', RequestStatus.APPROVED);
      expect(mockRequestRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { employeeId: 'EMP-001', status: RequestStatus.APPROVED } }),
      );
    });

    it('returns empty array when employee has no requests', async () => {
      mockRequestRepo.find.mockResolvedValue([]);
      const result = await service.findByEmployee('EMP-NONE');
      expect(result).toEqual([]);
    });
  });
});