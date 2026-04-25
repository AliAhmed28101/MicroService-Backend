import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveType } from '../common/enums/enums';

export class GetBalanceQueryDto {
  @ApiPropertyOptional({ enum: LeaveType })
  @IsOptional()
  @IsEnum(LeaveType)
  leaveType?: LeaveType;
}

export class SeedBalanceDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsEnum(LeaveType)
  leaveType: LeaveType;

  totalBalance: number;
  usedBalance?: number;
  pendingBalance?: number;
}