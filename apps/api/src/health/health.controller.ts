import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import type { HealthStatus } from '@nexus/shared';

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
  getHealth(): HealthStatus {
    return { status: 'ok' };
  }
}
