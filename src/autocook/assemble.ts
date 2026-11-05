/**
 * Deterministic assemble — concat clips to a master. No HITL / DB.
 */
import fs from "node:fs";
import path from "node:path";
import { concatClips, probeFile } from "../pipeline/stitch";
import type { AssembleInput, AssembleResult } from "./types";

export async function assemble(input: AssembleInput): Promise<AssembleResult> {
  if (!input.clipPaths.length) throw new Error("assemble: no clips");
  for (const p of input.clipPaths) {
    if (!fs.existsSync(p)) throw new Error(`assemble: missing clip ${p}`);
  }
  fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
  input.onStatus?.(`Assembling ${input.clipPaths.length} clip(s)…`);
  await concatClips(input.clipPaths, input.outPath);
  const probe = await probeFile(input.outPath);
  return { masterPath: input.outPath, durationSec: probe.duration };
}
