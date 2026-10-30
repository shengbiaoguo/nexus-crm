import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { API_PREFIX } from '@nexus/shared';
import { AppModule } from './app.module.js';
import type { Environment } from './config/environment.js';
import { ErrorFilter } from './http/error.filter.js';
import { createValidationPipe } from './http/validation.pipe.js';
import { requestIdMiddleware } from './http/request-id.middleware.js';
import { ResponseInterceptor } from './http/response.interceptor.js';
import { ErrorResponseDto } from './http/error-response.dto.js';
import { StructuredLogger } from './logging/structured-logger.service.js';

export async function createApplication(environment: Environment, logging = true) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(environment), {
    logger: false,
    bodyParser: false,
  });
  const logger = app.get(StructuredLogger);
  logger.setEnabled(logging);
  app.useLogger(logging ? logger : false);
  app.disable('x-powered-by');
  app.use(requestIdMiddleware(logging, logger));
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix(API_PREFIX.slice(1));
  app.enableCors({ origin: environment.CORS_ORIGIN });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ErrorFilter(logger));
  app.useGlobalInterceptors(new ResponseInterceptor());
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nexus CRM API')
      .setVersion('0.0.0')
      .addBearerAuth()
      .addGlobalResponse({
        status: 500,
        description: 'Unexpected server error; internal details are not exposed',
        type: ErrorResponseDto,
        headers: { 'X-Request-Id': { schema: { type: 'string', format: 'uuid' } } },
      })
      .build(),
  );
  if (environment.SWAGGER_ENABLED) {
    SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: '/docs-json' });
  }
  app.enableShutdownHooks();
  return { app, document };
}
