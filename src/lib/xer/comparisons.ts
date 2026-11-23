/**
 * Compares two stored uploads (compare.ts). Reading a file into a snapshot parses and checks it,
 * which takes seconds for a large schedule, and a stored file never changes, so the last few
 * snapshots are kept in memory: comparing R03 with R04, then R04 with R05, reads R04 once.
 */
import { prisma } from "../../utils/db";
import { HttpError, notFound } from "../../utils/http";
import { compareSnapshots, snapshotOf, type ScheduleComparison, type ScheduleSnapshot } from "./compare";
import { readXer } from "./index";

const KEEP = 4;
const cache = new Map<string, ScheduleSnapshot>();

type StoredFile = { id: string; name: string; uploadedAt: string; snapshot: ScheduleSnapshot };

async function stored(id: string): Promise<StoredFile> {
  const hit = cache.get(id);
  const file = await prisma.xerFile.findUnique({
    where: { id },
    select: { id: true, fileName: true, uploadedAt: true, content: !hit },
  });
  if (!file) throw notFound("Upload");
  let snapshot = hit;
  if (snapshot) {
    // Most recently used last, so the first key is the one to drop.
    cache.delete(id);
  } else {
    snapshot = snapshotOf(readXer(Buffer.from(file.content!)));
  }
  cache.set(id, snapshot);
  if (cache.size > KEEP) cache.delete(cache.keys().next().value!);
  return { id: file.id, name: file.fileName, uploadedAt: file.uploadedAt.toISOString(), snapshot };
}

/** Compares the earlier upload `fromId` with the later one `toId`. 404 when either is missing. */
export async function compareUploads(fromId: string, toId: string): Promise<ScheduleComparison> {
  if (fromId === toId) throw new HttpError(400, "Choose two different files to compare", "SAME_FILE");
  // One after the other, so only one file is parsed at a time.
  const a = await stored(fromId);
  const b = await stored(toId);
  return compareSnapshots(a.snapshot, b.snapshot, {
    from: { id: a.id, name: a.name, uploadedAt: a.uploadedAt },
    to: { id: b.id, name: b.name, uploadedAt: b.uploadedAt },
  });
}
