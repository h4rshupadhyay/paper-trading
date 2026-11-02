export type SafeLogger = {
  info(event: string, fields: Record<string, unknown>): void;
  error(event: string, fields: Record<string, unknown>): void;
};

const safeFields = new Set(['requestId', 'method', 'route', 'status', 'durationMs', 'code', 'port', 'signal']);

// Never pass request objects or Error instances to a serializer, even at error level.
export function createSafeLogger(
  write: (entry: Record<string, unknown>) => void = entry => console.log(JSON.stringify(entry)),
): SafeLogger {
  function log(level: string, event: string, fields: Record<string, unknown>): void {
    const entry: Record<string, unknown> = { level, event };
    for (const [key, value] of Object.entries(fields)) {
      if (safeFields.has(key) && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))) {
        entry[key] = value;
      }
    }
    write(entry);
  }
  return { info: (event, fields) => log('info', event, fields), error: (event, fields) => log('error', event, fields) };
}
