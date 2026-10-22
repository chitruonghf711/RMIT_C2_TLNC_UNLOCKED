import { NextRequest } from "next/server";
import { resolveActor, handleApiError } from "@/lib/auth/session";
import {
  getGovernanceOverview,
  createGovernanceProposalLink,
} from "@/lib/governance";

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const data = await getGovernanceOverview(actor);
    return Response.json(data);
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveActor(req);
    const body = await req.json();
    const result = createGovernanceProposalLink(actor, {
      target_user_id: body.target_user_id,
      role_name: body.role_name,
      notes: body.notes,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}
