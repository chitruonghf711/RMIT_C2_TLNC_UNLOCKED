import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { createMockOrdersFromPlan } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const result = createMockOrdersFromPlan(id, actor, {
      idempotency_key: body.idempotency_key,
    });
    return Response.json(result, {
      status: result.idempotent_replay ? 200 : 201,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
