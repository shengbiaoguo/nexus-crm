import { Body, Controller, Get, Header, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiResponse,
  ApiNoContentResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { LoginDto, RefreshDto, TokenPairResponseDto, IdentityResponseDto } from './auth.dto.js';
import { ErrorResponseDto } from '../http/error-response.dto.js';
import { AuthGuard, AuthThrottleGuard } from './auth.guard.js';
import type { AuthRequest } from './auth.guard.js';

@ApiTags('auth')
@ApiResponse({
  status: 401,
  type: ErrorResponseDto,
  description: 'Invalid credentials, revoked session or expired token',
})
@ApiResponse({
  status: 503,
  type: ErrorResponseDto,
  description: 'Authentication configuration, database or audit unavailable',
})
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottleGuard)
  @ApiOperation({ operationId: 'authLogin' })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto })
  @ApiOkResponse({
    type: TokenPairResponseDto,
    description: 'Token pair inside the standard data envelope',
  })
  login(@Body() input: LoginDto, @Res({ passthrough: true }) response: Response) {
    return this.auth.login(
      input.loginName,
      input.password,
      String(response.getHeader('X-Request-Id')),
    );
  }

  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthThrottleGuard)
  @ApiOperation({ operationId: 'authRefresh' })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({ status: 429, type: ErrorResponseDto })
  @ApiOkResponse({
    type: TokenPairResponseDto,
    description: 'Rotated token pair inside the standard data envelope',
  })
  refresh(@Body() input: RefreshDto, @Res({ passthrough: true }) response: Response) {
    return this.auth.refresh(input.refreshToken, String(response.getHeader('X-Request-Id')));
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ operationId: 'authLogout' })
  @ApiNoContentResponse({ description: 'Current session revoked' })
  logout(@Req() request: AuthRequest, @Res({ passthrough: true }) response: Response) {
    return this.auth.logout(request.identity, String(response.getHeader('X-Request-Id')));
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ operationId: 'authMe' })
  @ApiOkResponse({ type: IdentityResponseDto })
  me(@Req() request: AuthRequest) {
    return this.auth.me(request.identity);
  }
}
