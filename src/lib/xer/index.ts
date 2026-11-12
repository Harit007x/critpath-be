import { readFile } from "fs/promises";
import path from "path";
import { HttpError } from "../../utils/http";
import { checkSchedule, type CheckReport } from "./checks";
import { decodeXer, parseXer } from "./parse";

export type XerCheckResponse = CheckReport & {
  file: { name: string; sizeBytes: number; sample: string | null };
};

/** Parses and checks one XER file. Throws 422 when the file cannot be read as XER at all. */
export function checkXer(bytes: Buffer, fileName: string, sample: string | null = null): XerCheckResponse {
  const parsed = parseXer(decodeXer(bytes));
  if (parsed.fatal.length > 0) {
    throw new HttpError(422, parsed.fatal.join(" "), "NOT_AN_XER");
  }
  return { file: { name: fileName, sizeBytes: bytes.length, sample }, ...checkSchedule(parsed) };
}

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

export async function checkSample(id: string): Promise<XerCheckResponse> {
  const sample = SAMPLES.find(s => s.id === id);
  if (!sample) throw new HttpError(404, "Sample not found", "NOT_FOUND");
  const bytes = await readFile(path.join(SAMPLES_DIR, sample.fileName));
  return checkXer(bytes, sample.fileName, sample.id);
}
