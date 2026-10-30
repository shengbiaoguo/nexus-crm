import {
  applyDecorators,
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
  type Type,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard.js';
import type { AuthRequest } from '../auth/auth.guard.js';
import { ErrorResponseDto } from '../http/error-response.dto.js';
import { IdentityReadService } from './identity-read.service.js';
import {
  DepartmentDto,
  PageQueryDto,
  PageMetaDto,
  PermissionDto,
  RoleSummaryDto,
  UserIdDto,
  UserProfileDto,
  UserProfileResponseDto,
} from './identity.dto.js';

function listResponse(model: Type<unknown>) {
  return applyDecorators(
    ApiExtraModels(model, PageMetaDto),
    ApiOkResponse({
      schema: {
        type: 'object',
        required: ['data', 'meta', 'requestId'],
        properties: {
          data: { type: 'array', items: { $ref: getSchemaPath(model) } },
          meta: { $ref: getSchemaPath(PageMetaDto) },
          requestId: { type: 'string', format: 'uuid' },
        },
      },
    }),
  );
}

@ApiTags('identity-authorization')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@UseGuards(AuthGuard)
@Controller()
export class IdentityReadController {
  constructor(private readonly identity: IdentityReadService) {}

  @Get('users')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listUsers',
    description: 'Requires user:manage paired with IDENTITY',
  })
  @listResponse(UserProfileDto)
  users(@Req() request: AuthRequest, @Query() query: PageQueryDto) {
    return this.identity.users(request.identity, query);
  }

  @Get('users/:id')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'getUser',
    description: 'Self profile or user:manage + IDENTITY; invisible targets return 404',
  })
  @ApiOkResponse({ type: UserProfileResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  user(@Req() request: AuthRequest, @Param() target: UserIdDto) {
    return this.identity.user(request.identity, target.id);
  }

  @Get('roles')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listRoles',
    description: 'Requires role:manage paired with IDENTITY',
  })
  @listResponse(RoleSummaryDto)
  roles(@Req() request: AuthRequest, @Query() query: PageQueryDto) {
    return this.identity.roles(request.identity, query);
  }

  @Get('permissions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listPermissions',
    description: 'Requires role:manage paired with IDENTITY',
  })
  @listResponse(PermissionDto)
  permissions(@Req() request: AuthRequest, @Query() query: PageQueryDto) {
    return this.identity.permissions(request.identity, query);
  }

  @Get('departments')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    operationId: 'listDepartments',
    description: 'Requires department:read + AUTHENTICATED; paged active tree nodes only',
  })
  @listResponse(DepartmentDto)
  departments(@Req() request: AuthRequest, @Query() query: PageQueryDto) {
    return this.identity.departments(request.identity, query);
  }
}
