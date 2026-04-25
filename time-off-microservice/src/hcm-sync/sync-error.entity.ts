import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('sync_errors')
export class SyncError {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true })
  employeeId: string;

  @Column({ nullable: true })
  locationId: string;

  @Column({ type: 'text' })
  rawPayload: string;

  @Column({ type: 'text' })
  errorMessage: string;

  @Column({ type: 'integer', default: 0 })
  attemptCount: number;

  @Column({ type: 'datetime', nullable: true })
  nextRetryAt: Date | null;

  @Column({ type: 'boolean', default: false })
  resolved: boolean;

  @CreateDateColumn()
  createdAt: Date;
}