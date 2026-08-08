import { config as loadDotenv } from 'dotenv';
import type { DatabaseOptions } from './database';

loadDotenv();

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${name} debe ser un entero, se recibio "${raw}"`);
  }
  return parsed;
}

export const DEFAULT_DATABASE_URL = 'postgres://lab:lab@localhost:5433/whatsapp_lab';
export const DEFAULT_TEST_DATABASE_URL = 'postgres://lab:lab@localhost:5433/whatsapp_lab_test';

export function databaseOptions(overrides: Partial<DatabaseOptions> = {}): DatabaseOptions {
  return {
    connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: readInt('DATABASE_POOL_MAX', 10),
    connectionTimeoutMillis: readInt('DATABASE_CONNECTION_TIMEOUT_MS', 5_000),
    statementTimeoutMillis: readInt('DATABASE_STATEMENT_TIMEOUT_MS', 10_000),
    ...overrides,
  };
}

export function testDatabaseOptions(overrides: Partial<DatabaseOptions> = {}): DatabaseOptions {
  return databaseOptions({
    connectionString: process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL,
    applicationName: 'whatsapp-concurrency-lab-test',
    ...overrides,
  });
}
