import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HttpModule } from '@nestjs/axios';
import { SyncError } from './sync-error.entity';
import { HcmAdapterService } from './hcm-adapter.service';
import { HcmSyncService } from './hcm-sync.service';
import { HcmSyncController } from './hcm-sync.controller';
import { BalanceModule } from '../balance/balance.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncError]),
    HttpModule,
    BalanceModule,
  ],
  providers: [HcmAdapterService, HcmSyncService],
  controllers: [HcmSyncController],
  exports: [HcmAdapterService, HcmSyncService],
})
export class HcmSyncModule {}