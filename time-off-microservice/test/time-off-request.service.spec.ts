import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { TimeOffRequestService } from '../src/time-off-request/time-off-request.service';
import { TimeOffRequest } from '../src/time-off-request/time-off-request.entity';
import { IdempotencyRecord } from '../src/idempotency-record.entity';
import { BalanceService } from '../src/balance/balance.service';
import { HcmAdapterService } from '../src/hcm-sync/hcm-adapter.service';
import { LeaveType, RequestStatus } from '../src/common/enums/enums';

const tomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
};
const dayAfter = () => {
  const d = new Date();
  d.setDate(d.getDate() + 5);
  return d.toISOString().split('T')[0];
};

const mockCreateDto = () => ({
  employeeId: 'EMP-001',
  locationId: 'LOC-NYC',
  leaveType: LeaveType.ANNUAL,
  startDate: tomorrow(),
  endDate: dayAfter(),
  idempotencyKey: 'test-idempotency-key-123',
  notes: 'Test vacation',
});

describe('TimeOffRequestService', () => {
  let service: TimeOffRequestService;
  let requestRepo: any;
  let idempotencyRepo: any;
  let balanceService: any;
  let hcmAdapter: any;
  let mockQueryRunner: any;

  beforeEach(async () => {
    mockQueryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        create: jest.fn((Entity, data) => ({ ...data, id: 'req-uuid', createdAt: new Date() })),
        save: jest.fn((Entity, data) => Promise.resolve({ ...data, id: 'req-uuid', createdAt: new Date() })),
      },
    };

    const mockDataSource = { createQueryRunner: jest.fn(() => mockQueryRunner) };

    balanceService = {
      debitPending: jest.fn().mockResolvedValue({}),
      releasePending: jest.fn().mockResolvedValue({}),
      commitDebit: jest.fn().mockResolvedValue({}),
      reverseUsed: jest.fn().mockResolvedValue({}),
      getBalance: jest.fn().mockResolvedValue({ balance: { available: 15 }, stale: false }),
      getDataSource: jest.fn(() => mockDataSource),
    };

    hcmAdapter = {
      debitBalance: jest.fn().mockResolvedValue({ transactionId: 'hcm-txn-001' }),
      commitDebit: jest.fn().mockResolvedValue({}),
      rollbackDebit: jest.fn().mockResolvedValue({}),
    };

    requestRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ ...data, id: 'req-uuid' })),
    };

    idempotencyRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => data),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TimeOffRequestService,
        { provide: getRepositoryToken(TimeOffRequest), useValue: requestRepo },
        { provide: getRepositoryToken(IdempotencyRecord), useValue: idempotencyRepo },
        { provide: BalanceService, useValue: balanceService },
        { provide: HcmAdapterService, useValue: hcmAdapter },
        { provide: ConfigService, useValue: { get: jest.fn((k, d) => d) } },
      ],
    }).compile();

    service = module.get<TimeOffRequestService>(TimeOffRequestService);
  });

  describe('create', () => {
    it('creates a request and calls HCM debit', async () => {
      const result = await service.create(mockCreateDto());
      expect(hcmAdapter.debitBalance).toHaveBeenCalled();
      expect(result.status).toBe(RequestStatus.PENDING_APPROVAL);
    });

    it('returns idempotent response on duplicate key', async () => {
      const existing = {
        key: 'test-idempotency-key-123',
        responseBody: JSON.stringify({ requestId: 'original-id', status: 'PENDING_APPROVAL' }),
        expiresAt: new Date(Date.now() + 3600_000),
      };
      idempotencyRepo.findOne.mockResolvedValue(existing);
      const result = await service.create(mockCreateDto());
      expect(result.requestId).toBe('original-id');
      expect(hcmAdapter.debitBalance).not.toHaveBeenCalled();
    });

    it('rejects when HCM returns an error', async () => {
      hcmAdapter.debitBalance.mockRejectedValue(new Error('HCM: insufficient balance'));
      const result = await service.create(mockCreateDto());
      expect(result.status).toBe(RequestStatus.REJECTED);
      expect(balanceService.releasePending).toHaveBeenCalled();
    });

    it('rejects with BadRequestException for past startDate', async () => {
      const dto = { ...mockCreateDto(), startDate: '2020-01-01', endDate: '2020-01-05' };
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('rejects when endDate is before startDate', async () => {
      const dto = { ...mockCreateDto(), startDate: dayAfter(), endDate: tomorrow() };
      await expect(service.create(dto)).rejects.toThrow(BadRequestException);
    });

    it('rolls back transaction when balance check throws', async () => {
      balanceService.debitPending.mockRejectedValue(new ConflictException('Insufficient balance'));
      await expect(service.create(mockCreateDto())).rejects.toThrow(ConflictException);
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe('calculateBusinessDays', () => {
    it('returns 5 for a Mon–Fri week', () => {
      expect(service.calculateBusinessDays('2025-07-07', '2025-07-11')).toBe(5);
    });

    it('returns 1 for a single Monday', () => {
      expect(service.calculateBusinessDays('2025-07-07', '2025-07-07')).toBe(1);
    });

    it('returns 0 for a weekend-only range', () => {
      expect(service.calculateBusinessDays('2025-07-05', '2025-07-06')).toBe(0);
    });

    it('correctly spans across weekends', () => {
      // Mon Jul 7 to Mon Jul 14 = 8 business days (Mon-Fri, Mon)
      expect(service.calculateBusinessDays('2025-07-07', '2025-07-14')).toBe(6);
    });
  });

  describe('approve', () => {
    it('approves a PENDING_APPROVAL request', async () => {
      const req = { id: 'req-1', status: RequestStatus.PENDING_APPROVAL, employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, daysRequested: 3, hcmTransactionId: 'hcm-txn-001' };
      requestRepo.findOne.mockResolvedValue(req);
      mockQueryRunner.manager.save.mockImplementation((_, data) => Promise.resolve({ ...data }));
      const result = await service.approve('req-1');
      expect(hcmAdapter.commitDebit).toHaveBeenCalledWith('hcm-txn-001');
      expect(result.status).toBe(RequestStatus.APPROVED);
    });

    it('moves to APPROVAL_FAILED when HCM commit fails', async () => {
      const req = { id: 'req-1', status: RequestStatus.PENDING_APPROVAL, employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, daysRequested: 3, hcmTransactionId: 'hcm-txn-001' };
      requestRepo.findOne.mockResolvedValue(req);
      hcmAdapter.commitDebit.mockRejectedValue(new Error('HCM down'));
      mockQueryRunner.manager.save.mockImplementation((_, data) => Promise.resolve({ ...data }));
      const result = await service.approve('req-1');
      expect(result.status).toBe(RequestStatus.APPROVAL_FAILED);
      expect(balanceService.reverseUsed).toHaveBeenCalled();
    });

    it('throws ConflictException when request is not in PENDING_APPROVAL', async () => {
      requestRepo.findOne.mockResolvedValue({ id: 'req-1', status: RequestStatus.APPROVED });
      await expect(service.approve('req-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('reject', () => {
    it('rejects a PENDING_APPROVAL request and releases balance', async () => {
      const req = { id: 'req-1', status: RequestStatus.PENDING_APPROVAL, employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, daysRequested: 3, hcmTransactionId: 'hcm-txn-001' };
      requestRepo.findOne.mockResolvedValue(req);
      mockQueryRunner.manager.save.mockImplementation((_, data) => Promise.resolve({ ...data }));
      const result = await service.reject('req-1', { managerComment: 'Not approved' });
      expect(balanceService.releasePending).toHaveBeenCalled();
      expect(result.status).toBe(RequestStatus.REJECTED);
    });
  });

  describe('cancel', () => {
    it('cancels a PENDING_APPROVAL request', async () => {
      const req = { id: 'req-1', status: RequestStatus.PENDING_APPROVAL, employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, daysRequested: 3, hcmTransactionId: 'hcm-txn-001' };
      requestRepo.findOne.mockResolvedValue(req);
      mockQueryRunner.manager.save.mockImplementation((_, data) => Promise.resolve({ ...data }));
      const result = await service.cancel('req-1');
      expect(result.status).toBe(RequestStatus.CANCELLED);
    });

    it('reverses usedBalance when cancelling an APPROVED request', async () => {
      const req = { id: 'req-1', status: RequestStatus.APPROVED, employeeId: 'EMP-001', locationId: 'LOC-NYC', leaveType: LeaveType.ANNUAL, daysRequested: 3, hcmTransactionId: 'hcm-txn-001' };
      requestRepo.findOne.mockResolvedValue(req);
      mockQueryRunner.manager.save.mockImplementation((_, data) => Promise.resolve({ ...data }));
      await service.cancel('req-1');
      expect(balanceService.reverseUsed).toHaveBeenCalled();
    });

    it('throws ConflictException when request is already CANCELLED', async () => {
      requestRepo.findOne.mockResolvedValue({ id: 'req-1', status: RequestStatus.CANCELLED });
      await expect(service.cancel('req-1')).rejects.toThrow(ConflictException);
    });
  });
});