import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** One identity shared by all of a person's login accounts. */
export const AUTH_USERS = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Revocable login sessions persist independently of Redis availability. */
export const AUTH_SESSIONS = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => AUTH_USERS.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_sessions_user_id_idx').on(table.userId)],
);

/** Provider identities and password hashes are owned by the authentication SDK. */
export const AUTH_ACCOUNTS = pgTable(
  'auth_accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => AUTH_USERS.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('auth_accounts_user_id_idx').on(table.userId),
    uniqueIndex('auth_accounts_provider_identity_idx').on(table.providerId, table.accountId),
  ],
);

/** Expiring verification, password-reset and OAuth state records. */
export const AUTH_VERIFICATIONS = pgTable(
  'auth_verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
);

/** Maps Better Auth's public model names to the application's single set of identity tables. */
export const AUTHENTICATION_TABLES = {
  user: AUTH_USERS,
  session: AUTH_SESSIONS,
  account: AUTH_ACCOUNTS,
  verification: AUTH_VERIFICATIONS,
};
