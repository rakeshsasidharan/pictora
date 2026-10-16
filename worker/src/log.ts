/** Writes one JSON log line. An `error` field is reduced to its message, so provider detail stays readable. */
export function log(
  level: 'INFO' | 'WARN' | 'ERROR',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const { error, ...rest } = fields;
  const line = JSON.stringify({
    level,
    message,
    ...rest,
    ...(error === undefined
      ? {}
      : { error: error instanceof Error ? error.message : String(error) }),
  });
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else console.log(line);
}
