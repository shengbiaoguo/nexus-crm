import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../http/error-response.dto.js';
import { UserIdDto } from './identity.dto.js';
import {
  AssignRolesDto,
  IdentityCommandDto,
  IdentityCommandResponseDto,
  IdentityAccessStateResponseDto,
} from './identity-write.dto.js';
import { IdentityWriteService } from './identity-write.service.js';

@ApiTags('identity-authorization')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@UseGuards(AuthGuard)
@Controller('users')
export class IdentityWriteController {
  constructor(private readonly identity: IdentityWriteService) {}

  @Get(':id/access-state')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'identityAccessState',
    description:
      'user:manage or role:manage paired with IDENTITY; minimal state for versioned identity commands',
  })
  @ApiOkResponse({ type: IdentityAccessStateResponseDto })
  state(@Req() request: AuthRequest, @Param() target: UserIdDto) {
    return this.identity.accessState(request.identity, target.id);
  }

  @Post(':id/assign-roles')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'identityAssignRoles',
    description:
      'role:manage + IDENTITY; business changes also require another protected business authorization owner',
  })
  @ApiOkResponse({ type: IdentityCommandResponseDto })
  assign(
    @Req() request: AuthRequest,
    @Param() target: UserIdDto,
    @Body() input: AssignRolesDto,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.identity.assignRoles(
      request.identity,
      target.id,
      input,
      key,
      String(response.getHeader('X-Request-Id')),
    );
  }

  @Post(':id/disable')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'identityDisable',
    description:
      'user:manage + IDENTITY; protected accounts also require another business authorization owner',
  })
  @ApiOkResponse({ type: IdentityCommandResponseDto })
  disable(
    @Req() request: AuthRequest,
    @Param() target: UserIdDto,
    @Body() input: IdentityCommandDto,
    @Headers('idempotency-key') key: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.identity.disable(
      request.identity,
      target.id,
      input,
      key,
      String(response.getHeader('X-Request-Id')),
    );
  }
}
