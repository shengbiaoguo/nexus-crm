import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessIdentity } from './auth.crypto.js';
import { AuthService } from './auth.service.js';

export interface AuthRequest extends Request {
  identity: AccessIdentity;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    request.identity = await this.auth.authenticate(request.headers.authorization);
    return true;
  }
}

@Injectable()
export class AuthThrottleGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    this.auth.throttle(request.ip ?? request.socket.remoteAddress ?? 'unknown');
    return true;
  }
}
