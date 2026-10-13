import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userProfilesTable = pgTable("msb_user_profiles", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull().default(""),
  name: text("name").notNull().default(""),
  role: text("role").notNull().default("intervenant"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clientsTable = pgTable("msb_clients", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sitesTable = pgTable(
  "msb_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clientsTable.id),
    name: text("name").notNull(),
    address: text("address").notNull(),
    tenant: text("tenant"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("msb_sites_client_id_idx").on(table.clientId)],
);

export const reportsTable = pgTable(
  "msb_reports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sitesTable.id),
    interventionDate: date("intervention_date", { mode: "string" }).notNull(),
    tenant: text("tenant"),
    object: text("object").notNull(),
    workOrder: text("work_order"),
    status: text("status").notNull().default("brouillon"),
    interventionState: text("intervention_state").notNull().default("en_cours"),
    conclusion: jsonb("conclusion").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    fiche: jsonb("fiche").$type<Record<string, unknown>>().notNull().default({}),
    missingFields: jsonb("missing_fields").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("msb_reports_site_id_idx").on(table.siteId),
    index("msb_reports_created_by_idx").on(table.createdBy),
    index("msb_reports_date_idx").on(table.interventionDate),
    index("msb_reports_status_idx").on(table.status),
  ],
);

export const reportZonesTable = pgTable(
  "msb_report_zones",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rawNotes: text("raw_notes"),
    context: text("context"),
    findings: jsonb("findings").$type<string[]>().notNull().default([]),
    workDone: jsonb("work_done").$type<string[]>().notNull().default([]),
    order: integer("order").notNull().default(0),
  },
  (table) => [index("msb_report_zones_report_order_idx").on(table.reportId, table.order)],
);

export const reportPhotosTable = pgTable(
  "msb_report_photos",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    zoneId: uuid("zone_id")
      .notNull()
      .references(() => reportZonesTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull().unique(),
    caption: text("caption"),
    groupTitle: text("group_title"),
    category: text("category").notNull().default("autre"),
    order: integer("order").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("msb_report_photos_zone_order_idx").on(table.zoneId, table.order)],
);

export const reportVersionsTable = pgTable(
  "msb_report_versions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportsTable.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    objectPath: text("object_path").notNull(),
    compliant: boolean("compliant").notNull().default(false),
    issues: jsonb("issues").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("msb_report_versions_report_version_idx").on(table.reportId, table.version),
    index("msb_report_versions_created_at_idx").on(table.createdAt),
  ],
);

export const reportStatusHistoryTable = pgTable(
  "msb_report_status_history",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reportsTable.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    changedBy: text("changed_by").notNull(),
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("msb_report_status_history_report_idx").on(table.reportId, table.createdAt)],
);
