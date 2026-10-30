export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Conversion, not authorization: callers must select an explicit public/audit field whitelist first.
export function serializeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializeJson);
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeJson(item)]),
    );
  }
  throw new TypeError(
    'Unsupported JSON value; explicitly map non-JSON types before persistence or transport',
  );
}
