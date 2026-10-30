import { serializeJson } from '../http/serialize-json.js';
import type { JsonValue } from '../http/serialize-json.js';

export const REDACTED = '[REDACTED]';
const sensitiveKey =
  /password|passwd|pwd|secret|token|authorization|cookie|credential|bank|accountnumber|cardnumber|phone|mobile|email|contact|address|identitycard|身份证|密码|令牌|银行卡|手机号/i;

function redactText(value: string): string {
  return value
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, REDACTED)
    .replace(/\b(?:mysql|redis|rediss|https?):\/\/[^\s]+/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED)
    .replace(/\+?\d[\d ()-]{9,}\d/g, REDACTED);
}

/** A projection, not a dump: unselected keys at every level are discarded. */
export function auditSnapshot(value: unknown, fields: readonly string[]): JsonValue {
  if (
    !fields.length ||
    fields.some((field) => !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(field))
  ) {
    throw new TypeError('Audit snapshots require explicit field paths');
  }
  const project = (current: unknown, paths: readonly string[], depth: number): JsonValue => {
    if (depth > 12) throw new TypeError('Audit snapshot is too deep');
    if (current === null) return null;
    if (Array.isArray(current)) return current.map((item) => project(item, paths, depth + 1));
    if (typeof current !== 'object' || current instanceof Date) {
      const json = serializeJson(current);
      return typeof json === 'string' ? redactText(json) : json;
    }
    if (Object.getPrototypeOf(current) !== Object.prototype) {
      throw new TypeError('Audit snapshots require plain objects');
    }
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(current)) {
      const selected = paths.filter((path) => path === key || path.startsWith(`${key}.`));
      if (!selected.length) continue;
      const item = (current as Record<string, unknown>)[key];
      if (sensitiveKey.test(key.replace(/[_-]/g, ''))) {
        result[key] = REDACTED;
        continue;
      }
      // Selecting an object alone selects no children; nested fields need their own paths.
      result[key] = project(
        item,
        selected.filter((path) => path !== key).map((path) => path.slice(key.length + 1)),
        depth + 1,
      );
    }
    return result;
  };
  const result = project(value, fields, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 16 * 1024) {
    throw new TypeError('Audit snapshot exceeds 16 KiB');
  }
  return result;
}
