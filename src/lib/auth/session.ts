import { NextRequest } from "next/server";
import {
  SignJWT,
  importJWK,
  generateKeyPair,
  exportJWK,
  calculateJwkThumbprint,
  type JWK,
} from "jose";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { verifyTideJWT, extractToken } from "./tideJWT";
import { verifyDpop } from "./verifyDpop";
import { loadTideConfig } from "./tidecloakConfig";
import { getDb } from "../db";
import { ensureSeeded } from "../db/seed";
import type { UserRole } from "../types";

export class AuthError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export interface ActorContext {
  userId: string;
  tideSubject: string;
  organizationId: string;
  organizationName: string;
  displayName: string;
  role: UserRole;
  title: string;
  email: string;
  tideRoles: string[];
  hasProtectedNetworkRole: boolean;
  authSource: "tidecloak_live" | "demo_dpop";
}

interface DbUserRow {
  id: string;
  tide_subject: string;
  organization_id: string;
  organization_name: string;
  display_name: string;
  role: UserRole;
  title: string;
  email: string | null;
  tide_roles_json: string;
}

export function getUserByIdOrSubject(identifier: string): DbUserRow | null {
  ensureSeeded();
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT u.*, o.name as organization_name
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      WHERE u.id = ? OR u.tide_subject = ?
      LIMIT 1
    `
    )
    .get(identifier, identifier) as DbUserRow | undefined;
  return row ?? null;
}

export function listDemoPersonas(): ActorContext[] {
  ensureSeeded();
  const db = getDb();
  const rows = db
    .prepare(
      `
      SELECT u.*, o.name as organization_name
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      ORDER BY
        CASE u.role
          WHEN 'referring_clinician' THEN 1
          WHEN 'consulting_specialist' THEN 2
          WHEN 'coordinator' THEN 3
          WHEN 'network_admin' THEN 4
          ELSE 5
        END,
        u.id ASC
    `
    )
    .all() as unknown as DbUserRow[];

  // Demo switcher: exactly one persona per role.
  const SWITCHER_IDS = ["USR-REF-01", "USR-SPEC-01"];
  return rows.filter((r) => SWITCHER_IDS.includes(r.id)).map((row) => {
    const tideRoles: string[] = JSON.parse(row.tide_roles_json || "[]");
    return {
      userId: row.id,
      tideSubject: row.tide_subject,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      displayName: row.display_name,
      role: row.role,
      title: row.title,
      email: row.email || "",
      tideRoles,
      hasProtectedNetworkRole: tideRoles.includes("network_consultant"),
      authSource: "demo_dpop",
    };
  });
}

export async function resolveActor(req: NextRequest): Promise<ActorContext> {
  ensureSeeded();
  const authHeader = req.headers.get("authorization");
  if (!authHeader) {
    throw new AuthError(
      401,
      "Missing authentication credentials (Authorization DPoP header).",
      "MISSING_AUTH"
    );
  }

  let token: string;
  let jwtPayload: Awaited<ReturnType<typeof verifyTideJWT>>;
  try {
    token = extractToken(authHeader);
    jwtPayload = await verifyTideJWT(token);
    await verifyDpop(req, token, jwtPayload as { cnf?: { jkt?: string } });
  } catch (err) {
    throw new AuthError(
      401,
      err instanceof Error ? err.message : "Invalid access token or DPoP proof.",
      "INVALID_TOKEN_OR_DPOP"
    );
  }

  const candidateId =
    (jwtPayload.sub as string | undefined) ||
    (jwtPayload.preferred_username as string | undefined) ||
    (jwtPayload.vuid as string | undefined);

  if (!candidateId) {
    throw new AuthError(
      401,
      "Access token does not contain a valid user subject.",
      "MISSING_SUBJECT"
    );
  }

  let row =
    getUserByIdOrSubject(candidateId) ||
    (jwtPayload.preferred_username
      ? getUserByIdOrSubject(String(jwtPayload.preferred_username))
      : null);

  if (!row) {
    const tokenRoles: string[] =
      ((jwtPayload.realm_access as { roles?: string[] } | undefined)?.roles ??
        []);
    if (
      tokenRoles.includes("network_admin") ||
      tokenRoles.includes("tide-realm-admin")
    ) {
      row = getUserByIdOrSubject("USR-ADMIN-01");
    } else if (tokenRoles.includes("coordinator")) {
      row = getUserByIdOrSubject("USR-COORD-01");
    } else if (tokenRoles.includes("consulting_specialist")) {
      row = getUserByIdOrSubject("USR-SPEC-01");
    } else {
      row = getUserByIdOrSubject("USR-REF-01");
    }
  }

  if (!row) {
    throw new AuthError(
      401,
      "User profile not found in the CaseBridge network.",
      "USER_NOT_FOUND"
    );
  }

  const dbRoles: string[] = JSON.parse(row.tide_roles_json || "[]");
  const jwtRoles: string[] =
    ((jwtPayload.realm_access as { roles?: string[] } | undefined)?.roles ??
      dbRoles);

  const effectiveRoles = dbRoles.filter((r) => jwtRoles.includes(r));

  return {
    userId: row.id,
    tideSubject: row.tide_subject,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    displayName: row.display_name,
    role: row.role,
    title: row.title,
    email: row.email || "",
    tideRoles: effectiveRoles,
    hasProtectedNetworkRole: effectiveRoles.includes("network_consultant"),
    authSource: jwtPayload.demo_persona ? "demo_dpop" : "tidecloak_live",
  };
}

export function requireRoles(
  actor: ActorContext,
  allowedRoles: UserRole[],
  customMessage?: string
): void {
  if (!allowedRoles.includes(actor.role)) {
    throw new AuthError(
      403,
      customMessage ||
        `Role '${actor.role}' is not authorized to perform this action. Required: ${allowedRoles.join(", ")}.`,
      "FORBIDDEN_ROLE"
    );
  }
}

export function handleApiError(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json(
      { error: err.message, code: err.code },
      { status: err.status }
    );
  }
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    const status = (err as { status: number }).status;
    const code =
      "code" in err && typeof (err as { code: unknown }).code === "string"
        ? (err as { code: string }).code
        : "DOMAIN_ERROR";
    const message =
      err instanceof Error ? err.message : "Request processing error.";
    const extra =
      "details" in err ? { details: (err as { details: unknown }).details } : {};
    return Response.json({ error: message, code, ...extra }, { status });
  }
  console.error("[CaseBridge API Error]", err);
  return Response.json(
    {
      error: err instanceof Error ? err.message : "Internal server error.",
      code: "INTERNAL_ERROR",
    },
    { status: 500 }
  );
}

let _demoPrivateKey: CryptoKey | null = null;
let _demoKid = "casebridge-demo-ed25519-01";

async function getDemoSigningKey(): Promise<{ key: CryptoKey; kid: string }> {
  if (_demoPrivateKey) {
    return { key: _demoPrivateKey, kid: _demoKid };
  }
  const keyFile = join(process.cwd(), "data", "demo-signing-key.json");
  if (!existsSync(keyFile)) {
    throw new Error(
      "Missing data/demo-signing-key.json. Run bootstrap/seed first."
    );
  }
  const parsed = JSON.parse(readFileSync(keyFile, "utf-8")) as {
    privateJwk: JWK;
  };
  _demoKid = parsed.privateJwk.kid || "casebridge-demo-ed25519-01";
  _demoPrivateKey = (await importJWK(parsed.privateJwk, "EdDSA")) as CryptoKey;
  return { key: _demoPrivateKey, kid: _demoKid };
}

export async function mintDemoActorToken(
  userId: string,
  dpopJkt: string
): Promise<{ token: string; actor: ActorContext }> {
  const row = getUserByIdOrSubject(userId);
  if (!row) {
    throw new AuthError(404, `Demo persona not found: ${userId}`);
  }
  const config = loadTideConfig();
  const { key, kid } = await getDemoSigningKey();
  const tideRoles: string[] = JSON.parse(row.tide_roles_json || "[]");
  const now = Math.floor(Date.now() / 1000);
  const issuer = `${config["auth-server-url"].replace(/\/+$/, "")}/realms/${config.realm}`;

  const token = await new SignJWT({
    sub: row.id,
    preferred_username: row.tide_subject,
    vuid: row.tide_subject,
    azp: config.resource,
    realm_access: { roles: tideRoles },
    cnf: { jkt: dpopJkt },
    demo_persona: true,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
    .setIssuer(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const actor: ActorContext = {
    userId: row.id,
    tideSubject: row.tide_subject,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    displayName: row.display_name,
    role: row.role,
    title: row.title,
    email: row.email || "",
    tideRoles,
    hasProtectedNetworkRole: tideRoles.includes("network_consultant"),
    authSource: "demo_dpop",
  };

  return { token, actor };
}

export async function createSignedDpopRequest(
  userId: string,
  method: string,
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<NextRequest> {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk, "sha256");
  const { token } = await mintDemoActorToken(userId, jkt);

  const parsedUrl = new URL(url);
  const htu = `${parsedUrl.origin}${parsedUrl.pathname}`;
  const ath = createHash("sha256").update(token).digest("base64url");
  const now = Math.floor(Date.now() / 1000);

  const proof = await new SignJWT({
    htm: method.toUpperCase(),
    htu,
    iat: now,
    jti: randomUUID(),
    ath,
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: publicJwk,
    })
    .sign(privateKey);

  const headers = new Headers(extraHeaders || {});
  headers.set("Authorization", `DPoP ${token}`);
  headers.set("DPoP", proof);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return new NextRequest(url, {
    method: method.toUpperCase(),
    headers,
    body:
      body !== undefined
        ? typeof body === "string"
          ? body
          : JSON.stringify(body)
        : undefined,
  });
}
