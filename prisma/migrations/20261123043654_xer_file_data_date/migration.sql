-- AlterTable
ALTER TABLE "xer_file" ADD COLUMN     "dataDate" TEXT;

-- Files stored before this column: the first project's data date, from the report saved with them.
UPDATE "xer_file"
SET "dataDate" = LEFT("report" -> 'projects' -> 0 ->> 'dataDate', 10)
WHERE "dataDate" IS NULL;
