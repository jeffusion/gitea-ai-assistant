type UnknownRecord = Record<string, unknown>;

function toUnknownRecord(value: unknown): UnknownRecord {
  if (typeof value === 'object' && value !== null) {
    return value as UnknownRecord;
  }
  return { value };
}

export function toErrorLogMeta(error: unknown): UnknownRecord {
  if (error instanceof Error) {
    const base: UnknownRecord = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const ownProps = Object.getOwnPropertyNames(error);
    for (const prop of ownProps) {
      if (prop in base) {
        continue;
      }
      base[prop] = (error as unknown as UnknownRecord)[prop];
    }

    return base;
  }

  return toUnknownRecord(error);
}
