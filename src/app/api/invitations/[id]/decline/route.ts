import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { declineInvitation } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const result = declineInvitation(id, actor, { reason: body.reason });
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
