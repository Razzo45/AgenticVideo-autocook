import { getDb } from "../src/db";
import { deliveryFpsFromPrompt } from "../src/pipeline/constants";

const ids = process.argv.slice(2);
const db = getDb();
for (const id of ids) {
  const r = db.prepare("SELECT status, initial_prompt FROM runs WHERE id = ?").get(id) as
    | { status: string; initial_prompt: string }
    | undefined;
  console.log(id, r?.status, "->", deliveryFpsFromPrompt(r?.initial_prompt));
}
