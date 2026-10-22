import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { submitConsultationResponse } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const result = submitConsultationResponse(id, actor, {
      question_answers: body.question_answers || [],
      clinical_recommendations: body.clinical_recommendations || "",
      limitations: body.limitations || "",
      is_demo_sample: Boolean(body.is_demo_sample),
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
