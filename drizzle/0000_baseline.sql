CREATE TABLE "attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"month" text NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backgrounds" (
	"venue" text PRIMARY KEY NOT NULL,
	"file" text NOT NULL,
	"version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"season" integer NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"event_id" text,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mappings" (
	"event_id" text NOT NULL,
	"session" text NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"last_image_version" text,
	"last_synced_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "mappings_pkey" PRIMARY KEY("event_id","session"),
	CONSTRAINT "mappings_item_id_key" UNIQUE("item_id")
);
--> statement-breakpoint
CREATE TABLE "overlays" (
	"venue" text PRIMARY KEY NOT NULL,
	"colours" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_drafts" (
	"venue" text PRIMARY KEY NOT NULL,
	"selected_version_id" text,
	"colours" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"venue" text NOT NULL,
	"file" text NOT NULL,
	"version" text NOT NULL,
	"source" text NOT NULL,
	"parent_id" text,
	"feedback" text,
	"prompt" text,
	"model" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "studio_versions_venue_version_key" UNIQUE("venue","version")
);
--> statement-breakpoint
CREATE INDEX "attempts_month" ON "attempts" USING btree ("month");--> statement-breakpoint
CREATE INDEX "events_season" ON "events" USING btree ("season");--> statement-breakpoint
CREATE INDEX "jobs_created" ON "jobs" USING btree ("created_at" DESC NULLS FIRST);