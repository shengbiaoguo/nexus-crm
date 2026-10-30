import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ApiErrorResponse } from '@nexus/shared';

export class ErrorResponseDto implements ApiErrorResponse {
  @ApiProperty({ example: 'INTERNAL_ERROR' })
  code!: string;

  @ApiProperty({ example: 'Internal server error' })
  message!: string;

  @ApiPropertyOptional({
    description: 'Explicitly public error details; validation errors include fields',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: {} },
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
    ],
    nullable: true,
  })
  details?: unknown;

  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;
}
