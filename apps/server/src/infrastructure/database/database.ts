import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { AUTHENTICATION_TABLES } from './authentication-schema.js';
import { INBOX_EVENTS } from './schema.js';

const DATABASE_SCHEMA = { ...AUTHENTICATION_TABLES, inboxEvents: INBOX_EVENTS };

/** Database handle shared with feature-owned queries and transactions. */
export type Database = NodePgDatabase<typeof DATABASE_SCHEMA>;
/** Pool lifetime owned by the process or integration test that creates it. */
export interface DatabaseResource extends AsyncDisposable {
  readonly db: Database;
  readonly check: () => Promise<void>;
}

/** Creates a bounded pool without opening a connection during module import. */
export function openDatabase({
  url,
  onError,
}: {
  url: string;
  onError: (error: Error) => void;
}): DatabaseResource {
  const pool = new Pool({
    connectionString: url,
    max: 10,
    connectionTimeoutMillis: 2_000,
    query_timeout: 3_000,
  });
  pool.on('error', onError);
  const db = drizzle(pool, { schema: DATABASE_SCHEMA });
  return { db, check, [Symbol.asyncDispose]: dispose };

  async function check() {
    await pool.query('select 1');
  }
  async function dispose() {
    await pool.end();
  }
}
