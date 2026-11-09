import { customType, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { authUser } from './auth-schema.ts'

const binary = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

// A small, re-encoded profile photo kept privately in Paddock's own Postgres,
// so it is covered by the project's encrypted backups. Removed with the user.
export const userProfile = pgTable('user_profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  avatar: binary('avatar'),
  avatarVersion: text('avatar_version'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
})
