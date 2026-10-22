import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { listSpecialistInboxInvitations } from "@/lib/workflow";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const result = listSpecialistInboxInvitations(actor);
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
