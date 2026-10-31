import {
  pgTable,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

// Names, types and constraints match the existing PostgreSQL schema exactly.
export const state = pgTable("state", {
  key: text().primaryKey(),
  value: jsonb().notNull(),
});
export const events = pgTable(
  "events",
  {
    id: text().primaryKey(),
    season: integer().notNull(),
    payload: jsonb().notNull(),
  },
  (t) => [index("events_season").on(t.season)],
);
export const backgrounds = pgTable("backgrounds", {
  venue: text().primaryKey(),
  file: text().notNull(),
  version: text().notNull(),
});
export const jobs = pgTable(
  "jobs",
  {
    id: text().primaryKey(),
    kind: text().notNull(),
    eventId: text("event_id"),
    status: text().notNull(),
    message: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("jobs_created").on(t.createdAt.desc().nullsFirst())],
);
export const attempts = pgTable(
  "attempts",
  {
    id: text().primaryKey(),
    month: text().notNull(),
    model: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("attempts_month").on(t.month)],
);
export const mappings = pgTable(
  "mappings",
  {
    eventId: text("event_id").notNull(),
    session: text().notNull(),
    itemId: text("item_id").notNull(),
    itemName: text("item_name").notNull(),
    lastImageVersion: text("last_image_version"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    error: text(),
  },
  (t) => [
    primaryKey({ name: "mappings_pkey", columns: [t.eventId, t.session] }),
    unique("mappings_item_id_key").on(t.itemId),
  ],
);
export const overlays = pgTable("overlays", {
  venue: text().primaryKey(),
  colours: jsonb().notNull(),
});
export const studioVersions = pgTable(
  "studio_versions",
  {
    id: text().primaryKey(),
    venue: text().notNull(),
    file: text().notNull(),
    version: text().notNull(),
    source: text().notNull(),
    parentId: text("parent_id"),
    feedback: text(),
    prompt: text(),
    model: text(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [unique("studio_versions_venue_version_key").on(t.venue, t.version)],
);
export const studioDrafts = pgTable("studio_drafts", {
  venue: text().primaryKey(),
  selectedVersionId: text("selected_version_id"),
  colours: jsonb().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});
