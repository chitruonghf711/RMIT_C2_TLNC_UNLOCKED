import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { sendCaseInvitation } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const result = sendCaseInvitation(id, actor, {
      specialist_id: body.specialist_id,
      fallback_enabled: Boolean(body.fallback_enabled),
      fallback_specialist_ids: body.fallback_specialist_ids || [],
      expires_in_seconds: body.expires_in_seconds,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
