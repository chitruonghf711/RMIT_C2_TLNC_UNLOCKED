import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { prepareCase } from "@/lib/ai/service";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));
    const result = prepareCase(id, actor, {
      mode: body.mode || "fixture",
      customOutputOverride: body.customOutputOverride,
    });
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
