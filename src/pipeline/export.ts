import fs from "node:fs";
import path from "node:path";
import { DATASET_NAME } from "./constants";
import { DATASET_DIR, ROOT, RUNS_DIR } from "./paths";
import { removeAntiPromptSession } from "./antiprompt";
import { deliveryRecordSchema, metaRecordSchema, serializeMetaRecord, type MetaRecord } from "./schema";
import { validateMetaRecord } from "./conformance";

let catalogChain = Promise.resolve();

/** Serialize dataset jsonl + anti-prompt writes across parallel exports. */
export function withCatalogLock<T>(fn: () => T): Promise<T> {
  const run = catalogChain.then(fn);
  catalogChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function ensureDatasetLayout(): void {
  for (const p of [
    path.join(DATASET_DIR, "image", "agent_generated"),
    path.join(DATASET_DIR, "image", "user_generated"),
    path.join(DATASET_DIR, "image", "edited"),
    path.join(DATASET_DIR, "video", "agent_generated"),
    path.join(DATASET_DIR, "video", "user_generated"),
    path.join(DATASET_DIR, "video", "edited"),
    path.join(DATASET_DIR, "audio", "generated"),
    path.join(DATASET_DIR, "audio", "agent_generated"),
    path.join(DATASET_DIR, "reference", "input_images"),
    path.join(DATASET_DIR, "reference", "masks"),
    path.join(DATASET_DIR, "meta", "scripts"),
  ]) {
    fs.mkdirSync(p, { recursive: true });
  }
}

export function copyIntoDataset(absSource: string, relDest: string): string {
  ensureDatasetLayout();
  const dest = path.join(DATASET_DIR, relDest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(absSource, dest);
  return relDest.split(path.sep).join("/");
}

export const META_SCHEMA_REL = "meta/aigc-meta.schema.json";

export function installMetaSchema(): void {
  ensureDatasetLayout();
  const src = path.join(ROOT, "config", "aigc-meta.schema.json");
  if (!fs.existsSync(src)) return;
  fs.copyFileSync(src, path.join(DATASET_DIR, META_SCHEMA_REL));
}

export function writeSessionDeliveryJson(sessionId: string, records: MetaRecord[]): string {
  installMetaSchema();
  const doc = {
    $schema: "./aigc-meta.schema.json",
    dataset_name: DATASET_NAME,
    session_id: sessionId,
    records: records.map(serializeMetaRecord),
  };
  const rel = `meta/${sessionId}.json`;
  fs.writeFileSync(path.join(DATASET_DIR, rel), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
  return rel;
}

export function writeScriptSidecar(sessionId: string, script: unknown): string {
  ensureDatasetLayout();
  const rel = `meta/scripts/${sessionId}.json`;
  fs.writeFileSync(path.join(DATASET_DIR, rel), JSON.stringify(script, null, 2), "utf8");
  return rel;
}

export function appendMetaJsonl(records: MetaRecord[]): { ok: boolean; errors: string[] } {
  ensureDatasetLayout();
  const errors: string[] = [];
  const lines: string[] = [];
  for (const rec of records) {
    const parsed = deliveryRecordSchema.safeParse(rec);
    if (!parsed.success) {
      errors.push(`${rec.uniq_id}: ${parsed.error.message}`);
      continue;
    }
    const report = validateMetaRecord(parsed.data);
    if (!report.pass) {
      errors.push(`${rec.uniq_id}: ${report.checks.filter((c) => !c.pass).map((c) => c.detail).join("; ")}`);
      continue;
    }
    lines.push(JSON.stringify(serializeMetaRecord(parsed.data)));
  }
  if (errors.length) return { ok: false, errors };
  const file = path.join(DATASET_DIR, "meta", "meta.jsonl");
  const sessionIds = new Set(records.map((r) => r.session_id).filter((id): id is string => Boolean(id)));
  if (fs.existsSync(file) && sessionIds.size) {
    rewriteJsonl(file, (row) => !sessionIds.has(String(row.session_id ?? "")));
  }
  fs.appendFileSync(file, lines.map((l) => l + "\n").join(""), "utf8");
  return { ok: true, errors: [] };
}

export function readMetaJsonl(): MetaRecord[] {
  const file = path.join(DATASET_DIR, "meta", "meta.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => metaRecordSchema.parse(JSON.parse(line)));
}

export function writeDatasetInfo(extra: Record<string, unknown> = {}): void {
  ensureDatasetLayout();
  const records = fs.existsSync(path.join(DATASET_DIR, "meta", "meta.jsonl"))
    ? fs.readFileSync(path.join(DATASET_DIR, "meta", "meta.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).length
    : 0;
  const info = {
    dataset_name: DATASET_NAME,
    source_platform: "Internal Pipeline",
    generated_at: new Date().toISOString(),
    meta_records: records,
    ...extra,
  };
  fs.writeFileSync(path.join(DATASET_DIR, "dataset_info.json"), JSON.stringify(info, null, 2), "utf8");
}

function datasetAbs(rel: string): string | null {
  if (!rel) return null;
  const root = path.resolve(DATASET_DIR);
  const abs = path.resolve(DATASET_DIR, rel);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  return abs;
}

function rewriteJsonl(file: string, keepLine: (obj: Record<string, unknown>) => boolean): void {
  if (!fs.existsSync(file)) return;
  const kept = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      try {
        return keepLine(JSON.parse(line) as Record<string, unknown>);
      } catch {
        return true;
      }
    });
  fs.writeFileSync(file, kept.length ? kept.map((l) => l + "\n").join("") : "", "utf8");
}

/** Drop a session's counted files and jsonl rows so PoC volume stays honest. */
export function purgeSessionFromDataset(sessionId: string): void {
  ensureDatasetLayout();
  const records = readMetaJsonl().filter((r) => r.session_id === sessionId);
  for (const rec of records) {
    const rels = [
      rec.media_path,
      rec.audio_path,
      rec.origin_media_path,
      rec.mask_path,
      ...(rec.reference_images ?? []),
    ].filter((p): p is string => Boolean(p));
    for (const rel of rels) {
      const abs = datasetAbs(rel);
      if (abs && fs.existsSync(abs)) fs.rmSync(abs, { force: true });
    }
  }
  const pretty = path.join(DATASET_DIR, "meta", `${sessionId}.json`);
  if (fs.existsSync(pretty)) fs.rmSync(pretty, { force: true });
  rewriteJsonl(path.join(DATASET_DIR, "meta", "meta.jsonl"), (row) => row.session_id !== sessionId);
  removeAntiPromptSession(sessionId);
  writeDatasetInfo();
}

export function listDatasetMedia(): Array<{ rel: string; abs: string }> {
  ensureDatasetLayout();
  const out: Array<{ rel: string; abs: string }> = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs);
      else out.push({ rel: path.relative(DATASET_DIR, abs).split(path.sep).join("/"), abs });
    }
  }
  walk(DATASET_DIR);
  return out;
}
