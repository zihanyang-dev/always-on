import { defineConfig } from 'drizzle-kit';
import { parseDatabaseEnv } from './src/bootstrap/env.js';

const env = parseDatabaseEnv(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/database/schema.ts',
  out: './migrations',
  dbCredentials: { url: env.DATABASE_URL },
});
