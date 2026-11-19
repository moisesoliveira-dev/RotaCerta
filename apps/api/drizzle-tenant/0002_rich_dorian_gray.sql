CREATE TABLE "ai_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"default_model" text DEFAULT 'claude-opus-5-5' NOT NULL,
	"default_effort" text DEFAULT 'medium' NOT NULL,
	"daily_limit" integer,
	"company_context" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
