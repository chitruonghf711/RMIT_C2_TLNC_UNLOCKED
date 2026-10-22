import { NextRequest } from "next/server";
import { resolveActor, handleApiError, AuthError } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const db = getDb();

    const run = db
      .prepare("SELECT * FROM preparation_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!run) {
      return Response.json(
        { error: "AI preparation run not found." },
        { status: 404 }
      );
    }

    const caseRow = db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(String(run.case_id)) as Record<string, unknown> | undefined;
    if (
      !caseRow ||
      actor.role !== "referring_clinician" ||
      String(caseRow.organization_id) !== actor.organizationId
    ) {
      throw new AuthError(403, "Not authorized to view this AI preparation run.");
    }

    return Response.json({
      ...run,
      output: JSON.parse(String(run.output_json || "{}")),
      validation_errors: JSON.parse(
        String(run.validation_errors_json || "[]")
      ),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
