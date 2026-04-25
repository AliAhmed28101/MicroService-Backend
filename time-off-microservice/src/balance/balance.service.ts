import {
  Injectable, NotFoundException, ConflictException, Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { LeaveBalance } from '../balance/leave-balance.entity';
import { LeaveType } from '../common/enums/enums';

@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);
  private readonly stalenessMinutes: number;

  constructor(
    @InjectRepository(LeaveBalance)
    private readonly balanceRepo: Repository<LeaveBalance>,
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {
    this.stalenessMinutes = this.config.get<number>('BALANCE_STALENESS_MINUTES', 30);
  }

  /** Get all leave type balances for (employeeId, locationId) */
  async getBalances(employeeId: string, locationId: string): Promise<{
    balances: ReturnType<BalanceService['formatBalance']>[];
    stale: boolean;
  }> {
    const rows = await this.balanceRepo.find({ where: { employeeId, locationId } });
    if (rows.length === 0) {
      throw new NotFoundException(
        `No balances found for employee ${employeeId} at location ${locationId}`,
      );
    }
    const stale = rows.some((r) => this.isStale(r));
    return { balances: rows.map((r) => this.formatBalance(r)), stale };
  }

  /** Get a single leave-type balance */
  async getBalance(employeeId: string, locationId: string, leaveType: LeaveType) {
    const row = await this.balanceRepo.findOne({
      where: { employeeId, locationId, leaveType },
    });
    if (!row) {
      throw new NotFoundException(
        `Balance not found for ${employeeId} / ${locationId} / ${leaveType}`,
      );
    }
    return { balance: this.formatBalance(row), stale: this.isStale(row) };
  }

  /**
   * Acquire a row-level lock on the balance row and return it.
   * Caller is responsible for running this inside a QueryRunner transaction.
   */
  async getLockedBalance(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    queryRunner: import('typeorm').QueryRunner,
  ): Promise<LeaveBalance> {
    // SQLite doesn't support SELECT ... FOR UPDATE; we serialise via the
    // single-writer SQLite journal lock instead. For Postgres swap, add FOR UPDATE.
    const row = await queryRunner.manager.findOne(LeaveBalance, {
      where: { employeeId, locationId, leaveType },
    });
    if (!row) {
      throw new NotFoundException(
        `Balance not found for ${employeeId} / ${locationId} / ${leaveType}`,
      );
    }
    return row;
  }

  /** Deduct pendingBalance when a request is submitted */
  async debitPending(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
    queryRunner: import('typeorm').QueryRunner,
  ): Promise<LeaveBalance> {
    const row = await this.getLockedBalance(employeeId, locationId, leaveType, queryRunner);
    const available =
      Number(row.totalBalance) - Number(row.usedBalance) - Number(row.pendingBalance);

    if (days > available) {
      throw new ConflictException(
        `Insufficient balance: requested ${days} days, available ${available}`,
      );
    }
    row.pendingBalance = Number(row.pendingBalance) + days;
    row.version += 1;
    return queryRunner.manager.save(LeaveBalance, row);
  }

  /** Move pendingBalance → usedBalance on approval */
  async commitDebit(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
    queryRunner: import('typeorm').QueryRunner,
  ): Promise<LeaveBalance> {
    const row = await this.getLockedBalance(employeeId, locationId, leaveType, queryRunner);
    row.pendingBalance = Math.max(0, Number(row.pendingBalance) - days);
    row.usedBalance = Number(row.usedBalance) + days;
    row.version += 1;
    return queryRunner.manager.save(LeaveBalance, row);
  }

  /** Release pendingBalance on rejection / cancellation */
  async releasePending(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
    queryRunner: import('typeorm').QueryRunner,
  ): Promise<LeaveBalance> {
    const row = await this.getLockedBalance(employeeId, locationId, leaveType, queryRunner);
    row.pendingBalance = Math.max(0, Number(row.pendingBalance) - days);
    row.version += 1;
    return queryRunner.manager.save(LeaveBalance, row);
  }

  /** Reverse usedBalance on cancellation of an approved request */
  async reverseUsed(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    days: number,
    queryRunner: import('typeorm').QueryRunner,
  ): Promise<LeaveBalance> {
    const row = await this.getLockedBalance(employeeId, locationId, leaveType, queryRunner);
    row.usedBalance = Math.max(0, Number(row.usedBalance) - days);
    row.version += 1;
    return queryRunner.manager.save(LeaveBalance, row);
  }

  /** Upsert a balance row — used by HCM batch sync */
  async upsertFromHcm(
    employeeId: string,
    locationId: string,
    leaveType: LeaveType,
    totalBalance: number,
    syncedAt: Date = new Date(),
  ): Promise<LeaveBalance> {
    let row = await this.balanceRepo.findOne({ where: { employeeId, locationId, leaveType } });
    if (!row) {
      row = this.balanceRepo.create({ employeeId, locationId, leaveType });
    }
    row.totalBalance = totalBalance;
    row.hcmSyncedAt = syncedAt;
    row.version += 1;
    return this.balanceRepo.save(row);
  }

  /** Get the DataSource so modules can open QueryRunners */
  getDataSource(): DataSource {
    return this.dataSource;
  }

  private isStale(row: LeaveBalance): boolean {
    if (!row.hcmSyncedAt) return true;
    const ageMs = Date.now() - new Date(row.hcmSyncedAt).getTime();
    return ageMs > this.stalenessMinutes * 60 * 1000;
  }

  formatBalance(row: LeaveBalance) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      locationId: row.locationId,
      leaveType: row.leaveType,
      total: Number(row.totalBalance),
      used: Number(row.usedBalance),
      pending: Number(row.pendingBalance),
      available:
        Number(row.totalBalance) -
        Number(row.usedBalance) -
        Number(row.pendingBalance),
      hcmSyncedAt: row.hcmSyncedAt,
      updatedAt: row.updatedAt,
    };
  }
}