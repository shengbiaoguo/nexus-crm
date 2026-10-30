import { Transform } from 'class-transformer';
import { IsInt, IsString, Max, Min, ValidateBy } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const integerQuery = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;

export class PageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 1000000 })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Transform(integerQuery)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize = 20;
}

export class UserIdDto {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,19}$',
    description: 'Canonical unsigned BIGINT ID (1..18446744073709551615)',
  })
  @IsString()
  @ValidateBy({
    name: 'unsignedBigIntId',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'string' &&
        /^[1-9][0-9]{0,19}$/.test(value) &&
        BigInt(value) <= 18446744073709551615n,
    },
  })
  id!: string;
}

export class UserProfileDto {
  @ApiProperty() id!: string;
  @ApiProperty() loginName!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) departmentId!: string | null;
}

export class UserProfileResponseDto {
  @ApiProperty({ type: UserProfileDto }) data!: UserProfileDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}

export class RoleSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['ACTIVE', 'DISABLED'] }) status!: string;
  @ApiProperty() version!: number;
}

export class PermissionDto {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() description!: string;
}

export class DepartmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) parentId!: string | null;
}

export class PageMetaDto {
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
