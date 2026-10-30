import 'reflect-metadata';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '@nexus/shared';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import type { Environment } from './config/environment.js';
import { ErrorFilter } from './http/error.filter.js';

export async function createApplication(environment: Environment, logging = true) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logging ? new ConsoleLogger({ json: true }) : false,
    bodyParser: false,
  });
  app.disable('x-powered-by');
  app.use((request: Request, response: Response, next: NextFunction) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.setHeader('X-Request-Id', requestId);
    // Never log headers, query strings or request bodies.
    if (logging) {
      response.once('finish', () =>
        console.log(
          JSON.stringify({
            event: 'http_request',
            requestId,
            method: request.method,
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
          }),
        ),
      );
    }
    next();
  });
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  app.enableCors({ origin: environment.CORS_ORIGIN });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ErrorFilter());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Nexus CRM API').setVersion('0.0.0').addBearerAuth().build(),
  );
  if (environment.SWAGGER_ENABLED) {
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: '/docs-json' });
  }
  app.enableShutdownHooks();
  return { app, document };
}
