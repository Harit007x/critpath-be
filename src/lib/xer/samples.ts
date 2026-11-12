/**
 * The two public sample schedules in `critpath-be/samples`. They are read from disk on every
 * check; `pnpm db:seed` also stores them once, so the assistant can answer about them.
 */
import { readFile } from "fs/promises";
import path from "path";
import { HttpError } from "../../utils/http";
import { checkXer, type XerCheckResponse } from "./index";
import { findStored } from "./store";

/** `critpath-be/samples`, from both `src/lib/xer` and the compiled `dist/lib/xer`. */
const SAMPLES_DIR = path.resolve(__dirname, "../../../samples");

export const SAMPLES = [
  {
    id: "events-example",
    fileName: "events-example.xer",
    title: "EventsExample2002",
    description: "83 activities with logic, 12 calendars",
    source: "https://github.com/aspose-tasks-cloud/Aspose.Tasks-Cloud-SDK-for-Python",
  },
  {
    id: "groupdocs-sample",
    fileName: "groupdocs-sample.xer",
    title: "GroupDocs sample",
    description: "70 activities, no relationships",
    source: "https://github.com/groupdocs-conversion/GroupDocs.Conversion-for-.NET",
  },
] as const;

export type Sample = (typeof SAMPLES)[number];

export async function readSample(id: string): Promise<{ sample: Sample; bytes: Buffer }> {
  const sample = SAMPLES.find(s => s.id === id);
  if (!sample) throw new HttpError(404, "Sample not found", "NOT_FOUND");
  return { sample, bytes: await readFile(path.join(SAMPLES_DIR, sample.fileName)) };
}

/**
 * Checks a sample from disk. When the same file is stored (seeded or uploaded), the response
 * carries that copy's id, so the page can offer the assistant for it. Nothing is written.
 */
export async function checkSample(id: string): Promise<XerCheckResponse> {
  const { sample, bytes } = await readSample(id);
  const report = checkXer(bytes, sample.fileName, sample.id);
  const stored = await findStored(bytes).catch(() => null);
  if (!stored) return report;
  return {
    ...report,
    file: { ...report.file, id: stored.id, uploadedAt: stored.uploadedAt.toISOString() },
  };
}
