import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './database.types.ts';

export const DATABASE_SCHEMA = 'always_on';

export type Database = Kysely<DB>;
export type DatabaseTransaction = Transaction<DB>;

/** Opens the per-process pool. Dispose the returned Kysely instance on shutdown. */
export function openDatabase(databaseUrl: string, reportError: (error: Error) => void): Database {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  pool.on('error', reportError);
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }).withSchema(DATABASE_SCHEMA);
}
