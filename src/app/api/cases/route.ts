import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import { listWorkspaceCases, createCase } from "@/lib/workflow";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const data = listWorkspaceCases(actor);
    return Response.json(data);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const body = await req.json();
    const created = createCase(actor, body);
    return Response.json(created, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
