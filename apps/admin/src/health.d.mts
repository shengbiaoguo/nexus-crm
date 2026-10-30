import type { ApiResponse, HealthStatus } from '@nexus/shared';

export function isHealthyResponse(body: unknown): body is ApiResponse<HealthStatus>;
