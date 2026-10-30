import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import { IsInt, IsString, Length, Min, ValidateIf, ValidateNested } from 'class-validator';
import { ErrorFilter } from '../src/http/error.filter.js';
import { createValidationPipe } from '../src/http/validation.pipe.js';

class ChildDto {
  @IsString({ message: 'sensitive $value' })
  @Length(1, 12)
  name!: string;
}

class InputDto {
  @IsInt()
  @Min(1)
  count!: number;

  @ValidateNested()
  @Type(() => ChildDto)
  child!: ChildDto;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  note?: string;
}

class IdDto {
  @IsString()
  id!: string;
}

@Controller('validation')
class ValidationController {
  @Post()
  body(@Body() input: InputDto) {
    assert.ok(input instanceof InputDto);
    assert.ok(input.child instanceof ChildDto);
    return input;
  }

  @Get(':id')
  query(@Param() params: IdDto, @Query() input: ChildDto) {
    return { ...params, ...input };
  }
}

test('global DTO validation rejects invalid fields, types and unknown properties over HTTP', async () => {
  const module = await Test.createTestingModule({ controllers: [ValidationController] }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new ErrorFilter());
  app.use(
    (
      _request: unknown,
      response: { setHeader: (key: string, value: string) => void },
      next: () => void,
    ) => {
      response.setHeader('X-Request-Id', 'validation-test');
      next();
    },
  );
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const valid = { count: 1, child: { name: 'valid' } };
    const send = (body: unknown) =>
      fetch(`${origin}/validation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const accepted = await send(valid);
    assert.equal(accepted.status, 201);
    assert.deepEqual(await accepted.json(), valid);
    for (const [body, field] of [
      [{ ...valid, count: 0 }, 'count'],
      [{ ...valid, count: '1' }, 'count'],
      [{ ...valid, count: true }, 'count'],
      [{ ...valid, count: null }, 'count'],
      [{ child: valid.child }, 'count'],
      [{ ...valid, approvedBy: 'secret-value' }, 'approvedBy'],
      [{ ...valid, child: { name: '' } }, 'child.name'],
      [{ ...valid, child: { name: 123456789 } }, 'child.name'],
      [{ ...valid, child: { name: 'valid', extra: 'secret-value' } }, 'child.extra'],
      [{ ...valid, note: null }, 'note'],
      [[], 'count'],
    ] as const) {
      const response = await send(body);
      assert.equal(response.status, 400);
      const error = (await response.json()) as {
        code: string;
        requestId: string;
        details: { fields: { field: string; reason: string }[] };
      };
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.equal(error.requestId, 'validation-test');
      assert.ok(error.details.fields.some((item) => item.field === field));
      assert.doesNotMatch(JSON.stringify(error), /secret-value|123456789|sensitive|target|stack/);
    }
    assert.equal((await fetch(`${origin}/validation/18446744073709551615?name=valid`)).status, 200);
    const queryError = await fetch(`${origin}/validation/1?name=valid&extra=1`);
    assert.equal(queryError.status, 400);
    const malformed = await fetch(`${origin}/validation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { code: string }).code, 'VALIDATION_FAILED');
  } finally {
    await app.close();
  }
});
