import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { saveClinicalAssessment } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const result = saveClinicalAssessment(id, actor, body);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
