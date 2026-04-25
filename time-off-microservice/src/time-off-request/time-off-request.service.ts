import {
  Injectable, NotFoundException, ConflictException,
  UnprocessableEntityException, BadRequestException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { TimeOffRequest } from '../time-off-request/time-off-request.entity';
import { IdempotencyRecord } from '../idempotency-record.entity';
import {
  CreateTimeOffRequestDto, RejectRequestDto, ListRequestsQueryDto,
} from '../time-off-request/time-off-request.dto';
import { BalanceService } from '../balance/balance.service';
import { HcmAdapterService } from '../hcm-sync/hcm-adapter.service';
import { RequestStatus } from '../common/enums/enums';

@Injectable()
export class TimeOffRequestService {
  private readonly logger = new Logger(TimeOffRequestService.name);

  constructor(
    @InjectRepository(TimeOffRequest)
    private readonly requestRepo: Repository<TimeOffRequest>,
    @InjectRepository(IdempotencyRecord)
    private readonly idempotencyRepo: Repository<IdempotencyRecord>,
    private readonly balanceService: BalanceService,
    private readonly hcmAdapter: HcmAdapterService,
    private readonly config: ConfigService,
  ) {}

  // ─── Submit a new leave request ─────────────────────────────────────────────

  async create(dto: CreateTimeOffRequestDto) {
    // 1. Idempotency check
    if (dto.idempotencyKey) {
      const existing = await this.idempotencyRepo.findOne({
        where: { key: dto.idempotencyKey },
      });
      if (existing && new Date() < new Date(existing.expiresAt)) {
        return JSON.parse(existing.responseBody);
      }
    }

    // 2. Date validation
    this.validateDates(dto.startDate, dto.endDate);
    const daysRequested = this.calculateBusinessDays(dto.startDate, dto.endDate);
    if (daysRequested <= 0) {
      throw new BadRequestException('Request must span at least 1 business day');
    }

    const dataSource = this.balanceService.getDataSource();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 3. Defensive balance check + pessimistic lock
      await this.balanceService.debitPending(
        dto.employeeId, dto.locationId, dto.leaveType, daysRequested, queryRunner,
      );

      // 4. Persist request in PENDING state
      const request = queryRunner.manager.create(TimeOffRequest, {
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        leaveType: dto.leaveType,
        startDate: dto.startDate,
        endDate: dto.endDate,
        daysRequested,
        status: RequestStatus.PENDING,
        idempotencyKey: dto.idempotencyKey,
        notes: dto.notes,
      });
      const saved = await queryRunner.manager.save(TimeOffRequest, request);

      // 5. Call HCM real-time API to tentatively debit
      let hcmResult: { transactionId?: string } = {};
      try {
        hcmResult = await this.hcmAdapter.debitBalance(
          dto.employeeId, dto.locationId, dto.leaveType, daysRequested,
        );
        saved.hcmTransactionId = hcmResult.transactionId;
        saved.status = RequestStatus.PENDING_APPROVAL;
        await queryRunner.manager.save(TimeOffRequest, saved);
      } catch (hcmErr) {
        // HCM rejected — release pending balance, reject request
        await this.balanceService.releasePending(
          dto.employeeId, dto.locationId, dto.leaveType, daysRequested, queryRunner,
        );
        saved.status = RequestStatus.REJECTED;
        saved.resolvedAt = new Date();
        await queryRunner.manager.save(TimeOffRequest, saved);
        await queryRunner.commitTransaction();
        return this.buildResponse(saved, dto.employeeId, dto.locationId, dto.leaveType, queryRunner);
      }

      await queryRunner.commitTransaction();

      const response = await this.buildResponse(saved, dto.employeeId, dto.locationId, dto.leaveType);

      // 6. Store idempotency record
      if (dto.idempotencyKey) {
        const ttlHours = this.config.get<number>('IDEMPOTENCY_TTL_HOURS', 24);
        const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
        await this.idempotencyRepo.save(
          this.idempotencyRepo.create({
            key: dto.idempotencyKey,
            responseBody: JSON.stringify(response),
            statusCode: 201,
            expiresAt,
          }),
        );
      }

      return response;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Get single request ──────────────────────────────────────────────────────

  async findOne(id: string) {
    const request = await this.requestRepo.findOne({ where: { id } });
    if (!request) throw new NotFoundException(`Request ${id} not found`);
    return request;
  }

  // ─── List requests ───────────────────────────────────────────────────────────

  async findAll(query: ListRequestsQueryDto) {
    const where: Partial<TimeOffRequest> = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.status) where.status = query.status;
    return this.requestRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  // ─── Approve ─────────────────────────────────────────────────────────────────

  async approve(id: string) {
    const request = await this.findOne(id);
    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new ConflictException(`Request is in state ${request.status}, cannot approve`);
    }

    const dataSource = this.balanceService.getDataSource();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Commit pending → used in local balance
      await this.balanceService.commitDebit(
        request.employeeId, request.locationId, request.leaveType,
        Number(request.daysRequested), queryRunner,
      );

      // Call HCM to permanently commit
      try {
        await this.hcmAdapter.commitDebit(request.hcmTransactionId);
        request.status = RequestStatus.APPROVED;
        request.resolvedAt = new Date();
      } catch {
        // HCM commit failed — move to APPROVAL_FAILED, restore balances
        await this.balanceService.reverseUsed(
          request.employeeId, request.locationId, request.leaveType,
          Number(request.daysRequested), queryRunner,
        );
        request.status = RequestStatus.APPROVAL_FAILED;
        this.logger.error(`HCM commit failed for request ${id} — moved to APPROVAL_FAILED`);
      }

      await queryRunner.manager.save(TimeOffRequest, request);
      await queryRunner.commitTransaction();
      return request;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Reject ──────────────────────────────────────────────────────────────────

  async reject(id: string, dto: RejectRequestDto) {
    const request = await this.findOne(id);
    if (request.status !== RequestStatus.PENDING_APPROVAL) {
      throw new ConflictException(`Request is in state ${request.status}, cannot reject`);
    }

    const dataSource = this.balanceService.getDataSource();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await this.balanceService.releasePending(
        request.employeeId, request.locationId, request.leaveType,
        Number(request.daysRequested), queryRunner,
      );

      // Attempt HCM rollback (best-effort)
      if (request.hcmTransactionId) {
        try {
          await this.hcmAdapter.rollbackDebit(request.hcmTransactionId);
        } catch {
          this.logger.warn(`HCM rollback failed for request ${id} — balance released locally`);
        }
      }

      request.status = RequestStatus.REJECTED;
      request.managerComment = dto.managerComment;
      request.resolvedAt = new Date();
      await queryRunner.manager.save(TimeOffRequest, request);
      await queryRunner.commitTransaction();
      return request;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Cancel ──────────────────────────────────────────────────────────────────

  async cancel(id: string) {
    const request = await this.findOne(id);
    const cancellableStates = [
      RequestStatus.PENDING_APPROVAL,
      RequestStatus.APPROVED,
      RequestStatus.CANCEL_REQUESTED,
    ];
    if (!cancellableStates.includes(request.status)) {
      throw new ConflictException(`Request in state ${request.status} cannot be cancelled`);
    }

    const dataSource = this.balanceService.getDataSource();
    const queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      if (request.status === RequestStatus.APPROVED) {
        await this.balanceService.reverseUsed(
          request.employeeId, request.locationId, request.leaveType,
          Number(request.daysRequested), queryRunner,
        );
      } else {
        await this.balanceService.releasePending(
          request.employeeId, request.locationId, request.leaveType,
          Number(request.daysRequested), queryRunner,
        );
      }

      if (request.hcmTransactionId) {
        try {
          await this.hcmAdapter.rollbackDebit(request.hcmTransactionId);
        } catch {
          this.logger.warn(`HCM rollback failed for cancel of request ${id}`);
        }
      }

      request.status = RequestStatus.CANCELLED;
      request.resolvedAt = new Date();
      await queryRunner.manager.save(TimeOffRequest, request);
      await queryRunner.commitTransaction();
      return request;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private validateDates(startDate: string, endDate: string) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format');
    }
    if (end < start) {
      throw new BadRequestException('endDate must be on or after startDate');
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (start < today) {
      throw new BadRequestException('startDate cannot be in the past');
    }
  }

  /** Count weekdays between two ISO date strings (inclusive) */
  calculateBusinessDays(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    let count = 0;
    const current = new Date(start);
    while (current <= end) {
      const day = current.getDay();
      if (day !== 0 && day !== 6) count++;
      current.setDate(current.getDate() + 1);
    }
    return count;
  }

  private async buildResponse(
    request: TimeOffRequest,
    employeeId: string,
    locationId: string,
    leaveType: any,
    queryRunner?: any,
  ) {
    let currentBalance: any = null;
    try {
      const result = await this.balanceService.getBalance(employeeId, locationId, leaveType);
      currentBalance = result.balance;
    } catch {
      // balance may not exist yet — non-fatal
    }
    return {
      requestId: request.id,
      status: request.status,
      daysRequested: Number(request.daysRequested),
      leaveType: request.leaveType,
      startDate: request.startDate,
      endDate: request.endDate,
      currentBalance,
      createdAt: request.createdAt,
    };
  }
}