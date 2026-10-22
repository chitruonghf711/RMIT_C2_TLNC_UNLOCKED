import { NextRequest } from "next/server";
import {
  resolveActor,
  listDemoPersonas,
  mintDemoActorToken,
  handleApiError,
} from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  try {
    const personas = listDemoPersonas();
    const authHeader = req.headers.get("authorization");
    if (!authHeader) {
      return Response.json({
        authenticated: false,
        actor: null,
        personas,
      });
    }
    const actor = await resolveActor(req);
    return Response.json({
      authenticated: true,
      actor,
      personas,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      user_id?: string;
      dpop_jkt?: string;
      userId?: string;
      dpopJkt?: string;
    };
    const userId = body.user_id || body.userId;
    const dpopJkt = body.dpop_jkt || body.dpopJkt;
    if (!userId || !dpopJkt) {
      return Response.json(
        {
          error:
            "user_id and dpop_jkt (the browser's DPoP key thumbprint) are required to issue a demo session token.",
        },
        { status: 400 }
      );
    }
    const result = await mintDemoActorToken(userId, dpopJkt);
    return Response.json({ ...result, personas: listDemoPersonas() });
  } catch (err) {
    return handleApiError(err);
  }
}
