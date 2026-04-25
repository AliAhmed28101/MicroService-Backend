import {
  IsString, IsEnum, IsDateString, IsOptional, IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LeaveType, RequestStatus } from '../common/enums/enums';

export class CreateTimeOffRequestDto {
  @ApiProperty({ example: 'EMP-00123' })
  @IsString()
  employeeId: string;

  @ApiProperty({ example: 'LOC-NYC' })
  @IsString()
  locationId: string;

  @ApiProperty({ enum: LeaveType, example: LeaveType.ANNUAL })
  @IsEnum(LeaveType)
  leaveType: LeaveType;

  @ApiProperty({ example: '2025-07-01' })
  @IsDateString()
  startDate: string;

  @ApiProperty({ example: '2025-07-05' })
  @IsDateString()
  endDate: string;

  @ApiPropertyOptional({ example: 'Summer vacation' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiProperty({ example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890' })
  @IsUUID()
  idempotencyKey: string;
}

export class RejectRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  managerComment?: string;
}

export class ListRequestsQueryDto {
  @ApiPropertyOptional({ example: 'EMP-00123' })
  @IsOptional()
  @IsString()
  employeeId?: string;

  @ApiPropertyOptional({ enum: RequestStatus })
  @IsOptional()
  @IsEnum(RequestStatus)
  status?: RequestStatus;
}