CREATE TABLE "app_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'consume' NOT NULL,
	"pending_date" date,
	"pending_date_label" text,
	"pending_qty" integer,
	"digits" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location_id" integer,
	CONSTRAINT "app_state_id_check" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"barcode" text,
	"item_ids" bigint[] DEFAULT '{}' NOT NULL,
	"undone" boolean DEFAULT false NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_counts" (
	"session_id" integer NOT NULL,
	"barcode" text NOT NULL,
	"location_id" integer DEFAULT 0 NOT NULL,
	"counted" integer DEFAULT 0 NOT NULL,
	"resolved" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "inventory_counts_pkey" PRIMARY KEY("session_id","barcode","location_id"),
	CONSTRAINT "inventory_counts_resolved_check" CHECK (resolved IN ('keep', 'apply'))
);
--> statement-breakpoint
CREATE TABLE "inventory_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"scope" integer[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "inventory_sessions_status_check" CHECK (status IN ('open', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	CONSTRAINT "locations_name_key" UNIQUE("name"),
	CONSTRAINT "locations_kind_check" CHECK (kind IN ('fridge', 'freezer', 'pantry', 'other'))
);
--> statement-breakpoint
CREATE TABLE "products" (
	"barcode" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"quantity_text" text,
	"categories" text,
	"image_url" text,
	"nutriscore" text,
	"nova_group" integer,
	"ecoscore" text,
	"nutriments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingredients" text,
	"allergens" text,
	"serving_size" text,
	"off_found" boolean,
	"off_fetched_at" timestamp with time zone,
	"shelf_life_days" integer,
	"days_after_opening" integer,
	"min_stock" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"store_id" integer,
	"source" text,
	"categories_tags" text[],
	"conservation" text,
	"location_id" integer,
	"auto_defaults" boolean DEFAULT true NOT NULL,
	"move_on_open" boolean DEFAULT true NOT NULL,
	"image_source_url" text,
	"image_file" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopping_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"barcode" text,
	"name" text NOT NULL,
	"qty" integer DEFAULT 1 NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"store_id" integer
);
--> statement-breakpoint
CREATE TABLE "stock_items" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"barcode" text NOT NULL,
	"best_before" date,
	"opened_at" timestamp with time zone,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'in_stock' NOT NULL,
	"finished_at" timestamp with time zone,
	"waste_reason" text,
	"location_id" integer,
	CONSTRAINT "stock_items_status_check" CHECK (status IN ('in_stock', 'consumed', 'wasted', 'adjusted'))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stores_name_key" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "app_state" ADD CONSTRAINT "app_state_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."inventory_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_barcode_fkey" FOREIGN KEY ("barcode") REFERENCES "public"."products"("barcode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_barcode_fkey" FOREIGN KEY ("barcode") REFERENCES "public"."products"("barcode") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopping_items" ADD CONSTRAINT "shopping_items_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_barcode_fkey" FOREIGN KEY ("barcode") REFERENCES "public"."products"("barcode") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_items_status_idx" ON "stock_items" USING btree ("status","barcode");--> statement-breakpoint
-- starting data (hand-written): the usual storage locations and the single scanner state row
INSERT INTO "locations" ("name", "kind") VALUES ('Kühlschrank', 'fridge'), ('Tiefkühler', 'freezer'), ('Vorratsschrank', 'pantry'), ('Keller', 'other');--> statement-breakpoint
INSERT INTO "app_state" ("id", "location_id") VALUES (1, (SELECT "id" FROM "locations" ORDER BY "id" LIMIT 1));
