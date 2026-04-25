import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, Index,
} from 'typeorm';
import { LeaveType, RequestStatus } from '../common/enums/enums';

@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  employeeId: string;

  @Column()
  locationId: string;

  @Column({ type: 'varchar' })
  leaveType: LeaveType;

  @Column({ type: 'varchar' })
  startDate: string; // ISO date string YYYY-MM-DD

  @Column({ type: 'varchar' })
  endDate: string;

  @Column({ type: 'decimal', precision: 5, scale: 2 })
  daysRequested: number;

  @Column({ type: 'varchar', default: RequestStatus.PENDING })
  status: RequestStatus;

  @Column({ nullable: true })
  @Index({ unique: true, sparse: true })
  idempotencyKey: string;

  @Column({ nullable: true })
  hcmTransactionId: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  @Column({ type: 'text', nullable: true })
  managerComment: string;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt: Date | null;
}