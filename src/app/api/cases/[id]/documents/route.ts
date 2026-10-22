import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { addDocumentToCase } from "@/lib/workflow";
import { DocumentParseError } from "@/lib/documents";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const actor = await resolveActor(req);
    const { id } = await context.params;
    const body = await req.json();
    const doc = addDocumentToCase(id, actor, {
      filename: body.filename || "clinical_document.txt",
      doc_type: body.doc_type || "CLINICAL_NOTE",
      content: body.content || "",
      mime_type: body.mime_type || "text/plain",
    });
    return Response.json(doc, { status: 201 });
  } catch (err) {
    if (err instanceof DocumentParseError) {
      return Response.json(
        { error: err.message, code: err.code },
        { status: 422 }
      );
    }
    return handleApiError(err);
  }
}
