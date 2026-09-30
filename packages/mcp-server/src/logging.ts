type LogLevel = 'error' | 'info' | 'warn';

const REDACTED_KEYS = /authorization|credential|secret|token|api[_-]?key/iu;

function sanitizeFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      REDACTED_KEYS.test(key) ? '[REDACTED]' : value,
    ]),
  );
}

export function log(
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitizeFields(fields),
  };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
