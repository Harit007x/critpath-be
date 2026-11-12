/**
 * Uploaded XER files in Postgres: the file as uploaded, every parsed table and row, the broken
 * rows and the check report (prisma/schema.prisma, "Schedule checker").
 *
 * The report is stored as it was computed at upload, so reopening a file shows the same result and
 * needs no parsing. The same bytes uploaded again reopen the stored file instead of adding a copy.
 */
import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../utils/db";
import { notFound } from "../../utils/http";
import { checkSchedule, type CheckId, type CheckReport } from "./checks";
import { readXer, type XerCheckResponse, type XerUploadResponse } from "./index";
import type { BrokenRow, ParsedXer } from "./parse";

/** Rows per INSERT: well under Postgres's 65,535 bind parameters at 5 columns a row. */
const ROW_BATCH = 2000;
/** A 25 MB file can hold a few hundred thousand rows; give the transaction time to write them. */
const SAVE_TIMEOUT_MS = 120_000;

export type StoredXerSummary = {
  id: string;
  fileName: string;
  sizeBytes: number;
  projectName: string | null;
  activities: number;
  relationships: number;
  brokenRowCount: number;
  missingLinks: number;
  negativeFloat: number;
  highFloat: number;
  uploadedAt: Date;
};

const summarySelect = {
  id: true,
  fileName: true,
  sizeBytes: true,
  projectName: true,
  activities: true,
  relationships: true,
  brokenRowCount: true,
  missingLinks: true,
  negativeFloat: true,
  highFloat: true,
  uploadedAt: true,
} satisfies Prisma.XerFileSelect;

export const sha256Of = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** The parsed tables as `xer_table` and `xer_row` records (no file id yet). Pure, for tests. */
export function tableRecords(parsed: ParsedXer) {
  const tables = [...parsed.tables.values()].map(table => ({
    name: table.name,
    fields: table.fields,
    rowCount: table.rowCount,
  }));
  const rows = [...parsed.tables.values()].flatMap(table =>
    table.rows.map(row => ({
      table: table.name,
      rowNumber: row.rowNumber,
      line: row.line,
      values: row.values,
    }))
  );
  return { tables, rows };
}

const failing = (checks: CheckReport["checks"], id: CheckId) => checks.find(c => c.id === id)?.count ?? 0;

function projectNameOf(projects: CheckReport["projects"]): string | null {
  const project = projects[0];
  if (!project) return null;
  return project.name && project.name !== project.shortName
    ? `${project.shortName} · ${project.name}`
    : project.shortName || project.name || null;
}

/**
 * Parses, checks and stores an upload, and returns its report. A file that cannot be read as XER
 * at all (422) is not stored. The same bytes uploaded again return the stored copy, with
 * `alreadyStored` set so the client can say so.
 */
export async function saveUpload(bytes: Buffer, fileName: string): Promise<XerUploadResponse> {
  const sha256 = sha256Of(bytes);
  const stored = async (id: string, alreadyStored: boolean) => ({ ...(await getUpload(id)), alreadyStored });
  const existing = await prisma.xerFile.findUnique({ where: { sha256 }, select: { id: true } });
  if (existing) return stored(existing.id, true);

  const parsed = readXer(bytes);
  const { brokenRows, ...report } = checkSchedule(parsed);
  const { tables, rows } = tableRecords(parsed);

  try {
    const id = await prisma.$transaction(
      async tx => {
        const file = await tx.xerFile.create({
          data: {
            fileName,
            sizeBytes: bytes.length,
            sha256,
            content: bytes,
            p6Version: report.p6Version,
            exportDate: report.exportDate,
            projectName: projectNameOf(report.projects),
            activities: report.counts.activities,
            relationships: report.counts.relationships,
            brokenRowCount: brokenRows.length,
            missingLinks: failing(report.checks, "missing_links"),
            negativeFloat: failing(report.checks, "negative_float"),
            highFloat: failing(report.checks, "high_float"),
            report: report as unknown as Prisma.InputJsonObject,
            tables: { createMany: { data: tables } },
            brokenRows: { createMany: { data: brokenRows } },
          },
          select: { id: true },
        });
        for (let start = 0; start < rows.length; start += ROW_BATCH) {
          await tx.xerRow.createMany({
            data: rows.slice(start, start + ROW_BATCH).map(row => ({ ...row, fileId: file.id })),
          });
        }
        return file.id;
      },
      { timeout: SAVE_TIMEOUT_MS }
    );
    return stored(id, false);
  } catch (error) {
    // The same file uploaded twice at once: the other request stored it first.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const other = await prisma.xerFile.findUnique({ where: { sha256 }, select: { id: true } });
      if (other) return stored(other.id, true);
    }
    throw error;
  }
}

/** The stored copy of these exact bytes, if there is one. Reads only. */
export async function findStored(bytes: Buffer): Promise<{ id: string; uploadedAt: Date } | null> {
  return prisma.xerFile.findUnique({
    where: { sha256: sha256Of(bytes) },
    select: { id: true, uploadedAt: true },
  });
}

/** The most recent uploads, newest first. */
export function listUploads(limit = 50): Promise<StoredXerSummary[]> {
  return prisma.xerFile.findMany({
    select: summarySelect,
    orderBy: { uploadedAt: "desc" },
    take: limit,
  });
}

/** A stored upload's report, as it was when uploaded. 404 when there is no such upload. */
export async function getUpload(id: string): Promise<XerCheckResponse> {
  const file = await prisma.xerFile.findUnique({
    where: { id },
    select: {
      id: true,
      fileName: true,
      sizeBytes: true,
      uploadedAt: true,
      report: true,
      brokenRows: {
        select: { table: true, line: true, rowNumber: true, kind: true, field: true, reason: true },
        orderBy: [{ line: "asc" }, { id: "asc" }],
      },
    },
  });
  if (!file) throw notFound("Upload");
  return {
    file: {
      id: file.id,
      name: file.fileName,
      sizeBytes: file.sizeBytes,
      sample: null,
      uploadedAt: file.uploadedAt.toISOString(),
    },
    ...(file.report as unknown as Omit<CheckReport, "brokenRows">),
    brokenRows: file.brokenRows.map(row => ({ ...row, kind: row.kind as BrokenRow["kind"] })),
  };
}

/** The file exactly as it was uploaded. */
export async function getUploadContent(id: string): Promise<{ fileName: string; content: Buffer }> {
  const file = await prisma.xerFile.findUnique({ where: { id }, select: { fileName: true, content: true } });
  if (!file) throw notFound("Upload");
  return { fileName: file.fileName, content: Buffer.from(file.content) };
}
