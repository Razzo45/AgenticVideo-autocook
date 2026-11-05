import { ok } from "@/src/api";
import { pocStatus } from "@/src/pipeline/poc";

export async function GET() {
  return ok(pocStatus());
}
