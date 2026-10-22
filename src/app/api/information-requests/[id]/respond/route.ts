import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { respondToInformationRequest } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const result = respondToInformationRequest(id, actor, {
      response_text: body.response_text,
      additional_document: body.additional_document,
    });
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
