import { Controller, Get, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { ApiResponse, HealthStatus } from '@nexus/shared';
import type { Request } from 'express';

class HealthData {
  @ApiProperty({ enum: ['ok'] })
  status!: 'ok';
}

class HealthResponse {
  @ApiProperty({ type: HealthData })
  data!: HealthData;

  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;
}

@ApiTags('System')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    operationId: 'getHealth',
    summary: 'Process liveness; does not probe dependencies',
  })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(@Req() request: Request): ApiResponse<HealthStatus> {
    return { data: { status: 'ok' }, requestId: String(request.res?.getHeader('X-Request-Id')) };
  }
}
