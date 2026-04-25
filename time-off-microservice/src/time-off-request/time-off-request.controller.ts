import {
  Controller, Get, Post, Patch, Param, Body, Query, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiCreatedResponse } from '@nestjs/swagger';
import { TimeOffRequestService } from './time-off-request.service';
import {
  CreateTimeOffRequestDto, RejectRequestDto, ListRequestsQueryDto,
} from './time-off-request.dto';

@ApiTags('Time-Off Requests')
@ApiBearerAuth()
@Controller('time-off-requests')
export class TimeOffRequestController {
  constructor(private readonly service: TimeOffRequestService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new time-off request' })
  @ApiCreatedResponse({ description: 'Request created (or idempotent duplicate returned)' })
  create(@Body() dto: CreateTimeOffRequestDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List time-off requests with optional filters' })
  findAll(@Query() query: ListRequestsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single time-off request' })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Patch(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a pending request (Manager)' })
  approve(@Param('id') id: string) {
    return this.service.approve(id);
  }

  @Patch(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending request (Manager)' })
  reject(@Param('id') id: string, @Body() dto: RejectRequestDto) {
    return this.service.reject(id, dto);
  }

  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a request (Employee)' })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}