import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

import { LeaveBalance } from './balance/leave-balance.entity';
import { TimeOffRequest } from './time-off-request/time-off-request.entity';
import { IdempotencyRecord } from './idempotency-record.entity';
import { SyncError } from './hcm-sync/sync-error.entity';

import { BalanceModule } from './balance/balance.module';
import { TimeOffRequestModule } from './time-off-request/time-off-request.module';
import { HcmSyncModule } from './hcm-sync/hcm-sync.module';
import { HealthController } from './health.controller';
import * as path from 'path';
import * as fs from 'fs';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => {
        const dbPath = config.get<string>('DATABASE_PATH', './data/toms.db');
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        return {
          type: 'better-sqlite3',
          database: dbPath,
          entities: [LeaveBalance, TimeOffRequest, IdempotencyRecord, SyncError],
          synchronize: true, // auto-creates tables — fine for SQLite dev
        };
      },
      inject: [ConfigService],
    }),
    HttpModule,
    BalanceModule,
    TimeOffRequestModule,
    HcmSyncModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}