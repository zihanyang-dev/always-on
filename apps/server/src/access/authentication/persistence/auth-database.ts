import type { BetterAuthOptions } from 'better-auth';
import { CamelCasePlugin } from 'kysely';
import { DATABASE_SCHEMA, type Database } from '../../../infrastructure/database/index.ts';

/** Adapts Better Auth's field names to the SQL schema using the shared pool. */
export function authDatabase(db: Database): NonNullable<BetterAuthOptions['database']> {
  return {
    db: db.withPlugin(new CamelCasePlugin()),
    type: 'postgres',
    schemaName: DATABASE_SCHEMA,
    transaction: true,
  };
}
