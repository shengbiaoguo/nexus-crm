export const API_PREFIX = '/api/v1';

export interface ApiResponse<T> {
  data: T;
  requestId: string;
}

export interface HealthStatus {
  status: 'ok';
}
