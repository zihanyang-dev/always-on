import { join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { openDatabase } from '../infrastructure/database/index.js';
import { parseDatabaseEnv } from './env.js';
import { reportError } from './report-error.js';

try {
  const env = parseDatabaseEnv(process.env);
  await using database = openDatabase({
    url: env.DATABASE_URL,
    onError: reportError,
  });
  await migrate(database.db, {
    migrationsFolder: join(import.meta.dirname, '../../migrations'),
  });
  console.log('Database migrations applied.');
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
