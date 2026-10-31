import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class IdentityCommandDto {
  @ApiProperty({ minimum: 1, maximum: 4294967294 })
  @IsInt()
  @Min(1)
  @Max(4294967294)
  expectedVersion!: number;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class AssignRolesDto extends IdentityCommandDto {
  @ApiProperty({
    type: [String],
    maxItems: 100,
    uniqueItems: true,
    description: 'Complete replacement set; empty array revokes all roles',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @ValidateBy({
    name: 'roleIds',
    validator: {
      validate: (values: unknown) =>
        Array.isArray(values) &&
        values.every(
          (value: unknown) =>
            typeof value === 'string' &&
            /^[1-9][0-9]{0,19}$/.test(value) &&
            BigInt(value) <= 18446744073709551615n,
        ),
    },
  })
  roleIds!: string[];
}

export class IdentityCommandResultDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] }) status!: string;
  @ApiProperty() version!: number;
}

export class IdentityCommandResponseDto {
  @ApiProperty({ type: IdentityCommandResultDto }) data!: IdentityCommandResultDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}

export class IdentityAccessStateDto extends IdentityCommandResultDto {
  @ApiProperty({ type: [String] }) roleIds!: string[];
}

export class IdentityAccessStateResponseDto {
  @ApiProperty({ type: IdentityAccessStateDto }) data!: IdentityAccessStateDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}
