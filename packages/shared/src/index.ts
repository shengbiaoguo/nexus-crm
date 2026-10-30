export const API_PREFIX = '/api/v1';

export interface ApiResponse<T> {
  data: T;
  requestId: string;
}

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiListResponse<T> extends ApiResponse<T[]> {
  meta: PaginationMeta;
}

export interface ApiErrorResponse {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface HealthStatus {
  status: 'ok';
}
