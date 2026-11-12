// Stores the two bundled samples, so the assistant can answer about them: `pnpm db:seed`.
// Safe to run again: a file already stored (same SHA-256) is left as it is.
import "dotenv-flow/config";
import { SAMPLES, readSample } from "./lib/xer/samples";
import { saveUpload } from "./lib/xer/store";
import { prisma } from "./utils/db";

const main = async () => {
  for (const { id } of SAMPLES) {
    const { sample, bytes } = await readSample(id);
    const stored = await saveUpload(bytes, sample.fileName);
    console.log(`${sample.fileName}: stored as ${stored.file.id}`);
  }
};

main()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
