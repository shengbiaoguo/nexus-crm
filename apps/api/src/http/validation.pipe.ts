import { BadRequestException, ValidationPipe } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

interface FieldError {
  field: string;
  reason: string;
}

function collectFields(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const field = parent ? `${parent}.${error.property}` : error.property;
    return [
      ...Object.keys(error.constraints ?? {}).map((constraint) => ({
        field,
        // Never expose validator messages: custom messages can interpolate input values.
        reason:
          constraint === 'whitelistValidation' ? 'Unknown property' : `Must satisfy ${constraint}`,
      })),
      ...collectFields(error.children ?? [], field),
    ];
  });
}

export class DtoValidationException extends BadRequestException {
  readonly fields: FieldError[];

  constructor(errors: ValidationError[]) {
    super('Invalid request');
    this.fields = collectFields(errors);
  }
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => new DtoValidationException(errors),
  });
}
