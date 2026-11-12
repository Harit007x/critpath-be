-- Read-only views for critpath-ai (the Python service in its own repo). They are its contract with
-- this database: the AI service reads these, never the tables, so the tables can change without
-- breaking it as long as the views keep their columns. Prisma does not manage views; they live in
-- this migration only.

-- One row per stored upload: its summary, plus the report's counts, projects and tables.
CREATE VIEW ai_xer_file AS
SELECT
  f."id",
  f."fileName"       AS file_name,
  f."sizeBytes"      AS size_bytes,
  f."projectName"    AS project_name,
  f."p6Version"      AS p6_version,
  f."exportDate"     AS export_date,
  f."uploadedAt"     AS uploaded_at,
  f."activities",
  f."relationships",
  f."brokenRowCount" AS broken_rows,
  f."missingLinks"   AS missing_links,
  f."negativeFloat"  AS negative_float,
  f."highFloat"      AS high_float,
  f."report" -> 'counts'   AS counts,
  f."report" -> 'projects' AS projects,
  f."report" -> 'tables'   AS tables
FROM "xer_file" f;

-- One row per (upload, check), with the failing activities as the report stored them.
CREATE VIEW ai_xer_check AS
SELECT
  f."id"                        AS file_id,
  c ->> 'id'                    AS check_id,
  c ->> 'name'                  AS name,
  c ->> 'rule'                  AS rule,
  (c ->> 'count')::int          AS failing,
  (c ->> 'denominator')::int    AS checked,
  (c ->> 'pct')::numeric        AS pct,
  c -> 'activities'             AS activities
FROM "xer_file" f
CROSS JOIN LATERAL jsonb_array_elements(f."report" -> 'checks') AS c;

-- One row per broken row.
CREATE VIEW ai_xer_broken_row AS
SELECT
  b."id",
  b."fileId"    AS file_id,
  b."table"     AS table_name,
  b."line",
  b."rowNumber" AS row_number,
  b."kind",
  b."field",
  b."reason"
FROM "xer_broken_row" b;
