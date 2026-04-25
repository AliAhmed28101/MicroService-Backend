import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn, Index,
} from 'typeorm';
import { LeaveType } from '../common/enums/enums';

@Entity('leave_balances')
@Index(['employeeId', 'locationId', 'leaveType'], { unique: true })
export class LeaveBalance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'varchar', default: LeaveType.ANNUAL })
  leaveType: LeaveType;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  totalBalance: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  usedBalance: number;

  @Column({ type: 'decimal', precision: 6, scale: 2, default: 0 })
  pendingBalance: number;

  // availableBalance is a computed getter — never stored
  get availableBalance(): number {
    return (
      Number(this.totalBalance) -
      Number(this.usedBalance) -
      Number(this.pendingBalance)
    );
  }

  @Column({ type: 'datetime', nullable: true })
  hcmSyncedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  version: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}