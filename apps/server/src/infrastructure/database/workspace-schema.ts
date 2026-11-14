import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { AUTH_USERS } from './authentication-schema.js';

/** Collaboration spaces mapped from the SDK's organization model. */
export const WORKSPACES = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  metadata: text('metadata'),
});

/** The SDK owns membership writes and its supported single or combined role representation. */
export const WORKSPACE_MEMBERS = pgTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    organizationId: text('workspace_id')
      .notNull()
      .references(() => WORKSPACES.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => AUTH_USERS.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('workspace_members_workspace_id_idx').on(table.organizationId),
    index('workspace_members_user_id_idx').on(table.userId),
  ],
);

/** Recipient-bound invitations retain the SDK's status and expiry semantics. */
export const WORKSPACE_INVITATIONS = pgTable(
  'workspace_invitations',
  {
    id: text('id').primaryKey(),
    organizationId: text('workspace_id')
      .notNull()
      .references(() => WORKSPACES.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    inviterId: text('inviter_id')
      .notNull()
      .references(() => AUTH_USERS.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('workspace_invitations_workspace_id_idx').on(table.organizationId),
    index('workspace_invitations_email_idx').on(table.email),
  ],
);

/** Maps SDK model identifiers to the application's single set of workspace tables. */
export const WORKSPACE_TABLES = {
  organization: WORKSPACES,
  member: WORKSPACE_MEMBERS,
  invitation: WORKSPACE_INVITATIONS,
};
