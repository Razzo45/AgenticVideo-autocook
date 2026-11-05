import { ok } from "@/src/api";
import { loadAntiPrompts } from "@/src/pipeline/antiprompt";

export async function GET() {
  return ok({ records: loadAntiPrompts() });
}
