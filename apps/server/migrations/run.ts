import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

/** Runs the committed SQL migrations with an application-specific journal. */
export async function migrateDatabase(databaseUrl: string): Promise<void> {
  await runner({
    databaseUrl,
    dir: fileURLToPath(new URL('./*.sql', import.meta.url)),
    useGlob: true,
    migrationsSchema: 'always_on_migrations',
    createMigrationsSchema: true,
    migrationsTable: 'migrations',
    direction: 'up',
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: 'wait',
    verbose: false,
  });
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for migrations');

  await migrateDatabase(databaseUrl);
}
