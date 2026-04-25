// * Unit Tests — HcmAdapter
//  *
//  * Tests retry logic, exponential backoff, 4xx no-retry policy,
//  * and all five HCM operations.
//  */
import { Test, TestingModule } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { HttpException, HttpStatus } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { HcmAdapter } from '../../src/hcm-sync/hcm-adapter.service';
import { LeaveType } from '../../src/balance/leave-balance.entity';

const mockHttpService = {
  get: jest.fn(),
  post: jest.fn(),
};

const mockConfig = {
  get: jest.fn((key: string, def: any) => {
    const map: Record<string, any> = {
      HCM_BASE_URL: 'http://mock-hcm',
      HCM_API_KEY: 'test-key',
      HCM_RETRY_ATTEMPTS: 2,
    };
    return map[key] ?? def;
  }),
};

describe('HcmAdapter', () => {
  let adapter: HcmAdapter;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HcmAdapter,
        { provide: HttpService, useValue: mockHttpService },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    adapter = module.get<HcmAdapter>(HcmAdapter);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── getBalance ─────────────────────────────────────────────────────────────

  describe('getBalance()', () => {
    it('returns balance data on success', async () => {
      const payload = { employeeId: 'E1', locationId: 'L1', leaveType: LeaveType.ANNUAL, totalBalance: 20 };
      mockHttpService.get.mockReturnValue(of({ data: payload }));

      const result = await adapter.getBalance('E1', 'L1', LeaveType.ANNUAL);
      expect(result).toEqual(payload);
      expect(mockHttpService.get).toHaveBeenCalledWith(
        'http://mock-hcm/hcm/balance/E1/L1/ANNUAL',
        expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'test-key' }) }),
      );
    });

    it('retries on 5xx error and eventually throws BAD_GATEWAY', async () => {
      const serverError = { response: { status: 500 } };
      mockHttpService.get.mockReturnValue(throwError(() => serverError));

      const promise = adapter.getBalance('E1', 'L1', LeaveType.ANNUAL);
      // Fast-forward all timers to skip backoff sleeps
      jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(HttpException);
      await expect(adapter.getBalance('E1', 'L1', LeaveType.ANNUAL).catch(e => e.getStatus()))
        .resolves.toBe(HttpStatus.BAD_GATEWAY);
    });

    it('does NOT retry on 4xx — throws immediately with original status', async () => {
      const clientError = { response: { status: 400, data: { message: 'Bad input' } } };
      mockHttpService.get.mockReturnValue(throwError(() => clientError));

      const promise = adapter.getBalance('E1', 'L1', LeaveType.ANNUAL);
      jest.runAllTimersAsync();

      await expect(promise).rejects.toThrow(HttpException);
      expect(mockHttpService.get).toHaveBeenCalledTimes(1); // no retry
    });

    it('uses HCM_API_KEY in x-api-key header', async () => {
      mockHttpService.get.mockReturnValue(of({ data: {} }));
      await adapter.getBalance('E1', 'L1', LeaveType.ANNUAL);
      expect(mockHttpService.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: expect.objectContaining({ 'x-api-key': 'test-key' }) }),
      );
    });
  });

  // ── debitBalance ───────────────────────────────────────────────────────────

  describe('debitBalance()', () => {
    it('posts debit and returns transaction result', async () => {
      const result = { transactionId: 'txn-1', newBalance: 15, success: true };
      mockHttpService.post.mockReturnValue(of({ data: result }));

      const res = await adapter.debitBalance('E1', 'L1', LeaveType.ANNUAL, 5, 'idem-key');
      expect(res).toEqual(result);
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'http://mock-hcm/hcm/debit',
        { employeeId: 'E1', locationId: 'L1', leaveType: 'ANNUAL', days: 5, idempotencyKey: 'idem-key' },
        expect.any(Object),
      );
    });

    it('throws BAD_GATEWAY after exhausting retries on 503', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 503 } })));

      const promise = adapter.debitBalance('E1', 'L1', LeaveType.ANNUAL, 5, 'key');
      jest.runAllTimersAsync();
      await expect(promise).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });

    it('surfaces 422 from HCM without retry', async () => {
      mockHttpService.post.mockReturnValue(
        throwError(() => ({ response: { status: 422, data: { message: 'Invalid dimension' } } })),
      );

      const promise = adapter.debitBalance('E1', 'L1', LeaveType.ANNUAL, 5, 'key');
      jest.runAllTimersAsync();
      await expect(promise).rejects.toMatchObject({ status: 422 });
      expect(mockHttpService.post).toHaveBeenCalledTimes(1);
    });
  });

  // ── commitBalance ──────────────────────────────────────────────────────────

  describe('commitBalance()', () => {
    it('posts commit successfully', async () => {
      mockHttpService.post.mockReturnValue(of({ data: { success: true } }));
      await expect(adapter.commitBalance('txn-1')).resolves.toBeUndefined();
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'http://mock-hcm/hcm/commit',
        { transactionId: 'txn-1' },
        expect.any(Object),
      );
    });

    it('retries on 500 and throws BAD_GATEWAY', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 500 } })));
      const promise = adapter.commitBalance('txn-1');
      jest.runAllTimersAsync();
      await expect(promise).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });
  });

  // ── rollbackBalance ────────────────────────────────────────────────────────

  describe('rollbackBalance()', () => {
    it('posts rollback successfully', async () => {
      mockHttpService.post.mockReturnValue(of({ data: {} }));
      await expect(adapter.rollbackBalance('txn-1')).resolves.toBeUndefined();
      expect(mockHttpService.post).toHaveBeenCalledWith(
        'http://mock-hcm/hcm/rollback',
        { transactionId: 'txn-1' },
        expect.any(Object),
      );
    });
  });

  // ── getBatchBalances ───────────────────────────────────────────────────────

  describe('getBatchBalances()', () => {
    it('returns array of balances from batch endpoint', async () => {
      const payload = [
        { employeeId: 'E1', locationId: 'L1', leaveType: LeaveType.ANNUAL, totalBalance: 20 },
        { employeeId: 'E2', locationId: 'L2', leaveType: LeaveType.SICK, totalBalance: 10 },
      ];
      mockHttpService.post.mockReturnValue(of({ data: payload }));

      const result = await adapter.getBatchBalances();
      expect(result).toHaveLength(2);
      expect(result[0].employeeId).toBe('E1');
    });

    it('throws BAD_GATEWAY on repeated 500 errors', async () => {
      mockHttpService.post.mockReturnValue(throwError(() => ({ response: { status: 500 } })));
      const promise = adapter.getBatchBalances();
      jest.runAllTimersAsync();
      await expect(promise).rejects.toMatchObject({ status: HttpStatus.BAD_GATEWAY });
    });
  });
});