/**
 * The dashboard's dataset (dataset.ts) for a stored upload or a bundled sample. Building one reads
 * and checks the whole file (most of a second for 16,000 activities), and a file never changes, so
 * the last few are kept in memory.
 */
import { readXer } from "./index";
import { scheduleDataset, type ScheduleDataset } from "./dataset";
import { readSample } from "./samples";
import { getUploadContent } from "./store";

const KEEP = 4;
const cache = new Map<string, ScheduleDataset>();

async function cached(key: string, load: () => Promise<Buffer>): Promise<ScheduleDataset> {
  const hit = cache.get(key);
  if (hit) {
    // Most recently used last, so the first key is the one to drop.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const dataset = scheduleDataset(readXer(await load()));
  cache.set(key, dataset);
  if (cache.size > KEEP) cache.delete(cache.keys().next().value!);
  return dataset;
}

export const uploadDataset = (fileId: string) =>
  cached(`file:${fileId}`, async () => (await getUploadContent(fileId)).content);

export const sampleDataset = (sampleId: string) =>
  cached(`sample:${sampleId}`, async () => (await readSample(sampleId)).bytes);
