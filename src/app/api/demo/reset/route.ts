import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { ensureSeeded } from "@/lib/db/seed";

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    ensureSeeded(true);
    return Response.json({
      reset: true,
      actor_id: actor.userId,
      message:
        "Restored baseline demo dataset (Case A, Case B, Case C). Pending QEA role changes were not bypassed.",
      reset_at: new Date().toISOString(),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
