import { pgTable, uuid, text, integer, boolean, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { reportsTable } from "./reports";

export const pdfImportsTable = pgTable("msb_pdf_imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  reportId: uuid("report_id").references(() => reportsTable.id, { onDelete: "cascade" }),
  createdBy: text("created_by").notNull(),
  fileName: text("file_name").notNull(),
  objectPath: text("object_path").notNull().unique(),
  size: integer("size").notNull(),
  pageCount: integer("page_count").notNull().default(1),
  status: text("status").notNull().default("uploaded"),
  error: text("error"),
  warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  missing: jsonb("missing").$type<string[]>().notNull().default([]),
  reviewed: boolean("reviewed").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("msb_pdf_import_report_idx").on(t.reportId)]);

export const erasedNamesTable = pgTable("msb_erased_names", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  changedBy: text("changed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
