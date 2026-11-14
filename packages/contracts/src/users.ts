import { z } from 'zod';

/** Public profile returned for the authenticated user, without session or provider credentials. */
export type UserProfile = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
};

/** Validates the profile allowlist at SDK and HTTP boundaries. */
export const USER_PROFILE_SCHEMA: z.ZodType<UserProfile> = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.email(),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
});

/** Login methods supported by the platform; deployment configuration selects the enabled subset. */
export const LOGIN_METHODS = ['google', 'github', 'email-password'] as const;
/** One enabled login method advertised to clients. */
export type LoginMethod = (typeof LOGIN_METHODS)[number];
