import { getRun, type RunRow } from "../db";
import type { AuthUser } from "./types";

export async function assertRunOwner(runId: string, user: AuthUser): Promise<RunRow> {
  const run = await getRun(runId);
  if (!run) {
    const err = new Error("not found");
    (err as Error & { status: number }).status = 404;
    throw err;
  }
  if (run.user_id !== user.userId) {
    const err = new Error("forbidden");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
  return run;
}

export function isOwnerError(err: unknown): err is Error & { status: number } {
  if (!(err instanceof Error)) return false;
  const status = (err as unknown as { status?: number }).status;
  return status === 403 || status === 404;
}
