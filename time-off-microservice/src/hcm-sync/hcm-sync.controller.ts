import { Controller, Post, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { HcmSyncService } from './hcm-sync.service';

@ApiTags('HCM Sync')
@ApiBearerAuth()
@Controller('balances/sync')
export class HcmSyncController {
  constructor(private readonly syncService: HcmSyncService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger on-demand batch sync from HCM' })
  @ApiQuery({ name: 'employeeId', required: false, description: 'Sync a single employee only' })
  async triggerSync(@Query('employeeId') employeeId?: string) {
    return this.syncService.runBatchSync(employeeId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get last sync result and error stats' })
  getStatus() {
    return this.syncService.getSyncStatus();
  }
}