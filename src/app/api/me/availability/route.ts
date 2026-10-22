import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { updateSpecialistAvailability } from "@/lib/workflow";

export async function PATCH(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const body = await req.json();
    const result = updateSpecialistAvailability(actor, {
      availability_state: body.availability_state,
      expires_in_minutes: body.expires_in_minutes,
    });
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
