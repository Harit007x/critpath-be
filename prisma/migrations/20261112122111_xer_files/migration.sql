-- CreateTable
CREATE TABLE "xer_file" (
    "id" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "p6Version" TEXT,
    "exportDate" TEXT,
    "projectName" TEXT,
    "activities" INTEGER NOT NULL,
    "relationships" INTEGER NOT NULL,
    "brokenRowCount" INTEGER NOT NULL,
    "missingLinks" INTEGER NOT NULL,
    "negativeFloat" INTEGER NOT NULL,
    "highFloat" INTEGER NOT NULL,
    "report" JSONB NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "xer_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "xer_table" (
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fields" TEXT[],
    "rowCount" INTEGER NOT NULL,

    CONSTRAINT "xer_table_pkey" PRIMARY KEY ("fileId","name")
);

-- CreateTable
CREATE TABLE "xer_row" (
    "fileId" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "line" INTEGER NOT NULL,
    "values" JSONB NOT NULL,

    CONSTRAINT "xer_row_pkey" PRIMARY KEY ("fileId","table","rowNumber")
);

-- CreateTable
CREATE TABLE "xer_broken_row" (
    "id" SERIAL NOT NULL,
    "fileId" TEXT NOT NULL,
    "table" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "rowNumber" INTEGER,
    "kind" TEXT NOT NULL,
    "field" TEXT,
    "reason" TEXT NOT NULL,

    CONSTRAINT "xer_broken_row_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "xer_file_sha256_key" ON "xer_file"("sha256");

-- CreateIndex
CREATE INDEX "xer_file_uploadedAt_idx" ON "xer_file"("uploadedAt");

-- CreateIndex
CREATE INDEX "xer_broken_row_fileId_line_idx" ON "xer_broken_row"("fileId", "line");

-- AddForeignKey
ALTER TABLE "xer_table" ADD CONSTRAINT "xer_table_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "xer_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xer_row" ADD CONSTRAINT "xer_row_fileId_table_fkey" FOREIGN KEY ("fileId", "table") REFERENCES "xer_table"("fileId", "name") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "xer_broken_row" ADD CONSTRAINT "xer_broken_row_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "xer_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
