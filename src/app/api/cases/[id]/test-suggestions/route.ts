import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { generateTestSuggestions } from "@/lib/ai/service";
import { addClinicianCustomTest } from "@/lib/workflow";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json().catch(() => ({}));

    if (body.action === "add_custom") {
      const added = addClinicianCustomTest(id, actor, {
        catalog_test_id: body.catalog_test_id,
        target_question: body.target_question,
        rationale: body.rationale,
      });
      return Response.json(added, { status: 201 });
    }

    const result = generateTestSuggestions(id, actor, {
      customRawSuggestions: body.customRawSuggestions,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
