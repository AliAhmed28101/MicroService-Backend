import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('idempotency_records')
export class IdempotencyRecord {
  @PrimaryColumn()
  key: string;

  @Column({ type: 'text' })
  responseBody: string; // serialised JSON of the original response

  @Column({ type: 'int', default: 201 })
  statusCode: number;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'datetime' })
  expiresAt: Date;
}