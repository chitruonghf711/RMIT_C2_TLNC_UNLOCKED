import { NextRequest } from "next/server";
import { resolveActor, handleApiError, AuthError } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ensureSeeded } from "@/lib/db/seed";
import { readPrivateDocumentFile } from "@/lib/documents";

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    ensureSeeded();
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const db = getDb();

    const doc = db
      .prepare("SELECT * FROM document_versions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!doc) {
      return Response.json(
        { error: "Document not found." },
        { status: 404 }
      );
    }

    const caseId = String(doc.case_id);
    const caseRow = db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(caseId) as Record<string, unknown> | undefined;
    if (!caseRow) {
      return Response.json(
        { error: "Case record not found." },
        { status: 404 }
      );
    }

    // Strict object-level authorization for private document download (Section 9, Section 11, A10)
    if (actor.role === "referring_clinician") {
      if (String(caseRow.organization_id) !== actor.organizationId) {
        throw new AuthError(
          403,
          "You are not authorized to download clinical documents from another organization (A10)."
        );
      }
    } else if (actor.role === "consulting_specialist") {
      const acceptedCon = db
        .prepare(
          "SELECT id FROM consultations WHERE case_id = ? AND specialist_id = ? LIMIT 1"
        )
        .get(caseId, actor.userId);
      if (!acceptedCon || !actor.hasProtectedNetworkRole) {
        throw new AuthError(
          403,
          "Specialists may only download source documents after accepting a consultation invitation with an active role (A10)."
        );
      }
    } else {
      throw new AuthError(
        403,
        "Coordinators and network administrators are not permitted to access clinical document contents (A10)."
      );
    }

    let rawContent = String(doc.extracted_text || "");
    try {
      rawContent = readPrivateDocumentFile(String(doc.storage_path));
    } catch {
      // Fallback to extracted_text if file was regenerated
    }

    return Response.json({
      id: doc.id,
      case_id: doc.case_id,
      version: doc.version,
      filename: doc.filename,
      doc_type: doc.doc_type,
      content: rawContent,
      segments: JSON.parse(String(doc.segments_json || "[]")),
      created_at: doc.created_at,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
