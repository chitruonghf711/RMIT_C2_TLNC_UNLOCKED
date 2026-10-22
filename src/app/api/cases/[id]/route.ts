import { NextRequest } from "next/server";
import {
  resolveActor,
  requireRoles,
  handleApiError,
  AuthError,
} from "@/lib/auth/session";
import { getCaseDetail, addClinicianCustomTest } from "@/lib/workflow";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const detail = getCaseDetail(id, actor);
    return Response.json(detail);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    requireRoles(actor, ["referring_clinician"]);
    const { id } = await context.params;
    const body = await req.json();

    if (body.action === "add_clinician_test") {
      const added = addClinicianCustomTest(id, actor, {
        catalog_test_id: body.catalog_test_id,
        target_question: body.target_question,
        rationale: body.rationale,
      });
      return Response.json(added);
    }

    const db = getDb();
    const row = db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) {
      return Response.json(
        { error: "Không tìm thấy hồ sơ ca bệnh." },
        { status: 404 }
      );
    }
    if (String(row.organization_id) !== actor.organizationId) {
      throw new AuthError(403, "Không có quyền cập nhật ca bệnh của cơ sở khác.");
    }

    const now = new Date().toISOString();
    const nextTitle =
      body.title !== undefined ? String(body.title).trim() : String(row.title);
    const nextQuestion =
      body.clinical_question !== undefined
        ? String(body.clinical_question).trim()
        : String(row.clinical_question);
    const nextSpecialty =
      body.specialty_requested !== undefined
        ? String(body.specialty_requested)
        : String(row.specialty_requested);

    db.prepare(
      `
      UPDATE cases
      SET title = ?,
          clinical_question = ?,
          specialty_requested = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(nextTitle, nextQuestion, nextSpecialty, now, id);

    return Response.json(getCaseDetail(id, actor));
  } catch (err) {
    return handleApiError(err);
  }
}
