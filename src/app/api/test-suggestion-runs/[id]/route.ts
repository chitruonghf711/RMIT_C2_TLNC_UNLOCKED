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
      .prepare("SELECT * FROM test_suggestion_runs WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!run) {
      return Response.json(
        { error: "Test suggestion run not found." },
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
      throw new AuthError(403, "Not authorized to view this test suggestion run.");
    }

    const suggestions = db
      .prepare("SELECT * FROM test_suggestions WHERE run_id = ?")
      .all(id);

    return Response.json({
      ...run,
      knowledge_versions: JSON.parse(
        String(run.knowledge_versions_json || "{}")
      ),
      suggestions,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
