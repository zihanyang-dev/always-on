import { defineConfig } from 'drizzle-kit';
import { parseDatabaseEnv } from './src/bootstrap/env.js';

const env = parseDatabaseEnv(process.env);

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/infrastructure/database/schema.ts',
    './src/infrastructure/database/authentication-schema.ts',
    './src/infrastructure/database/workspace-schema.ts',
  ],
  out: './migrations',
  dbCredentials: { url: env.DATABASE_URL },
});
