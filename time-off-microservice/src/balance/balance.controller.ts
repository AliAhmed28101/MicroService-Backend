import { Controller, Get, Param, Res, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Response } from 'express';
import { BalanceService } from './balance.service';
import { LeaveType } from '../common/enums/enums';

@ApiTags('Balances')
@ApiBearerAuth()
@Controller('balances')
export class BalanceController {
  constructor(private readonly balanceService: BalanceService) {}

  @Get(':employeeId/:locationId')
  @ApiOperation({ summary: 'Get all leave type balances for an employee at a location' })
  @ApiParam({ name: 'employeeId', example: 'EMP-00123' })
  @ApiParam({ name: 'locationId', example: 'LOC-NYC' })
  async getBalances(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Res() res: Response,
  ) {
    const result = await this.balanceService.getBalances(employeeId, locationId);
    const headers: Record<string, string> = {};
    if (result.stale) headers['X-Balance-Stale'] = 'true';
    return res.set(headers).status(HttpStatus.OK).json(result);
  }

  @Get(':employeeId/:locationId/:leaveType')
  @ApiOperation({ summary: 'Get a specific leave type balance' })
  @ApiParam({ name: 'leaveType', enum: LeaveType })
  async getBalance(
    @Param('employeeId') employeeId: string,
    @Param('locationId') locationId: string,
    @Param('leaveType') leaveType: LeaveType,
    @Res() res: Response,
  ) {
    const result = await this.balanceService.getBalance(employeeId, locationId, leaveType);
    const headers: Record<string, string> = {};
    if (result.stale) headers['X-Balance-Stale'] = 'true';
    return res.set(headers).status(HttpStatus.OK).json(result);
  }
}