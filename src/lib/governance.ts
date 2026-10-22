import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "./db";
import { ensureSeeded } from "./db/seed";
import type { ActorContext } from "./auth/session";
import { requireRoles } from "./auth/session";

export interface GovernanceChangeItem {
  id: string;
  tide_change_request_id: string;
  target_user_id: string;
  target_user_name: string;
  target_user_title: string;
  target_organization_name: string;
  requested_action: string;
  role_name: string;
  status_source: string;
  last_observed_status: "PENDING" | "APPROVED" | "DENIED" | "CANCELLED";
  approvals_observed: number;
  threshold_observed: number;
  ready_to_commit: boolean;
  checked_at: string;
  notes: string;
}

export function calculateQuorumThreshold(activeAdminCount: number): number {
  if (activeAdminCount <= 0) return 1;
  return Math.max(1, Math.floor(0.7 * activeAdminCount));
}

async function fetchLiveTideChangeRequests(): Promise<{
  reachable: boolean;
  pending: Array<Record<string, unknown>>;
  error?: string;
}> {
  const tideUrl = (
    process.env.TIDECLOAK_URL || "http://localhost:8080"
  ).replace(/\/+$/, "");
  const realm = process.env.REALM_NAME || "casebridge";
  const adminUser = process.env.KC_BOOTSTRAP_ADMIN_USERNAME || "admin";
  const adminPassword = process.env.KC_BOOTSTRAP_ADMIN_PASSWORD;

  if (!adminPassword) {
    return {
      reachable: false,
      pending: [],
      error: "KC_BOOTSTRAP_ADMIN_PASSWORD not set in environment",
    };
  }

  try {
    const tokenRes = await fetch(
      `${tideUrl}/realms/master/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "admin-cli",
          grant_type: "password",
          username: adminUser,
          password: adminPassword,
        }),
        signal: AbortSignal.timeout(2500),
      }
    );

    if (!tokenRes.ok) {
      return {
        reachable: false,
        pending: [],
        error: `Master token HTTP ${tokenRes.status}`,
      };
    }

    const { access_token } = (await tokenRes.json()) as {
      access_token: string;
    };

    const crRes = await fetch(
      `${tideUrl}/admin/realms/${realm}/iga/change-requests?status=PENDING`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
        signal: AbortSignal.timeout(2500),
      }
    );

    if (!crRes.ok) {
      return {
        reachable: false,
        pending: [],
        error: `IGA change-requests HTTP ${crRes.status}`,
      };
    }

    const pending = (await crRes.json()) as Array<Record<string, unknown>>;
    return { reachable: true, pending };
  } catch (err) {
    return {
      reachable: false,
      pending: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getGovernanceOverview(actor: ActorContext) {
  ensureSeeded();
  requireRoles(actor, [
    "network_admin",
    "coordinator",
    "referring_clinician",
    "consulting_specialist",
  ]);
  const db = getDb();

  // Sync with live TideCloak if reachable
  const liveTide = await fetchLiveTideChangeRequests();
  const now = new Date().toISOString();

  if (liveTide.reachable && liveTide.pending.length > 0) {
    const grantCr = liveTide.pending.find(
      (cr) =>
        cr.actionType === "GRANT_ROLES" || cr.actionType === "GRANT_ROLE"
    );
    if (grantCr && typeof grantCr.id === "string") {
      db.prepare(
        `
        UPDATE governance_links
        SET tide_change_request_id = ?,
            status_source = 'LIVE_TIDE_IGA',
            last_observed_status = ?,
            checked_at = ?
        WHERE id = 'GOV-LINK-001'
      `
      ).run(grantCr.id, String(grantCr.status || "PENDING"), now);
    }
  }

  const admins = db
    .prepare(
      `
      SELECT u.id, u.display_name, u.title, u.email, o.name as organization_name
      FROM users u
      JOIN organizations o ON o.id = u.organization_id
      WHERE u.role = 'network_admin'
      ORDER BY u.id ASC
    `
    )
    .all() as unknown as Array<{
    id: string;
    display_name: string;
    title: string;
    email: string;
    organization_name: string;
  }>;

  const activeAdminCount = admins.length;
  const requiredQuorum = calculateQuorumThreshold(activeAdminCount);

  const links = db
    .prepare(
      `
      SELECT
        g.*,
        u.display_name as target_user_name,
        u.title as target_user_title,
        o.name as target_organization_name
      FROM governance_links g
      JOIN users u ON u.id = g.target_user_id
      JOIN organizations o ON o.id = u.organization_id
      ORDER BY g.checked_at DESC
    `
    )
    .all() as unknown as Array<Record<string, unknown>>;

  const formattedLinks: GovernanceChangeItem[] = links.map((l) => ({
    id: String(l.id),
    tide_change_request_id: String(l.tide_change_request_id),
    target_user_id: String(l.target_user_id),
    target_user_name: String(l.target_user_name),
    target_user_title: String(l.target_user_title),
    target_organization_name: String(l.target_organization_name),
    requested_action: String(l.requested_action),
    role_name: String(l.role_name),
    status_source: String(l.status_source),
    last_observed_status: String(
      l.last_observed_status
    ) as GovernanceChangeItem["last_observed_status"],
    approvals_observed: Number(l.approvals_observed || 0),
    threshold_observed: Number(l.threshold_observed || requiredQuorum),
    ready_to_commit: Boolean(l.ready_to_commit),
    checked_at: String(l.checked_at),
    notes: String(l.notes || ""),
  }));

  const organizations = db
    .prepare("SELECT * FROM organizations ORDER BY id ASC")
    .all();

  const agreements = db
    .prepare(
      `
      SELECT
        na.*,
        so.name as source_org_name,
        to_org.name as target_org_name
      FROM network_agreements na
      JOIN organizations so ON so.id = na.source_org_id
      JOIN organizations to_org ON to_org.id = na.target_org_id
      ORDER BY na.id ASC
    `
    )
    .all() as unknown as Array<Record<string, unknown>>;

  return {
    quorum_policy: {
      formula: "max(1, floor(0.7 * N))",
      active_admin_count: activeAdminCount,
      required_approvals: requiredQuorum,
      protected_role: "network_consultant",
      explanation: `With N = ${activeAdminCount} independent governance administrators (tide-realm-admin), the QEA approval threshold is max(1, floor(0.7 × ${activeAdminCount})) = ${requiredQuorum} cryptographic approvals required before the 'network_consultant' role takes effect.`,
    },
    tide_connection: {
      live_reachable: liveTide.reachable,
      pending_change_requests_in_tide: liveTide.pending.length,
      live_pending_records: liveTide.pending,
      error: liveTide.error || null,
    },
    admins,
    governance_links: formattedLinks,
    organizations,
    agreements: agreements.map((a) => ({
      ...a,
      allowed_specialties: JSON.parse(
        String(a.allowed_specialties_json || "[]")
      ),
    })),
  };
}

export function createGovernanceProposalLink(
  actor: ActorContext,
  input: {
    target_user_id: string;
    role_name?: string;
    notes?: string;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["network_admin"]);
  const db = getDb();

  const targetUser = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(input.target_user_id) as Record<string, unknown> | undefined;

  if (!targetUser) {
    const err = new Error("Target user not found.") as Error & {
      status: number;
    };
    err.status = 404;
    throw err;
  }

  const roleName = input.role_name || "network_consultant";
  const adminsCount = (
    db
      .prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'network_admin'")
      .get() as { cnt: number }
  ).cnt;
  const threshold = calculateQuorumThreshold(adminsCount);
  const now = new Date().toISOString();
  const id = `GOV-${randomUUID().slice(0, 8).toUpperCase()}`;
  const crId = `CR-PROPOSAL-${randomUUID().slice(0, 6).toUpperCase()}`;

  // Section 14 / A11: Creating or recording a pending governance link NEVER grants the role in users.tide_roles_json!
  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO governance_links (
        id, tide_change_request_id, target_user_id, requested_action,
        role_name, status_source, last_observed_status, approvals_observed,
        threshold_observed, ready_to_commit, checked_at, notes
      ) VALUES (?, ?, ?, 'GRANT_ROLES', ?, 'APP_PROPOSAL_PENDING_TIDE_QEA', 'PENDING', 0, ?, 0, ?, ?)
    `
    ).run(
      id,
      crId,
      input.target_user_id,
      roleName,
      threshold,
      now,
      (
        input.notes ||
        `Proposed granting '${roleName}' to ${String(targetUser.display_name)}. Requires ${threshold} QEA admin approvals before activation.`
      ).trim()
    );
  });

  return {
    id,
    tide_change_request_id: crId,
    target_user_id: input.target_user_id,
    role_name: roleName,
    last_observed_status: "PENDING",
    approvals_observed: 0,
    threshold_observed: threshold,
    ready_to_commit: false,
    checked_at: now,
  };
}
