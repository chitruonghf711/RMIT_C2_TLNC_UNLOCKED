import { NextRequest } from "next/server";
import {
  resolveActor,
  requireRoles,
  handleApiError,
  AuthError,
} from "@/lib/auth/session";
import { computeMatchesForCase } from "@/lib/matching";
import { processExpiredInvitations } from "@/lib/workflow";
import { getDb } from "@/lib/db";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    requireRoles(actor, ["referring_clinician", "coordinator"]);
    processExpiredInvitations();

    const { id } = await context.params;
    const db = getDb();
    const caseRow = db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!caseRow) {
      return Response.json(
        { error: "Không tìm thấy hồ sơ ca bệnh." },
        { status: 404 }
      );
    }
    if (
      actor.role === "referring_clinician" &&
      String(caseRow.organization_id) !== actor.organizationId
    ) {
      throw new AuthError(403, "Không có quyền tìm chuyên gia cho ca bệnh của cơ sở khác.");
    }

    const result = computeMatchesForCase(id);
    return Response.json(result);
  } catch (err) {
    return handleApiError(err);
  }
}
