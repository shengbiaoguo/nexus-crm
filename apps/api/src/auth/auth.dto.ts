import { Transform } from 'class-transformer';
import { IsString, Length, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  loginName!: string;

  @ApiProperty({ format: 'password', maxLength: 256 })
  @IsString()
  @Length(1, 256)
  password!: string;
}

export class RefreshDto {
  @ApiProperty({ minLength: 43, maxLength: 43 })
  @IsString()
  @MaxLength(43)
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  refreshToken!: string;
}

export class TokenPairDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty({ example: 'Bearer' }) tokenType!: string;
  @ApiProperty({ example: 900 }) expiresIn!: number;
  @ApiProperty({ format: 'date-time' }) refreshExpiresAt!: string;
}

export class TokenPairResponseDto {
  @ApiProperty({ type: TokenPairDto }) data!: TokenPairDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}

export class PermissionSummaryDto {
  @ApiProperty() roleCode!: string;
  @ApiProperty() code!: string;
  @ApiProperty() scope!: string;
}

export class IdentityDto {
  @ApiProperty() id!: string;
  @ApiProperty() loginName!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [PermissionSummaryDto] }) permissions!: PermissionSummaryDto[];
}

export class IdentityResponseDto {
  @ApiProperty({ type: IdentityDto }) data!: IdentityDto;
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}
