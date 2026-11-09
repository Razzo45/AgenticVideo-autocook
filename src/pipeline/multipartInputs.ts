/**
 * Multipart `inputs` land on disk and are passed by path.
 * The cook route must not hold the package in RAM, and must not depend on
 * the middleware body clone (that clone stops at 10 MB unless raised).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { RunInputFile } from "./inputs";

export type MultipartInputs = {
  files: RunInputFile[];
  cleanup: () => void;
};

export async function takeMultipartInputs(form: FormData): Promise<MultipartInputs> {
  const uploads = form
    .getAll("inputs")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (!uploads.length) return { files: [], cleanup: () => undefined };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autocook-in-"));
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const files: RunInputFile[] = [];
  try {
    for (const file of uploads) {
      const name = path.basename(file.name || "input.bin").replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120) || "input.bin";
      const dest = path.join(dir, `${files.length}_${name}`);
      const webStream = file.stream() as unknown as import("node:stream/web").ReadableStream;
      await pipeline(Readable.fromWeb(webStream), fs.createWriteStream(dest));
      files.push({ originalName: file.name || name, sourcePath: dest });
    }
    return { files, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}
