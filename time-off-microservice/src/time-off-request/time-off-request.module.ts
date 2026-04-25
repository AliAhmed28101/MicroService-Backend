import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TimeOffRequest } from '../time-off-request/time-off-request.entity';
import { IdempotencyRecord } from '../idempotency-record.entity';
import { TimeOffRequestService } from './time-off-request.service';
import { TimeOffRequestController } from './time-off-request.controller';
import { BalanceModule } from '../balance/balance.module';
import { HcmSyncModule } from '../hcm-sync/hcm-sync.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimeOffRequest, IdempotencyRecord]),
    BalanceModule,
    HcmSyncModule,
  ],
  providers: [TimeOffRequestService],
  controllers: [TimeOffRequestController],
  exports: [TimeOffRequestService],
})
export class TimeOffRequestModule {}