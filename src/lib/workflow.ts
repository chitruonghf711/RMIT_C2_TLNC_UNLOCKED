import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "./db";
import { ensureSeeded } from "./db/seed";
import type { ActorContext } from "./auth/session";
import { AuthError, requireRoles } from "./auth/session";
import {
  parseClinicalTextDocument,
  writePrivateDocumentFile,
} from "./documents";
import { computeMatchesForCase } from "./matching";
import type {
  CaseStatus,
  GenerationBasisVersions,
  SpecialtyCode,
  SuggestionDecisionType,
} from "./types";

export class DomainError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(
    status: number,
    message: string,
    code = "DOMAIN_ERROR",
    details?: unknown
  ) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function processExpiredInvitations(nowDate: Date = new Date()): {
  expiredCount: number;
  fallbackTriggeredIds: string[];
} {
  ensureSeeded();
  const db = getDb();
  const nowIso = nowDate.toISOString();

  const expiredRows = db
    .prepare(
      `
      SELECT * FROM invitations
      WHERE status = 'PENDING' AND expires_at <= ?
      ORDER BY sent_at ASC
    `
    )
    .all(nowIso) as unknown as Array<Record<string, unknown>>;

  if (expiredRows.length === 0) {
    return { expiredCount: 0, fallbackTriggeredIds: [] };
  }

  const fallbackTriggeredIds: string[] = [];

  for (const inv of expiredRows) {
    withTransaction(db, () => {
      const freshInv = db
        .prepare("SELECT * FROM invitations WHERE id = ?")
        .get(String(inv.id)) as Record<string, unknown> | undefined;
      if (!freshInv || freshInv.status !== "PENDING") return;

      const caseId = String(freshInv.case_id);
      db.prepare(
        `
        UPDATE invitations
        SET status = 'EXPIRED', responded_at = ?
        WHERE id = ?
      `
      ).run(nowIso, String(freshInv.id));

      db.prepare(
        `
        INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
        VALUES (?, ?, 'SYSTEM_CLOCK', 'INVITATION_EXPIRED', ?, ?)
      `
      ).run(
        `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
        caseId,
        JSON.stringify({
          invitation_id: freshInv.id,
          specialist_id: freshInv.specialist_id,
          expired_at: nowIso,
        }),
        nowIso
      );

      const fallbackEnabled = Number(freshInv.fallback_enabled) === 1;
      const fallbackQueue: string[] = JSON.parse(
        String(freshInv.fallback_queue_json || "[]")
      );

      let fallbackCreated = false;
      if (fallbackEnabled && fallbackQueue.length > 0) {
        const matchResult = computeMatchesForCase(caseId, nowDate);
        const eligibleIds = new Set(matchResult.eligible.map((e) => e.user_id));

        const nextIndex = fallbackQueue.findIndex((candId) =>
          eligibleIds.has(candId)
        );
        if (nextIndex !== -1) {
          const nextSpecialistId = fallbackQueue[nextIndex];
          const remainingQueue = fallbackQueue.slice(nextIndex + 1);
          const newInvId = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
          const nextExpiresAt = new Date(
            nowDate.getTime() + 60 * 1000
          ).toISOString();

          db.prepare(
            `
            INSERT INTO invitations (
              id, case_id, snapshot_id, specialist_id, status,
              fallback_enabled, fallback_queue_json, preview_summary_json,
              sent_by, sent_at, expires_at
            ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?, ?, ?, ?)
          `
          ).run(
            newInvId,
            caseId,
            String(freshInv.snapshot_id),
            nextSpecialistId,
            JSON.stringify(remainingQueue),
            String(freshInv.preview_summary_json),
            String(freshInv.sent_by),
            nowIso,
            nextExpiresAt
          );

          db.prepare(
            `
            UPDATE cases
            SET status = 'INVITED', invitation_sent_at = ?, updated_at = ?
            WHERE id = ?
          `
          ).run(nowIso, nowIso, caseId);

          db.prepare(
            `
            INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
            VALUES (?, ?, 'SYSTEM_CLOCK', 'FALLBACK_INVITATION_SENT', ?, ?)
          `
          ).run(
            `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
            caseId,
            JSON.stringify({
              previous_invitation_id: freshInv.id,
              new_invitation_id: newInvId,
              next_specialist_id: nextSpecialistId,
            }),
            nowIso
          );

          fallbackTriggeredIds.push(newInvId);
          fallbackCreated = true;
        }
      }

      if (!fallbackCreated) {
        db.prepare(
          `
          UPDATE cases
          SET status = 'WAITING_MATCH', updated_at = ?
          WHERE id = ? AND status = 'INVITED'
        `
        ).run(nowIso, caseId);
      }
    });
  }

  return { expiredCount: expiredRows.length, fallbackTriggeredIds };
}

export function listWorkspaceCases(actor: ActorContext) {
  ensureSeeded();
  processExpiredInvitations();
  const db = getDb();

  let casesRows: Array<Record<string, unknown>> = [];

  if (actor.role === "referring_clinician") {
    casesRows = db
      .prepare(
        `
        SELECT c.*, o.name as organization_name, u.display_name as referring_clinician_name
        FROM cases c
        JOIN organizations o ON o.id = c.organization_id
        JOIN users u ON u.id = c.referring_clinician_id
        WHERE c.organization_id = ?
        ORDER BY c.updated_at DESC
      `
      )
      .all(actor.organizationId) as unknown as Array<Record<string, unknown>>;
  } else if (actor.role === "consulting_specialist") {
    casesRows = db
      .prepare(
        `
        SELECT DISTINCT c.*, o.name as organization_name, u.display_name as referring_clinician_name
        FROM cases c
        JOIN organizations o ON o.id = c.organization_id
        JOIN users u ON u.id = c.referring_clinician_id
        LEFT JOIN consultations con ON con.case_id = c.id
        LEFT JOIN invitations inv ON inv.case_id = c.id
        WHERE con.specialist_id = ? OR (inv.specialist_id = ? AND inv.status = 'PENDING')
        ORDER BY c.updated_at DESC
      `
      )
      .all(actor.userId, actor.userId) as unknown as Array<
      Record<string, unknown>
    >;
  } else if (actor.role === "coordinator" || actor.role === "network_admin") {
    casesRows = db
      .prepare(
        `
        SELECT c.*, o.name as organization_name, u.display_name as referring_clinician_name
        FROM cases c
        JOIN organizations o ON o.id = c.organization_id
        JOIN users u ON u.id = c.referring_clinician_id
        ORDER BY c.updated_at DESC
      `
      )
      .all() as unknown as Array<Record<string, unknown>>;
  }

  const nowMs = Date.now();
  const formattedCases = casesRows.map((c) => {
    const isMetadataOnly =
      actor.role === "coordinator" || actor.role === "network_admin";
    const activeInv = db
      .prepare(
        `
        SELECT i.*, u.display_name as specialist_name
        FROM invitations i
        JOIN users u ON u.id = i.specialist_id
        WHERE i.case_id = ?
        ORDER BY i.sent_at DESC LIMIT 1
      `
      )
      .get(String(c.id)) as Record<string, unknown> | undefined;

    const activeCon = db
      .prepare(
        `
        SELECT con.id, con.specialist_id, u.display_name as specialist_name
        FROM consultations con
        JOIN users u ON u.id = con.specialist_id
        WHERE con.case_id = ?
        LIMIT 1
      `
      )
      .get(String(c.id)) as Record<string, unknown> | undefined;

    const draftCreatedAt = c.draft_created_at
      ? new Date(String(c.draft_created_at)).getTime()
      : nowMs;
    const reviewCompletedAt = c.review_completed_at
      ? new Date(String(c.review_completed_at)).getTime()
      : null;
    const acceptedAt = c.accepted_at
      ? new Date(String(c.accepted_at)).getTime()
      : null;

    const waitingAgeMinutes =
      !acceptedAt && reviewCompletedAt
        ? Math.max(1, Math.round((nowMs - reviewCompletedAt) / 60000))
        : !acceptedAt
          ? Math.max(1, Math.round((nowMs - draftCreatedAt) / 60000))
          : null;

    return {
      id: String(c.id),
      case_code: String(c.case_code),
      organization_id: String(c.organization_id),
      organization_name: String(c.organization_name),
      referring_clinician_id: String(c.referring_clinician_id),
      referring_clinician_name: String(c.referring_clinician_name),
      patient_label: isMetadataOnly
        ? `Case #${String(c.case_code)}`
        : String(c.patient_label),
      patient_age_band: String(c.patient_age_band),
      patient_sex: String(c.patient_sex),
      title: isMetadataOnly
        ? `[Coordination Metadata Only] ${String(c.specialty_requested)} Case — ${String(c.case_code)}`
        : String(c.title),
      clinical_question: isMetadataOnly
        ? null
        : String(c.clinical_question || ""),
      specialty_requested: String(c.specialty_requested),
      urgency_tier: String(c.urgency_tier),
      status: String(c.status) as CaseStatus,
      input_version: Number(c.input_version),
      snapshot_version: Number(c.snapshot_version),
      draft_created_at: c.draft_created_at,
      review_completed_at: c.review_completed_at,
      invitation_sent_at: c.invitation_sent_at,
      accepted_at: c.accepted_at,
      first_specialist_response_at: c.first_specialist_response_at,
      answered_at: c.answered_at,
      closed_at: c.closed_at,
      waiting_age_minutes: waitingAgeMinutes,
      latest_invitation: activeInv
        ? {
            id: String(activeInv.id),
            specialist_id: String(activeInv.specialist_id),
            specialist_name: String(activeInv.specialist_name),
            status: String(activeInv.status),
            expires_at: String(activeInv.expires_at),
          }
        : null,
      consultation: activeCon
        ? {
            id: String(activeCon.id),
            specialist_id: String(activeCon.specialist_id),
            specialist_name: String(activeCon.specialist_name),
          }
        : null,
      clinical_payload_redacted: isMetadataOnly,
    };
  });

  // Compute Section 19 turnaround & review metrics from real DB state
  const metrics = computeTurnaroundMetrics();

  return {
    cases: formattedCases,
    metrics,
  };
}

export function computeTurnaroundMetrics() {
  const db = getDb();
  const allCases = db
    .prepare("SELECT * FROM cases")
    .all() as unknown as Array<Record<string, unknown>>;

  const prepMinutes: number[] = [];
  const matchMinutes: number[] = [];
  const currentInviteAcceptMinutes: number[] = [];
  const firstResponseMinutes: number[] = [];
  let waitingUnmatchedCount = 0;

  for (const c of allCases) {
    const d0 = c.draft_created_at
      ? new Date(String(c.draft_created_at)).getTime()
      : null;
    const r0 = c.review_completed_at
      ? new Date(String(c.review_completed_at)).getTime()
      : null;
    const i0 = c.invitation_sent_at
      ? new Date(String(c.invitation_sent_at)).getTime()
      : null;
    const a0 = c.accepted_at ? new Date(String(c.accepted_at)).getTime() : null;
    const f0 = c.first_specialist_response_at
      ? new Date(String(c.first_specialist_response_at)).getTime()
      : null;

    if (d0 && r0 && r0 >= d0) {
      prepMinutes.push(Math.round((r0 - d0) / 60000));
    }
    if (r0 && a0 && a0 >= r0) {
      matchMinutes.push(Math.round((a0 - r0) / 60000));
    }
    if (i0 && a0 && a0 >= i0) {
      currentInviteAcceptMinutes.push(Math.round((a0 - i0) / 60000));
    }
    if (a0 && f0 && f0 >= a0) {
      firstResponseMinutes.push(Math.round((f0 - a0) / 60000));
    }
    if (
      ["READY", "WAITING_MATCH", "INVITED"].includes(String(c.status)) &&
      !a0
    ) {
      waitingUnmatchedCount++;
    }
  }

  const avg = (arr: number[]) =>
    arr.length > 0
      ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1))
      : null;

  // Test suggestion review stats
  const totalSug = (
    db.prepare("SELECT COUNT(*) as cnt FROM test_suggestions").get() as {
      cnt: number;
    }
  ).cnt;
  const insufficientEvidenceSug = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM test_suggestions WHERE evidence_status IN ('NEEDS_INFORMATION', 'ABSTAIN', 'UNSUPPORTED')"
      )
      .get() as { cnt: number }
  ).cnt;
  const duplicateFlaggedSug = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM test_suggestions WHERE duplicate_status != 'NONE'"
      )
      .get() as { cnt: number }
  ).cnt;

  const decisionsByType = db
    .prepare(
      "SELECT decision, COUNT(*) as cnt FROM test_suggestion_decisions GROUP BY decision"
    )
    .all() as unknown as Array<{ decision: string; cnt: number }>;
  const decisionCounts: Record<string, number> = {
    APPROVED: 0,
    MODIFIED: 0,
    REJECTED: 0,
    DEFERRED: 0,
  };
  for (const d of decisionsByType) {
    decisionCounts[d.decision] = Number(d.cnt);
  }

  return {
    sample_size_total_cases: allCases.length,
    prep_time_avg_minutes: avg(prepMinutes),
    prep_time_sample_size: prepMinutes.length,
    match_time_avg_minutes: avg(matchMinutes),
    match_time_sample_size: matchMinutes.length,
    invite_accept_avg_minutes: avg(currentInviteAcceptMinutes),
    invite_accept_sample_size: currentInviteAcceptMinutes.length,
    first_response_avg_minutes: avg(firstResponseMinutes),
    first_response_sample_size: firstResponseMinutes.length,
    waiting_unmatched_cases_count: waitingUnmatchedCount,
    test_suggestion_stats: {
      total_suggestions: totalSug,
      insufficient_evidence_count: insufficientEvidenceSug,
      duplicate_flagged_count: duplicateFlaggedSug,
      decisions: decisionCounts,
    },
    data_label:
      "Live operational metrics computed directly from SQLite timestamps (never black-box clinical quality claims)",
  };
}

export function getCaseDetail(caseId: string, actor: ActorContext) {
  ensureSeeded();
  processExpiredInvitations();
  const db = getDb();

  const caseRow = db
    .prepare(
      `
      SELECT c.*, o.name as organization_name, u.display_name as referring_clinician_name
      FROM cases c
      JOIN organizations o ON o.id = c.organization_id
      JOIN users u ON u.id = c.referring_clinician_id
      WHERE c.id = ?
    `
    )
    .get(caseId) as Record<string, unknown> | undefined;

  if (!caseRow) {
    throw new DomainError(404, "Case record not found.", "CASE_NOT_FOUND");
  }

  // Enforce strict object-level authorization (Section 9, A01, A10)
  if (actor.role === "referring_clinician") {
    if (String(caseRow.organization_id) !== actor.organizationId) {
      throw new AuthError(
        403,
        "You are not authorized to access clinical records belonging to another organization (A10).",
        "CROSS_ORG_FORBIDDEN"
      );
    }
  } else if (actor.role === "consulting_specialist") {
    const acceptedCon = db
      .prepare(
        "SELECT id FROM consultations WHERE case_id = ? AND specialist_id = ? LIMIT 1"
      )
      .get(caseId, actor.userId);
    if (!acceptedCon) {
      throw new AuthError(
        403,
        "Specialists may only view full clinical records after accepting a valid consultation invitation (A06, A10).",
        "SPECIALIST_NOT_ACCEPTED"
      );
    }
  } else if (actor.role === "coordinator") {
    // Coordinator only gets operational status metadata, NEVER clinical payload (Section 9.3, A10)
    const invitations = db
      .prepare(
        `
        SELECT i.id, i.case_id, i.specialist_id, u.display_name as specialist_name,
               i.status, i.fallback_enabled, i.sent_at, i.expires_at, i.responded_at
        FROM invitations i
        JOIN users u ON u.id = i.specialist_id
        WHERE i.case_id = ?
        ORDER BY i.sent_at DESC
      `
      )
      .all(caseId);
    return {
      case: {
        id: caseRow.id,
        case_code: caseRow.case_code,
        organization_id: caseRow.organization_id,
        organization_name: caseRow.organization_name,
        specialty_requested: caseRow.specialty_requested,
        urgency_tier: caseRow.urgency_tier,
        status: caseRow.status,
        draft_created_at: caseRow.draft_created_at,
        review_completed_at: caseRow.review_completed_at,
        invitation_sent_at: caseRow.invitation_sent_at,
        accepted_at: caseRow.accepted_at,
        answered_at: caseRow.answered_at,
        closed_at: caseRow.closed_at,
      },
      clinical_payload_redacted: true,
      invitations,
    };
  } else {
    throw new AuthError(
      403,
      "Network administrators are not permitted to read clinical case data (Section 9.3).",
      "ADMIN_CLINICAL_FORBIDDEN"
    );
  }

  const documents = db
    .prepare(
      "SELECT * FROM document_versions WHERE case_id = ? ORDER BY version ASC, id ASC"
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const latestPrepRun = db
    .prepare(
      "SELECT * FROM preparation_runs WHERE case_id = ? ORDER BY created_at DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown> | undefined;

  const snapshots = db
    .prepare(
      "SELECT * FROM referral_snapshots WHERE case_id = ? ORDER BY version DESC"
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const assessments = db
    .prepare(
      `
      SELECT ca.*, u.display_name as author_name
      FROM clinical_assessments ca
      JOIN users u ON u.id = ca.author_id
      WHERE ca.case_id = ?
      ORDER BY ca.version DESC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const latestAssessmentVersion = assessments[0]
    ? Number(assessments[0].version)
    : 0;
  const currentInputVersion = Number(caseRow.input_version || 1);

  const suggestionsRaw = db
    .prepare(
      `
      SELECT ts.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality
      FROM test_suggestions ts
      JOIN test_catalog_entries tc ON tc.id = ts.catalog_test_id
      WHERE ts.case_id = ?
      ORDER BY ts.created_at DESC, ts.id ASC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const suggestions = suggestionsRaw.map((s) => {
    const dec = db
      .prepare(
        `
        SELECT d.*, u.display_name as reviewer_name
        FROM test_suggestion_decisions d
        JOIN users u ON u.id = d.reviewer_id
        WHERE d.suggestion_id = ?
        ORDER BY d.reviewed_at DESC LIMIT 1
      `
      )
      .get(String(s.id)) as Record<string, unknown> | undefined;

    const basis = JSON.parse(
      String(s.generation_basis_versions_json || "{}")
    ) as GenerationBasisVersions;

    let needsReReview = false;
    if (dec) {
      const reviewedBasis = JSON.parse(
        String(dec.reviewed_basis_versions_json || "{}")
      ) as GenerationBasisVersions;
      if (
        reviewedBasis.case_version < currentInputVersion ||
        reviewedBasis.assessment_version < latestAssessmentVersion
      ) {
        needsReReview = true;
      }
    } else if (
      basis.case_version < currentInputVersion ||
      basis.assessment_version < latestAssessmentVersion
    ) {
      needsReReview = true;
    }

    return {
      id: String(s.id),
      run_id: String(s.run_id),
      case_id: String(s.case_id),
      catalog_test_id: String(s.catalog_test_id),
      catalog_test_code: String(s.catalog_test_code),
      catalog_test_name: String(s.catalog_test_name),
      modality: String(s.modality),
      target_question: String(s.target_question),
      patient_evidence_refs: JSON.parse(
        String(s.patient_evidence_refs_json || "[]")
      ),
      guideline_refs: JSON.parse(String(s.guideline_refs_json || "[]")),
      applicability_conditions: JSON.parse(
        String(s.applicability_conditions_json || "[]")
      ),
      unmet_or_unknown_conditions: JSON.parse(
        String(s.unmet_or_unknown_conditions_json || "[]")
      ),
      existing_test_refs: JSON.parse(String(s.existing_test_refs_json || "[]")),
      duplicate_status: String(s.duplicate_status),
      limitations: JSON.parse(String(s.limitations_json || "[]")),
      evidence_status: String(s.evidence_status),
      generation_basis_versions: basis,
      needs_re_review: needsReReview,
      decision: dec
        ? {
            id: String(dec.id),
            reviewer_id: String(dec.reviewer_id),
            reviewer_name: String(dec.reviewer_name),
            decision: String(dec.decision) as SuggestionDecisionType,
            edited_content: dec.edited_content_json
              ? JSON.parse(String(dec.edited_content_json))
              : null,
            rationale: String(dec.rationale),
            reviewed_basis_versions: JSON.parse(
              String(dec.reviewed_basis_versions_json || "{}")
            ),
            reviewed_at: String(dec.reviewed_at),
            needs_re_review: needsReReview,
          }
        : null,
    };
  });

  const clinicianAddedTests = db
    .prepare(
      `
      SELECT cat.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality, u.display_name as added_by_name
      FROM clinician_added_tests cat
      JOIN test_catalog_entries tc ON tc.id = cat.catalog_test_id
      JOIN users u ON u.id = cat.added_by
      WHERE cat.case_id = ?
      ORDER BY cat.added_at ASC
    `
    )
    .all(caseId);

  const testPlans = db
    .prepare(
      `
      SELECT tp.*, u.display_name as confirmed_by_name
      FROM test_plan_versions tp
      JOIN users u ON u.id = tp.confirmed_by
      WHERE tp.case_id = ?
      ORDER BY tp.version DESC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const mockOrders = db
    .prepare(
      `
      SELECT mo.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality
      FROM mock_test_orders mo
      JOIN test_catalog_entries tc ON tc.id = mo.catalog_test_id
      WHERE mo.case_id = ?
      ORDER BY mo.created_at DESC
    `
    )
    .all(caseId);

  const testResults = db
    .prepare(
      `
      SELECT tr.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, u.display_name as recorded_by_name
      FROM test_results tr
      JOIN test_catalog_entries tc ON tc.id = tr.catalog_test_id
      JOIN users u ON u.id = tr.recorded_by
      WHERE tr.case_id = ?
      ORDER BY tr.recorded_at DESC
    `
    )
    .all(caseId);

  const invitations = db
    .prepare(
      `
      SELECT i.*, u.display_name as specialist_name, u.title as specialist_title
      FROM invitations i
      JOIN users u ON u.id = i.specialist_id
      WHERE i.case_id = ?
      ORDER BY i.sent_at DESC
    `
    )
    .all(caseId);

  const consultation = db
    .prepare("SELECT * FROM consultations WHERE case_id = ? LIMIT 1")
    .get(caseId);

  const catalog = db
    .prepare("SELECT * FROM test_catalog_entries WHERE active = 1 ORDER BY id ASC")
    .all();

  const referenceCases = db
    .prepare("SELECT * FROM reference_cases ORDER BY published_at DESC")
    .all() as unknown as Array<Record<string, unknown>>;

  const visibleReferenceCases = referenceCases
    .filter((rc) => {
      const allowedOrgs: string[] = JSON.parse(
        String(rc.allowed_org_ids_json || "[]")
      );
      return allowedOrgs.includes(actor.organizationId);
    })
    .map((rc) => ({
      id: rc.id,
      title: rc.title,
      specialty_code: rc.specialty_code,
      summary_approved: rc.summary_approved,
      relevant_features: JSON.parse(String(rc.relevant_features_json || "{}")),
      consultation_questions: JSON.parse(
        String(rc.consultation_questions_json || "[]")
      ),
      approved_response_excerpt: rc.approved_response_excerpt,
      source_organization_name: rc.source_organization_name,
      published_at: rc.published_at,
    }));

  return {
    case: {
      ...caseRow,
      secondary_specialties: JSON.parse(
        String(caseRow.secondary_specialties_json || "[]")
      ),
      topic_tags: JSON.parse(String(caseRow.topic_tags_json || "[]")),
    },
    documents: documents.map((d) => ({
      ...d,
      segments: JSON.parse(String(d.segments_json || "[]")),
    })),
    latest_preparation_run: latestPrepRun
      ? {
          ...latestPrepRun,
          output: JSON.parse(String(latestPrepRun.output_json || "{}")),
          validation_errors: JSON.parse(
            String(latestPrepRun.validation_errors_json || "[]")
          ),
        }
      : null,
    snapshots: snapshots.map((s) => ({
      ...s,
      summary_sections: JSON.parse(String(s.summary_sections_json || "[]")),
      unknowns: JSON.parse(String(s.unknowns_json || "[]")),
      contradictions: JSON.parse(String(s.contradictions_json || "[]")),
      questions: JSON.parse(String(s.questions_json || "[]")),
      selected_specialties: JSON.parse(
        String(s.selected_specialties_json || "[]")
      ),
      manual_edits: JSON.parse(String(s.manual_edits_json || "[]")),
    })),
    assessments: assessments.map((a) => ({
      ...a,
      differential_diagnoses: JSON.parse(
        String(a.differential_diagnoses_json || "[]")
      ),
      red_flags_checked: JSON.parse(String(a.red_flags_checked_json || "[]")),
      unresolved_questions: JSON.parse(
        String(a.unresolved_questions_json || "[]")
      ),
    })),
    test_suggestions: suggestions,
    clinician_added_tests: clinicianAddedTests,
    test_plans: testPlans.map((tp) => ({
      ...tp,
      items: JSON.parse(String(tp.items_json || "[]")),
      basis_versions: JSON.parse(String(tp.basis_versions_json || "{}")),
    })),
    mock_orders: mockOrders,
    test_results: testResults,
    invitations,
    consultation,
    test_catalog: catalog,
    reference_cases: visibleReferenceCases,
    clinical_payload_redacted: false,
  };
}

export function createCase(
  actor: ActorContext,
  input: {
    patient_label: string;
    patient_age_band: string;
    patient_sex: string;
    title: string;
    clinical_question?: string;
    specialty_requested: SpecialtyCode;
    secondary_specialties?: SpecialtyCode[];
    topic_tags?: string[];
    urgency_tier?: "ROUTINE" | "PRIORITY";
    initial_document?: {
      filename: string;
      doc_type?: string;
      content: string;
    };
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  if (!input.title || input.title.trim().length < 5) {
    throw new DomainError(400, "Case title must be at least 5 characters.");
  }

  const now = new Date().toISOString();
  const caseId = `CASE-${randomUUID().slice(0, 8).toUpperCase()}`;
  const caseCode = `CB-AB-2026-${Math.floor(100 + Math.random() * 899)}`;

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO cases (
        id, case_code, organization_id, referring_clinician_id,
        patient_label, patient_age_band, patient_sex,
        title, clinical_question, specialty_requested,
        secondary_specialties_json, topic_tags_json, language_required,
        urgency_tier, status, input_version, snapshot_version,
        draft_created_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vi', ?, 'DRAFT', 1, 0, ?, ?, ?)
    `
    ).run(
      caseId,
      caseCode,
      actor.organizationId, // Always derived from server actor, never request body (A01)
      actor.userId,
      input.patient_label || "De-identified Patient",
      input.patient_age_band || "50-59",
      input.patient_sex || "Male",
      input.title.trim(),
      (input.clinical_question || "").trim(),
      input.specialty_requested || "RESPIRATORY",
      JSON.stringify(input.secondary_specialties || []),
      JSON.stringify(input.topic_tags || []),
      input.urgency_tier || "ROUTINE",
      now,
      now,
      now
    );

    if (input.initial_document && input.initial_document.content.trim()) {
      const parsed = parseClinicalTextDocument(
        input.initial_document.filename || "initial_clinical_note.txt",
        input.initial_document.content
      );
      const docId = `DOC-${randomUUID().slice(0, 8).toUpperCase()}`;
      const storagePath = writePrivateDocumentFile(
        caseId,
        docId,
        1,
        input.initial_document.filename || "initial_clinical_note.txt",
        parsed.normalizedText
      );
      db.prepare(
        `
        INSERT INTO document_versions (
          id, case_id, version, filename, doc_type, mime_type,
          storage_path, extracted_text, segments_json, uploaded_by, created_at
        ) VALUES (?, ?, 1, ?, ?, 'text/plain', ?, ?, ?, ?, ?)
      `
      ).run(
        docId,
        caseId,
        input.initial_document.filename || "initial_clinical_note.txt",
        input.initial_document.doc_type || "CLINICAL_NOTE",
        storagePath,
        parsed.normalizedText,
        JSON.stringify(parsed.segments),
        actor.userId,
        now
      );
    }

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'CASE_CREATED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({ case_code: caseCode }),
      now
    );
  });

  return getCaseDetail(caseId, actor);
}

export function addDocumentToCase(
  caseId: string,
  actor: ActorContext,
  input: {
    filename: string;
    doc_type?: string;
    content: string;
    mime_type?: string;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow) {
    throw new DomainError(404, "Case record not found.");
  }
  if (String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(
      403,
      "Not authorized to upload documents to a case belonging to another organization."
    );
  }
  if (caseRow.status === "CLOSED" || caseRow.status === "CANCELLED") {
    throw new DomainError(409, "Case is closed; cannot upload additional documents.");
  }

  const parsed = parseClinicalTextDocument(
    input.filename,
    input.content,
    input.mime_type || "text/plain"
  );

  const now = new Date().toISOString();
  const maxVerRow = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_v FROM document_versions WHERE case_id = ?"
    )
    .get(caseId) as { max_v: number };
  const nextDocVersion = Number(maxVerRow.max_v) + 1;
  const nextInputVersion = Number(caseRow.input_version) + 1;
  const docId = `DOC-${randomUUID().slice(0, 8).toUpperCase()}`;

  const storagePath = writePrivateDocumentFile(
    caseId,
    docId,
    nextDocVersion,
    input.filename,
    parsed.normalizedText
  );

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO document_versions (
        id, case_id, version, filename, doc_type, mime_type,
        storage_path, extracted_text, segments_json, uploaded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?)
    `
    ).run(
      docId,
      caseId,
      nextDocVersion,
      input.filename,
      input.doc_type || "SUPPLEMENTAL_NOTE",
      storagePath,
      parsed.normalizedText,
      JSON.stringify(parsed.segments),
      actor.userId,
      now
    );

    db.prepare(
      `
      UPDATE cases
      SET input_version = ?, updated_at = ?
      WHERE id = ?
    `
    ).run(nextInputVersion, now, caseId);

    // Mark any confirmed test plan as NEEDS_REVIEW when source documents change (A19)
    db.prepare(
      `
      UPDATE test_plan_versions
      SET status = 'NEEDS_REVIEW'
      WHERE case_id = ? AND status = 'CONFIRMED'
    `
    ).run(caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'DOCUMENT_VERSION_UPLOADED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        document_id: docId,
        version: nextDocVersion,
        new_input_version: nextInputVersion,
        suspicious_segments: parsed.suspiciousSegmentsCount,
      }),
      now
    );
  });

  return {
    document_id: docId,
    version: nextDocVersion,
    new_input_version: nextInputVersion,
    segments: parsed.segments,
    suspicious_segments_count: parsed.suspiciousSegmentsCount,
  };
}

export function submitCaseReviewAndSnapshot(
  caseId: string,
  actor: ActorContext,
  input: {
    expected_input_version: number;
    preparation_run_id?: string | null;
    summary_sections: unknown[];
    unknowns: unknown[];
    contradictions?: unknown[];
    questions: Array<{ id: string; text: string; selected?: boolean }>;
    selected_specialties: SpecialtyCode[];
    clinical_question?: string;
    manual_edits?: Array<{ field: string; action: string; note?: string }>;
    confirmed_by_clinician: boolean;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow) {
    throw new DomainError(404, "Case record not found.");
  }
  if (String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(403, "Not authorized to confirm a referral package for another organization.");
  }
  if (caseRow.status === "CLOSED" || caseRow.status === "CANCELLED") {
    throw new DomainError(409, "Case is closed; cannot confirm a new referral snapshot.");
  }

  // A04: Explicit clinician confirmation required
  if (!input.confirmed_by_clinician) {
    throw new DomainError(
      422,
      "Referring clinician must explicitly confirm review of the summary, unknowns, and consultation questions before finalizing the package (A04).",
      "CLINICIAN_CONFIRMATION_REQUIRED"
    );
  }

  // A05: Stale input_version check
  const currentInputVersion = Number(caseRow.input_version);
  if (Number(input.expected_input_version) !== currentInputVersion) {
    throw new DomainError(
      409,
      `Source documents for this case have changed (current version v${currentInputVersion}, reviewed against v${input.expected_input_version}). Please review the updated documents before confirming the package (A05).`,
      "STALE_INPUT_VERSION",
      {
        current_input_version: currentInputVersion,
        expected_input_version: input.expected_input_version,
      }
    );
  }

  if (
    !input.selected_specialties ||
    input.selected_specialties.length === 0
  ) {
    throw new DomainError(
      422,
      "At least 1 receiving specialty must be selected.",
      "SPECIALTY_REQUIRED"
    );
  }

  const activeQuestions = (input.questions || []).filter(
    (q) => q.text && q.text.trim().length > 0 && q.selected !== false
  );
  if (activeQuestions.length === 0) {
    throw new DomainError(
      422,
      "At least 1 specific consultation question confirmed by the clinician is required.",
      "QUESTIONS_REQUIRED"
    );
  }

  const now = new Date().toISOString();
  const nextSnapVersion = Number(caseRow.snapshot_version || 0) + 1;
  const snapId = `SNAP-${caseId}-V${nextSnapVersion}`;
  const nextStatus: CaseStatus =
    caseRow.status === "DRAFT" ? "READY" : (caseRow.status as CaseStatus);

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO referral_snapshots (
        id, case_id, version, input_version, preparation_run_id,
        summary_sections_json, unknowns_json, contradictions_json,
        questions_json, selected_specialties_json, manual_edits_json,
        confirmed_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      snapId,
      caseId,
      nextSnapVersion,
      currentInputVersion,
      input.preparation_run_id || null,
      JSON.stringify(input.summary_sections || []),
      JSON.stringify(input.unknowns || []),
      JSON.stringify(input.contradictions || []),
      JSON.stringify(activeQuestions),
      JSON.stringify(input.selected_specialties),
      JSON.stringify(input.manual_edits || []),
      actor.userId,
      now
    );

    const primarySpec = input.selected_specialties[0];
    const secondarySpecs = input.selected_specialties.slice(1);

    db.prepare(
      `
      UPDATE cases
      SET status = ?,
          snapshot_version = ?,
          specialty_requested = ?,
          secondary_specialties_json = ?,
          clinical_question = ?,
          review_completed_at = COALESCE(review_completed_at, ?),
          updated_at = ?
      WHERE id = ?
    `
    ).run(
      nextStatus,
      nextSnapVersion,
      primarySpec,
      JSON.stringify(secondarySpecs),
      input.clinical_question || activeQuestions[0].text,
      now,
      now,
      caseId
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'REFERRAL_SNAPSHOT_CONFIRMED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        snapshot_id: snapId,
        snapshot_version: nextSnapVersion,
        input_version: currentInputVersion,
        status: nextStatus,
      }),
      now
    );
  });

  return {
    snapshot_id: snapId,
    version: nextSnapVersion,
    input_version: currentInputVersion,
    case_status: nextStatus,
    review_completed_at: now,
  };
}

export function saveClinicalAssessment(
  caseId: string,
  actor: ActorContext,
  input: {
    working_impression: string;
    differential_diagnoses: string[];
    red_flags_checked?: string[];
    unresolved_questions: string[];
    urgency_level?: string;
    rationale_notes?: string;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow) {
    throw new DomainError(404, "Case record not found.");
  }
  if (String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(
      403,
      "Only clinicians belonging to the managing organization may save a clinical assessment."
    );
  }

  if (
    !input.working_impression ||
    input.working_impression.trim().length < 5
  ) {
    throw new DomainError(
      422,
      "Preliminary clinical working impression cannot be empty.",
      "IMPRESSION_REQUIRED"
    );
  }

  const maxVerRow = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_v FROM clinical_assessments WHERE case_id = ?"
    )
    .get(caseId) as { max_v: number };
  const nextVersion = Number(maxVerRow.max_v) + 1;
  const id = `ASSESS-${caseId}-V${nextVersion}`;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO clinical_assessments (
        id, case_id, version, case_input_version, author_id,
        working_impression, differential_diagnoses_json,
        red_flags_checked_json, unresolved_questions_json,
        urgency_level, rationale_notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      id,
      caseId,
      nextVersion,
      Number(caseRow.input_version),
      actor.userId,
      input.working_impression.trim(),
      JSON.stringify(input.differential_diagnoses || []),
      JSON.stringify(input.red_flags_checked || []),
      JSON.stringify(input.unresolved_questions || []),
      input.urgency_level || "NON_EMERGENT_SPECIALIST_CONSULT",
      input.rationale_notes || "",
      now
    );

    // Mark existing CONFIRMED test plans as NEEDS_REVIEW when assessment changes (A19)
    db.prepare(
      `
      UPDATE test_plan_versions
      SET status = 'NEEDS_REVIEW'
      WHERE case_id = ? AND status = 'CONFIRMED'
    `
    ).run(caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'CLINICAL_ASSESSMENT_SAVED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({ assessment_id: id, version: nextVersion }),
      now
    );
  });

  return {
    id,
    case_id: caseId,
    version: nextVersion,
    case_input_version: Number(caseRow.input_version),
    created_at: now,
  };
}

export function recordTestSuggestionDecision(
  suggestionId: string,
  actor: ActorContext,
  input: {
    decision: SuggestionDecisionType;
    rationale: string;
    edited_content?: {
      target_question?: string;
      catalog_test_id?: string;
      note?: string;
    } | null;
  }
) {
  ensureSeeded();
  // A20: Strictly only referring_clinician can decide on test suggestions
  requireRoles(
    actor,
    ["referring_clinician"],
    "Only the responsible referring clinician may approve or reject test suggestions (A20)."
  );
  const db = getDb();

  const sug = db
    .prepare("SELECT * FROM test_suggestions WHERE id = ?")
    .get(suggestionId) as Record<string, unknown> | undefined;
  if (!sug) {
    throw new DomainError(404, "Test suggestion not found.");
  }

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(String(sug.case_id)) as Record<string, unknown> | undefined;
  if (!caseRow || String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(
      403,
      "Not authorized to review test suggestions for another organization (A20)."
    );
  }

  if (
    !["APPROVED", "MODIFIED", "REJECTED", "DEFERRED", "PENDING_REVIEW"].includes(
      input.decision
    )
  ) {
    throw new DomainError(422, "Invalid test suggestion decision.");
  }

  // If suggestion is UNSUPPORTED, prevent approving as AI-supported without modification
  if (
    sug.evidence_status === "UNSUPPORTED" &&
    input.decision === "APPROVED"
  ) {
    throw new DomainError(
      422,
      "Cannot directly approve an UNSUPPORTED test suggestion without modification (A17).",
      "UNSUPPORTED_SUGGESTION_CANNOT_APPROVE"
    );
  }

  const latestAssessment = db
    .prepare(
      "SELECT version FROM clinical_assessments WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(String(sug.case_id)) as { version: number } | undefined;

  const sugBasis = JSON.parse(
    String(sug.generation_basis_versions_json || "{}")
  ) as GenerationBasisVersions;

  const reviewedBasis: GenerationBasisVersions = {
    case_version: Number(caseRow.input_version),
    assessment_version: Number(
      latestAssessment?.version || sugBasis.assessment_version || 1
    ),
    knowledge_versions: sugBasis.knowledge_versions || {},
  };

  const decId = `TDEC-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO test_suggestion_decisions (
        id, suggestion_id, case_id, reviewer_id, decision,
        edited_content_json, rationale, reviewed_basis_versions_json, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      decId,
      suggestionId,
      String(sug.case_id),
      actor.userId,
      input.decision,
      input.edited_content ? JSON.stringify(input.edited_content) : null,
      (input.rationale || "Clinically reviewed.").trim(),
      JSON.stringify(reviewedBasis),
      now
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'TEST_SUGGESTION_DECIDED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      String(sug.case_id),
      actor.userId,
      JSON.stringify({
        suggestion_id: suggestionId,
        decision_id: decId,
        decision: input.decision,
      }),
      now
    );
  });

  return {
    id: decId,
    suggestion_id: suggestionId,
    case_id: String(sug.case_id),
    decision: input.decision,
    edited_content: input.edited_content || null,
    rationale: input.rationale,
    reviewed_basis_versions: reviewedBasis,
    reviewed_at: now,
  };
}

export function addClinicianCustomTest(
  caseId: string,
  actor: ActorContext,
  input: {
    catalog_test_id: string;
    target_question: string;
    rationale: string;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow || String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(403, "Not authorized to add tests to this case.");
  }

  const cat = db
    .prepare("SELECT * FROM test_catalog_entries WHERE id = ? AND active = 1")
    .get(input.catalog_test_id) as Record<string, unknown> | undefined;
  if (!cat) {
    throw new DomainError(
      422,
      "Selected test is not in the approved TestCatalogEntry list (A18).",
      "INVALID_CATALOG_TEST"
    );
  }

  const id = `CADD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  db.prepare(
    `
    INSERT INTO clinician_added_tests (
      id, case_id, catalog_test_id, target_question, rationale, added_by, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(
    id,
    caseId,
    input.catalog_test_id,
    input.target_question.trim(),
    input.rationale.trim(),
    actor.userId,
    now
  );

  return {
    id,
    case_id: caseId,
    catalog_test_id: input.catalog_test_id,
    catalog_test_code: String(cat.code),
    catalog_test_name: String(cat.name_vi),
    target_question: input.target_question.trim(),
    rationale: input.rationale.trim(),
    source_label: "CLINICIAN_ADDED",
    added_at: now,
  };
}

export function confirmTestPlan(
  caseId: string,
  actor: ActorContext,
  input: {
    expected_case_version?: number;
    expected_assessment_version?: number;
  } = {}
) {
  ensureSeeded();
  // A20: Only referring clinician can confirm test plans (admin/coordinator get 403)
  requireRoles(
    actor,
    ["referring_clinician"],
    "Only the responsible referring clinician may confirm a test plan (A20)."
  );
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow) {
    throw new DomainError(404, "Case record not found.");
  }
  if (String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(
      403,
      "Only clinicians belonging to the managing organization may confirm a test plan (A20)."
    );
  }

  // A16: Must have saved ClinicalAssessment before confirming a test plan
  const latestAssessment = db
    .prepare(
      "SELECT * FROM clinical_assessments WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown> | undefined;
  if (!latestAssessment) {
    throw new DomainError(
      422,
      "A Clinical Assessment must be saved before confirming a test plan (A16).",
      "ASSESSMENT_MISSING"
    );
  }

  const currentCaseVersion = Number(caseRow.input_version);
  const currentAssessmentVersion = Number(latestAssessment.version);

  if (
    input.expected_case_version !== undefined &&
    Number(input.expected_case_version) !== currentCaseVersion
  ) {
    throw new DomainError(
      409,
      "Source document version has changed; please re-review test suggestions before confirming the plan (A19).",
      "STALE_CASE_VERSION_FOR_PLAN"
    );
  }
  if (
    input.expected_assessment_version !== undefined &&
    Number(input.expected_assessment_version) !== currentAssessmentVersion
  ) {
    throw new DomainError(
      409,
      "Clinical Assessment version has changed; please re-review test suggestions before confirming the plan (A19).",
      "STALE_ASSESSMENT_VERSION_FOR_PLAN"
    );
  }

  const suggestions = db
    .prepare(
      `
      SELECT ts.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality
      FROM test_suggestions ts
      JOIN test_catalog_entries tc ON tc.id = ts.catalog_test_id
      WHERE ts.case_id = ?
      ORDER BY ts.id ASC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  const selectedItems: Array<Record<string, unknown>> = [];

  for (const s of suggestions) {
    const dec = db
      .prepare(
        "SELECT * FROM test_suggestion_decisions WHERE suggestion_id = ? ORDER BY reviewed_at DESC LIMIT 1"
      )
      .get(String(s.id)) as Record<string, unknown> | undefined;

    // A18: PENDING_REVIEW, REJECTED, and DEFERRED never enter the confirmed plan
    if (!dec) continue;
    const dType = String(dec.decision);
    if (dType !== "APPROVED" && dType !== "MODIFIED") continue;

    // A19: Check that the decision was reviewed against current case_version & assessment_version
    const reviewedBasis = JSON.parse(
      String(dec.reviewed_basis_versions_json || "{}")
    ) as GenerationBasisVersions;
    if (
      reviewedBasis.case_version < currentCaseVersion ||
      reviewedBasis.assessment_version < currentAssessmentVersion
    ) {
      throw new DomainError(
        409,
        `Test item '${String(s.catalog_test_code)}' was reviewed against an older basis (case v${reviewedBasis.case_version} / assessment v${reviewedBasis.assessment_version}). Please re-review after updating the record or assessment (A19).`,
        "STALE_DECISION_NEEDS_RE_REVIEW"
      );
    }

    const edited = dec.edited_content_json
      ? (JSON.parse(String(dec.edited_content_json)) as {
          target_question?: string;
        })
      : null;

    selectedItems.push({
      item_type: "AI_SUGGESTION_REVIEWED",
      suggestion_id: String(s.id),
      decision_id: String(dec.id),
      decision: dType,
      catalog_test_id: String(s.catalog_test_id),
      catalog_test_code: String(s.catalog_test_code),
      catalog_test_name: String(s.catalog_test_name),
      modality: String(s.modality),
      target_question: edited?.target_question || String(s.target_question),
      clinician_rationale: String(dec.rationale),
      source_label: dType === "MODIFIED" ? "CLINICIAN_MODIFIED_AI" : "AI_GROUNDED_CLINICIAN_APPROVED",
    });
  }

  // Also include clinician-added custom tests (labeled distinctly as CLINICIAN_ADDED)
  const customAdded = db
    .prepare(
      `
      SELECT cat.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality
      FROM clinician_added_tests cat
      JOIN test_catalog_entries tc ON tc.id = cat.catalog_test_id
      WHERE cat.case_id = ?
      ORDER BY cat.added_at ASC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  for (const ca of customAdded) {
    selectedItems.push({
      item_type: "CLINICIAN_ADDED",
      clinician_added_id: String(ca.id),
      catalog_test_id: String(ca.catalog_test_id),
      catalog_test_code: String(ca.catalog_test_code),
      catalog_test_name: String(ca.catalog_test_name),
      modality: String(ca.modality),
      target_question: String(ca.target_question),
      clinician_rationale: String(ca.rationale),
      source_label: "CLINICIAN_ADDED",
    });
  }

  if (selectedItems.length === 0) {
    throw new DomainError(
      422,
      "At least 1 APPROVED, MODIFIED, or CLINICIAN_ADDED test item is required to confirm a test plan.",
      "EMPTY_TEST_PLAN"
    );
  }

  const maxPlanVer = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_v FROM test_plan_versions WHERE case_id = ?"
    )
    .get(caseId) as { max_v: number };
  const nextPlanVersion = Number(maxPlanVer.max_v) + 1;
  const planId = `TPLAN-${caseId}-V${nextPlanVersion}`;
  const now = new Date().toISOString();

  const kbRows = db
    .prepare("SELECT id, version FROM knowledge_document_versions")
    .all() as unknown as Array<{ id: string; version: number }>;
  const kbMap: Record<string, number> = {};
  for (const k of kbRows) kbMap[k.id] = k.version;

  const basisVersions: GenerationBasisVersions = {
    case_version: currentCaseVersion,
    assessment_version: currentAssessmentVersion,
    knowledge_versions: kbMap,
  };

  // A21: Confirming a plan creates an immutable TestPlanVersion and NEVER automatically creates MockTestOrders!
  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO test_plan_versions (
        id, case_id, version, status, items_json, basis_versions_json, confirmed_by, confirmed_at
      ) VALUES (?, ?, ?, 'CONFIRMED', ?, ?, ?, ?)
    `
    ).run(
      planId,
      caseId,
      nextPlanVersion,
      JSON.stringify(selectedItems),
      JSON.stringify(basisVersions),
      actor.userId,
      now
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'TEST_PLAN_CONFIRMED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        plan_id: planId,
        version: nextPlanVersion,
        item_count: selectedItems.length,
      }),
      now
    );
  });

  return {
    id: planId,
    case_id: caseId,
    version: nextPlanVersion,
    status: "CONFIRMED",
    items: selectedItems,
    basis_versions: basisVersions,
    confirmed_by: actor.userId,
    confirmed_at: now,
  };
}

export function createMockOrdersFromPlan(
  planId: string,
  actor: ActorContext,
  input: {
    idempotency_key: string;
  }
) {
  ensureSeeded();
  // A20: Only referring clinician can trigger mock orders
  requireRoles(
    actor,
    ["referring_clinician"],
    "Only the responsible referring clinician may trigger simulated test orders (A20)."
  );
  const db = getDb();

  if (!input.idempotency_key || !input.idempotency_key.trim()) {
    throw new DomainError(
      400,
      "Missing idempotency_key for simulated order creation (A21)."
    );
  }

  const plan = db
    .prepare("SELECT * FROM test_plan_versions WHERE id = ?")
    .get(planId) as Record<string, unknown> | undefined;
  if (!plan) {
    throw new DomainError(404, "Test plan version not found.");
  }

  const caseId = String(plan.case_id);
  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow || String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(
      403,
      "Not authorized to create simulated test orders for another organization (A20)."
    );
  }

  if (plan.status !== "CONFIRMED") {
    throw new DomainError(
      409,
      `Test plan is currently in '${String(plan.status)}' state (re-review required before creating simulated orders) (A19).`,
      "PLAN_NOT_CONFIRMED"
    );
  }

  const cleanKey = input.idempotency_key.trim();

  return withTransaction(db, () => {
    // Check idempotency inside transaction (A21)
    const existingForIdempotency = db
      .prepare(
        `
        SELECT mo.*, tc.code as catalog_test_code, tc.name_vi as catalog_test_name, tc.modality
        FROM mock_test_orders mo
        JOIN test_catalog_entries tc ON tc.id = mo.catalog_test_id
        WHERE mo.plan_version_id = ? AND mo.idempotency_key LIKE ?
        ORDER BY mo.id ASC
      `
      )
      .all(planId, `${cleanKey}::%`) as unknown as Array<
      Record<string, unknown>
    >;

    if (existingForIdempotency.length > 0) {
      return {
        plan_id: planId,
        case_id: caseId,
        idempotent_replay: true,
        orders: existingForIdempotency,
        disclaimer:
          "Simulated test orders (MockTestOrder) are for consultation preparation demo only and are not connected to live hospital LIS/RIS.",
      };
    }

    const items = JSON.parse(String(plan.items_json || "[]")) as Array<{
      catalog_test_id: string;
      target_question: string;
    }>;

    const now = new Date().toISOString();
    const createdOrders: Array<Record<string, unknown>> = [];

    items.forEach((item, idx) => {
      const orderId = `MORD-${randomUUID().slice(0, 8).toUpperCase()}`;
      const itemKey = `${cleanKey}::${idx}`;
      db.prepare(
        `
        INSERT INTO mock_test_orders (
          id, case_id, plan_version_id, catalog_test_id, target_question,
          status, idempotency_key, ordered_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?)
      `
      ).run(
        orderId,
        caseId,
        planId,
        item.catalog_test_id,
        item.target_question,
        itemKey,
        actor.userId,
        now,
        now
      );

      const cat = db
        .prepare("SELECT * FROM test_catalog_entries WHERE id = ?")
        .get(item.catalog_test_id) as Record<string, unknown>;

      createdOrders.push({
        id: orderId,
        case_id: caseId,
        plan_version_id: planId,
        catalog_test_id: item.catalog_test_id,
        catalog_test_code: cat?.code,
        catalog_test_name: cat?.name_vi,
        modality: cat?.modality,
        target_question: item.target_question,
        status: "REQUESTED",
        idempotency_key: itemKey,
        ordered_by: actor.userId,
        created_at: now,
      });
    });

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'MOCK_TEST_ORDERS_CREATED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        plan_id: planId,
        order_count: createdOrders.length,
        idempotency_key: cleanKey,
      }),
      now
    );

    return {
      plan_id: planId,
      case_id: caseId,
      idempotent_replay: false,
      orders: createdOrders,
      disclaimer:
        "Simulated test orders (MockTestOrder) are for consultation preparation demo only and are not connected to live hospital LIS/RIS.",
    };
  });
}

export function recordTestResult(
  caseId: string,
  actor: ActorContext,
  input: {
    catalog_test_id: string;
    mock_order_id?: string | null;
    result_summary: string;
    structured_values?: Record<string, unknown>;
    unit_and_lab_note?: string;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow || String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(403, "Not authorized to record test results for this case.");
  }

  if (!input.result_summary || !input.result_summary.trim()) {
    throw new DomainError(422, "Test result summary cannot be empty.");
  }

  const id = `TRES-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO test_results (
        id, case_id, mock_order_id, catalog_test_id, result_summary,
        structured_values_json, source_label, recorded_by, recorded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'CLINICIAN_ENTERED', ?, ?)
    `
    ).run(
      id,
      caseId,
      input.mock_order_id || null,
      input.catalog_test_id,
      input.result_summary.trim(),
      JSON.stringify({
        ...(input.structured_values || {}),
        unit_and_lab_note: input.unit_and_lab_note || "",
      }),
      actor.userId,
      now
    );

    if (input.mock_order_id) {
      db.prepare(
        `
        UPDATE mock_test_orders
        SET status = 'RESULT_AVAILABLE', updated_at = ?
        WHERE id = ? AND case_id = ?
      `
      ).run(now, input.mock_order_id, caseId);
    } else {
      db.prepare(
        `
        UPDATE mock_test_orders
        SET status = 'RESULT_AVAILABLE', updated_at = ?
        WHERE case_id = ? AND catalog_test_id = ? AND status IN ('PLANNED', 'REQUESTED')
      `
      ).run(now, caseId, input.catalog_test_id);
    }

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'TEST_RESULT_RECORDED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        test_result_id: id,
        catalog_test_id: input.catalog_test_id,
      }),
      now
    );
  });

  return {
    id,
    case_id: caseId,
    catalog_test_id: input.catalog_test_id,
    result_summary: input.result_summary.trim(),
    source_label: "CLINICIAN_ENTERED",
    recorded_at: now,
  };
}

export function sendCaseInvitation(
  caseId: string,
  actor: ActorContext,
  input: {
    specialist_id: string;
    fallback_enabled?: boolean;
    fallback_specialist_ids?: string[];
    expires_in_seconds?: number;
  },
  nowDate: Date = new Date()
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  processExpiredInvitations(nowDate);
  const db = getDb();

  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow) {
    throw new DomainError(404, "Case record not found.");
  }
  if (String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(403, "Not authorized to send invitations for another organization's case.");
  }

  // Must have a confirmed ReferralSnapshot (status READY or WAITING_MATCH), NOT blocked by incomplete test plan (A23)
  if (!["READY", "WAITING_MATCH"].includes(String(caseRow.status))) {
    throw new DomainError(
      409,
      `Case is currently in '${String(caseRow.status)}' state. A confirmed ReferralSnapshot (READY/WAITING_MATCH) with no active pending invitation is required before sending a new invitation.`,
      "INVALID_CASE_STATE_FOR_INVITE"
    );
  }

  const existingPending = db
    .prepare(
      "SELECT id FROM invitations WHERE case_id = ? AND status = 'PENDING' LIMIT 1"
    )
    .get(caseId);
  if (existingPending) {
    throw new DomainError(
      409,
      "This case already has a PENDING consultation invitation (only 1 PENDING invitation is allowed at a time).",
      "PENDING_INVITATION_ALREADY_EXISTS"
    );
  }

  const latestSnapshot = db
    .prepare(
      "SELECT * FROM referral_snapshots WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown> | undefined;
  if (!latestSnapshot) {
    throw new DomainError(
      422,
      "Clinician must review and confirm a ReferralSnapshot before sending an invitation (A04).",
      "SNAPSHOT_MISSING"
    );
  }

  // Verify target specialist eligibility via deterministic matching engine (A06, A11)
  const matchResult = computeMatchesForCase(caseId, nowDate);
  const targetCandidate = matchResult.eligible.find(
    (c) => c.user_id === input.specialist_id
  );
  if (!targetCandidate) {
    const inelig = matchResult.ineligible.find(
      (c) => c.user_id === input.specialist_id
    );
    const reasonText = inelig
      ? inelig.ineligible_reasons.join(" ")
      : "Specialist is not in the eligible candidate list.";
    throw new DomainError(
      422,
      `Cannot send invitation to specialist '${input.specialist_id}': ${reasonText}`,
      "SPECIALIST_INELIGIBLE",
      { reasons: inelig?.ineligible_reasons || [reasonText] }
    );
  }

  const eligibleSet = new Set(matchResult.eligible.map((c) => c.user_id));
  const fallbackQueue = (input.fallback_specialist_ids || []).filter(
    (id) => id !== input.specialist_id && eligibleSet.has(id)
  );

  const ttlSeconds = Math.max(
    5,
    Math.min(3600, Number(input.expires_in_seconds ?? 60))
  );
  const nowIso = nowDate.toISOString();
  const expiresAtIso = new Date(
    nowDate.getTime() + ttlSeconds * 1000
  ).toISOString();
  const invId = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;

  const questions = JSON.parse(String(latestSnapshot.questions_json || "[]")) as Array<{
    text: string;
  }>;

  // Minimal preview summary for inbox before acceptance (Section 5.4: no full identity or raw attachments before accept)
  const previewSummary = {
    case_code: String(caseRow.case_code),
    referring_organization: actor.organizationName,
    specialty_requested: String(caseRow.specialty_requested),
    patient_age_band: String(caseRow.patient_age_band),
    patient_sex: String(caseRow.patient_sex),
    brief_title: String(caseRow.title),
    primary_question:
      questions[0]?.text || String(caseRow.clinical_question || ""),
    snapshot_version: Number(latestSnapshot.version),
    urgency_tier: String(caseRow.urgency_tier),
  };

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO invitations (
        id, case_id, snapshot_id, specialist_id, status,
        fallback_enabled, fallback_queue_json, preview_summary_json,
        sent_by, sent_at, expires_at
      ) VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)
    `
    ).run(
      invId,
      caseId,
      String(latestSnapshot.id),
      input.specialist_id,
      input.fallback_enabled ? 1 : 0,
      JSON.stringify(fallbackQueue),
      JSON.stringify(previewSummary),
      actor.userId,
      nowIso,
      expiresAtIso
    );

    db.prepare(
      `
      UPDATE cases
      SET status = 'INVITED',
          invitation_sent_at = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(nowIso, nowIso, caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'INVITATION_SENT', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        invitation_id: invId,
        specialist_id: input.specialist_id,
        fallback_enabled: Boolean(input.fallback_enabled),
        fallback_queue: fallbackQueue,
        expires_at: expiresAtIso,
      }),
      nowIso
    );
  });

  return {
    id: invId,
    case_id: caseId,
    snapshot_id: String(latestSnapshot.id),
    specialist_id: input.specialist_id,
    specialist_name: targetCandidate.display_name,
    status: "PENDING",
    fallback_enabled: Boolean(input.fallback_enabled),
    fallback_queue: fallbackQueue,
    preview_summary: previewSummary,
    sent_at: nowIso,
    expires_at: expiresAtIso,
  };
}

export function listSpecialistInboxInvitations(
  actor: ActorContext,
  nowDate: Date = new Date()
) {
  ensureSeeded();
  processExpiredInvitations(nowDate);
  requireRoles(actor, ["consulting_specialist"]);
  const db = getDb();

  const rows = db
    .prepare(
      `
      SELECT i.*, o.name as referring_organization_name
      FROM invitations i
      JOIN cases c ON c.id = i.case_id
      JOIN organizations o ON o.id = c.organization_id
      WHERE i.specialist_id = ?
      ORDER BY i.sent_at DESC
    `
    )
    .all(actor.userId) as unknown as Array<Record<string, unknown>>;

  const profile = db
    .prepare("SELECT * FROM specialist_profiles WHERE user_id = ?")
    .get(actor.userId) as Record<string, unknown> | undefined;

  const activeCasesCount = (
    db
      .prepare(
        `
        SELECT COUNT(*) as cnt
        FROM consultations con
        JOIN cases cs ON cs.id = con.case_id
        WHERE con.specialist_id = ? AND cs.status IN ('IN_CONSULTATION', 'NEEDS_INFO')
      `
      )
      .get(actor.userId) as { cnt: number }
  ).cnt;

  return {
    specialist_profile: profile
      ? {
          ...profile,
          approved_specialty_codes: JSON.parse(
            String(profile.approved_specialty_codes_json || "[]")
          ),
          approved_topic_tags: JSON.parse(
            String(profile.approved_topic_tags_json || "[]")
          ),
          languages: JSON.parse(String(profile.languages_json || "[]")),
          active_cases: activeCasesCount,
          has_protected_role: actor.hasProtectedNetworkRole,
        }
      : null,
    invitations: rows.map((r) => {
      const consultation = db
        .prepare("SELECT id FROM consultations WHERE invitation_id = ? LIMIT 1")
        .get(String(r.id)) as { id: string } | undefined;

      // Notice: Only minimal preview_summary is returned here; full clinical record requires ACCEPTED consultation!
      return {
        id: String(r.id),
        case_id: String(r.case_id),
        snapshot_id: String(r.snapshot_id),
        status: String(r.status),
        preview_summary: JSON.parse(String(r.preview_summary_json || "{}")),
        referring_organization_name: String(r.referring_organization_name),
        sent_at: String(r.sent_at),
        expires_at: String(r.expires_at),
        responded_at: r.responded_at ? String(r.responded_at) : null,
        decline_reason: r.decline_reason ? String(r.decline_reason) : null,
        consultation_id: consultation?.id || null,
      };
    }),
  };
}

export function acceptInvitation(
  invitationId: string,
  actor: ActorContext,
  nowDate: Date = new Date()
) {
  ensureSeeded();
  requireRoles(actor, ["consulting_specialist"]);
  const db = getDb();

  // Atomic transaction (Section 8, A07)
  return withTransaction(db, () => {
    const nowIso = nowDate.toISOString();

    const inv = db
      .prepare("SELECT * FROM invitations WHERE id = ?")
      .get(invitationId) as Record<string, unknown> | undefined;
    if (!inv) {
      throw new DomainError(404, "Consultation invitation not found.");
    }

    if (String(inv.specialist_id) !== actor.userId) {
      throw new AuthError(
        403,
        "You are not the designated recipient of this consultation invitation (A10).",
        "WRONG_INVITATION_RECIPIENT"
      );
    }

    // Idempotent double-click check: if already ACCEPTED by this specialist, return existing consultation (Section 8)
    if (inv.status === "ACCEPTED") {
      const existingCon = db
        .prepare(
          "SELECT * FROM consultations WHERE invitation_id = ? AND specialist_id = ? LIMIT 1"
        )
        .get(invitationId, actor.userId) as Record<string, unknown> | undefined;
      if (existingCon) {
        return {
          invitation_id: invitationId,
          consultation_id: String(existingCon.id),
          case_id: String(existingCon.case_id),
          status: "ACCEPTED",
          idempotent_replay: true,
        };
      }
    }

    // Check server-side expiry before accepting
    if (
      inv.status === "EXPIRED" ||
      new Date(String(inv.expires_at)).getTime() <= nowDate.getTime()
    ) {
      if (inv.status === "PENDING") {
        db.prepare(
          "UPDATE invitations SET status = 'EXPIRED', responded_at = ? WHERE id = ?"
        ).run(nowIso, invitationId);
      }
      throw new DomainError(
        410,
        "This consultation invitation has expired according to the server clock (410 Gone).",
        "INVITATION_EXPIRED"
      );
    }

    if (inv.status !== "PENDING") {
      throw new DomainError(
        409,
        `Invitation is in '${String(inv.status)}' state and cannot be accepted.`,
        "INVITATION_NOT_PENDING"
      );
    }

    // Verify QEA-protected network_consultant role is still active at accept time (A11)
    if (!actor.hasProtectedNetworkRole) {
      throw new AuthError(
        403,
        "Specialist account does not hold an active Tide QEA-approved 'network_consultant' role.",
        "MISSING_PROTECTED_NETWORK_ROLE"
      );
    }

    const caseId = String(inv.case_id);
    const caseRow = db
      .prepare("SELECT * FROM cases WHERE id = ?")
      .get(caseId) as Record<string, unknown> | undefined;
    if (!caseRow) {
      throw new DomainError(404, "Case record not found.");
    }

    // Atomic check: case must not already have an active consultation (A07)
    const existingCaseCon = db
      .prepare("SELECT * FROM consultations WHERE case_id = ? LIMIT 1")
      .get(caseId) as Record<string, unknown> | undefined;
    if (existingCaseCon || caseRow.status !== "INVITED") {
      throw new DomainError(
        409,
        "Case has already been accepted or is no longer awaiting invitation acceptance (409 Conflict).",
        "CASE_ALREADY_ACCEPTED"
      );
    }

    // Verify capacity and availability at accept time
    const sp = db
      .prepare("SELECT * FROM specialist_profiles WHERE user_id = ?")
      .get(actor.userId) as Record<string, unknown> | undefined;
    if (!sp) {
      throw new DomainError(422, "Specialist profile not found.");
    }

    const activeCases = (
      db
        .prepare(
          `
          SELECT COUNT(*) as cnt
          FROM consultations con
          JOIN cases cs ON cs.id = con.case_id
          WHERE con.specialist_id = ? AND cs.status IN ('IN_CONSULTATION', 'NEEDS_INFO')
        `
        )
        .get(actor.userId) as { cnt: number }
    ).cnt;

    if (activeCases >= Number(sp.max_open_cases)) {
      throw new DomainError(
        409,
        `Maximum open case capacity reached (${activeCases}/${String(sp.max_open_cases)}).`,
        "CAPACITY_EXCEEDED_AT_ACCEPT"
      );
    }

    const conId = `CON-${randomUUID().slice(0, 8).toUpperCase()}`;

    db.prepare(
      `
      UPDATE invitations
      SET status = 'ACCEPTED', responded_at = ?
      WHERE id = ?
    `
    ).run(nowIso, invitationId);

    db.prepare(
      `
      UPDATE cases
      SET status = 'IN_CONSULTATION',
          accepted_specialist_id = ?,
          accepted_at = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(actor.userId, nowIso, nowIso, caseId);

    db.prepare(
      `
      INSERT INTO consultations (
        id, case_id, invitation_id, referring_clinician_id,
        specialist_id, snapshot_id, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      conId,
      caseId,
      invitationId,
      String(caseRow.referring_clinician_id),
      actor.userId,
      String(inv.snapshot_id),
      nowIso
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'INVITATION_ACCEPTED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        invitation_id: invitationId,
        consultation_id: conId,
        accepted_at: nowIso,
      }),
      nowIso
    );

    return {
      invitation_id: invitationId,
      consultation_id: conId,
      case_id: caseId,
      status: "ACCEPTED",
      idempotent_replay: false,
    };
  });
}

export function declineInvitation(
  invitationId: string,
  actor: ActorContext,
  input: { reason?: string } = {},
  nowDate: Date = new Date()
) {
  ensureSeeded();
  requireRoles(actor, ["consulting_specialist"]);
  const db = getDb();

  return withTransaction(db, () => {
    const nowIso = nowDate.toISOString();
    const inv = db
      .prepare("SELECT * FROM invitations WHERE id = ?")
      .get(invitationId) as Record<string, unknown> | undefined;
    if (!inv) {
      throw new DomainError(404, "Consultation invitation not found.");
    }
    if (String(inv.specialist_id) !== actor.userId) {
      throw new AuthError(403, "Not authorized to decline another specialist's invitation.");
    }
    if (inv.status !== "PENDING") {
      throw new DomainError(
        409,
        `Invitation is in '${String(inv.status)}' state and cannot be declined.`
      );
    }

    const caseId = String(inv.case_id);
    db.prepare(
      `
      UPDATE invitations
      SET status = 'DECLINED',
          decline_reason = ?,
          responded_at = ?
      WHERE id = ?
    `
    ).run(
      (input.reason || "Specialist unavailable due to clinical schedule.").trim(),
      nowIso,
      invitationId
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'INVITATION_DECLINED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        invitation_id: invitationId,
        reason: input.reason || "Specialist unavailable due to clinical schedule.",
      }),
      nowIso
    );

    // Check fallback_enabled & fallback_queue (Section 8, A08)
    const fallbackEnabled = Number(inv.fallback_enabled) === 1;
    const fallbackQueue: string[] = JSON.parse(
      String(inv.fallback_queue_json || "[]")
    );

    let fallbackInvitationId: string | null = null;
    let nextSpecialistId: string | null = null;

    if (fallbackEnabled && fallbackQueue.length > 0) {
      const matchResult = computeMatchesForCase(caseId, nowDate);
      const eligibleSet = new Set(matchResult.eligible.map((c) => c.user_id));
      const idx = fallbackQueue.findIndex((id) => eligibleSet.has(id));
      if (idx !== -1) {
        nextSpecialistId = fallbackQueue[idx];
        const remainingQueue = fallbackQueue.slice(idx + 1);
        fallbackInvitationId = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
        const nextExpiresAt = new Date(
          nowDate.getTime() + 60 * 1000
        ).toISOString();

        db.prepare(
          `
          INSERT INTO invitations (
            id, case_id, snapshot_id, specialist_id, status,
            fallback_enabled, fallback_queue_json, preview_summary_json,
            sent_by, sent_at, expires_at
          ) VALUES (?, ?, ?, ?, 'PENDING', 1, ?, ?, ?, ?, ?)
        `
        ).run(
          fallbackInvitationId,
          caseId,
          String(inv.snapshot_id),
          nextSpecialistId,
          JSON.stringify(remainingQueue),
          String(inv.preview_summary_json),
          String(inv.sent_by),
          nowIso,
          nextExpiresAt
        );

        db.prepare(
          `
          UPDATE cases
          SET status = 'INVITED', invitation_sent_at = ?, updated_at = ?
          WHERE id = ?
        `
        ).run(nowIso, nowIso, caseId);
      }
    }

    if (!fallbackInvitationId) {
      db.prepare(
        `
        UPDATE cases
        SET status = 'WAITING_MATCH', updated_at = ?
        WHERE id = ?
      `
      ).run(nowIso, caseId);
    }

    return {
      invitation_id: invitationId,
      status: "DECLINED",
      case_id: caseId,
      case_status: fallbackInvitationId ? "INVITED" : "WAITING_MATCH",
      fallback_triggered: Boolean(fallbackInvitationId),
      fallback_invitation_id: fallbackInvitationId,
      next_specialist_id: nextSpecialistId,
    };
  });
}

export function getConsultationDetail(
  consultationId: string,
  actor: ActorContext
) {
  ensureSeeded();
  processExpiredInvitations();
  const db = getDb();

  const con = db
    .prepare(
      `
      SELECT con.*,
             u_ref.display_name as referring_clinician_name,
             u_ref.title as referring_clinician_title,
             o_ref.name as referring_organization_name,
             u_spec.display_name as specialist_name,
             u_spec.title as specialist_title,
             o_spec.name as specialist_organization_name
      FROM consultations con
      JOIN users u_ref ON u_ref.id = con.referring_clinician_id
      JOIN organizations o_ref ON o_ref.id = u_ref.organization_id
      JOIN users u_spec ON u_spec.id = con.specialist_id
      JOIN organizations o_spec ON o_spec.id = u_spec.organization_id
      WHERE con.id = ? OR con.case_id = ?
      LIMIT 1
    `
    )
    .get(consultationId, consultationId) as Record<string, unknown> | undefined;

  if (!con) {
    throw new DomainError(404, "Consultation room not found.");
  }

  const caseId = String(con.case_id);
  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown>;

  // Strict authorization: only the referring clinician's organization or the accepted specialist can read consultation content (A10)
  if (actor.role === "referring_clinician") {
    if (String(caseRow.organization_id) !== actor.organizationId) {
      throw new AuthError(
        403,
        "You are not authorized to access a consultation room belonging to another organization (A10)."
      );
    }
  } else if (actor.role === "consulting_specialist") {
    if (String(con.specialist_id) !== actor.userId) {
      throw new AuthError(
        403,
        "Only the specialist who accepted this case may access the consultation room (A10)."
      );
    }
    if (!actor.hasProtectedNetworkRole) {
      throw new AuthError(
        403,
        "Cross-organization consultation role (network_consultant) has been revoked or is no longer active (Section 9)."
      );
    }
  } else {
    throw new AuthError(
      403,
      "Coordinators and network administrators are not permitted to view clinical content inside consultation rooms (A10)."
    );
  }

  const realConId = String(con.id);
  const caseDetail = getCaseDetail(caseId, actor);

  const messages = db
    .prepare(
      `
      SELECT m.*, u.display_name as sender_name
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.consultation_id = ?
      ORDER BY m.created_at ASC
    `
    )
    .all(realConId);

  const infoRequests = db
    .prepare(
      `
      SELECT ir.*, u.display_name as requested_by_name
      FROM information_requests ir
      JOIN users u ON u.id = ir.requested_by
      WHERE ir.consultation_id = ?
      ORDER BY ir.created_at DESC
    `
    )
    .all(realConId);

  const responses = db
    .prepare(
      `
      SELECT cr.*, u.display_name as author_name, u.title as author_title
      FROM consultation_responses cr
      JOIN users u ON u.id = cr.author_id
      WHERE cr.consultation_id = ?
      ORDER BY cr.version DESC
    `
    )
    .all(realConId) as unknown as Array<Record<string, unknown>>;

  const activityEvents = db
    .prepare(
      `
      SELECT ae.*, COALESCE(u.display_name, ae.actor_id) as actor_name
      FROM activity_events ae
      LEFT JOIN users u ON u.id = ae.actor_id
      WHERE ae.case_id = ?
      ORDER BY ae.created_at ASC
    `
    )
    .all(caseId) as unknown as Array<Record<string, unknown>>;

  return {
    consultation: con,
    case_detail: caseDetail,
    messages,
    information_requests: infoRequests,
    responses: responses.map((r) => ({
      ...r,
      question_answers: JSON.parse(String(r.question_answers_json || "[]")),
    })),
    activity_events: activityEvents.map((e) => ({
      ...e,
      payload: JSON.parse(String(e.payload_json || "{}")),
    })),
  };
}

export function postConsultationMessage(
  consultationId: string,
  actor: ActorContext,
  input: { body: string }
) {
  ensureSeeded();
  const detail = getConsultationDetail(consultationId, actor);
  const db = getDb();

  if (detail.case_detail.case.status === "CLOSED") {
    throw new DomainError(409, "Case is closed; cannot send additional messages.");
  }
  if (!input.body || !input.body.trim()) {
    throw new DomainError(422, "Message body cannot be empty.");
  }

  const msgId = `MSG-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const realConId = String(detail.consultation.id);
  const caseId = String(detail.consultation.case_id);

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO messages (id, consultation_id, sender_id, sender_role, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(msgId, realConId, actor.userId, actor.role, input.body.trim(), now);

    if (actor.role === "consulting_specialist") {
      db.prepare(
        `
        UPDATE cases
        SET first_specialist_response_at = COALESCE(first_specialist_response_at, ?),
            updated_at = ?
        WHERE id = ?
      `
      ).run(now, now, caseId);
    }
  });

  return {
    id: msgId,
    consultation_id: realConId,
    sender_id: actor.userId,
    sender_name: actor.displayName,
    sender_role: actor.role,
    body: input.body.trim(),
    created_at: now,
  };
}

export function createInformationRequest(
  consultationId: string,
  actor: ActorContext,
  input: { question: string }
) {
  ensureSeeded();
  requireRoles(actor, ["consulting_specialist"]);
  const detail = getConsultationDetail(consultationId, actor);
  const db = getDb();

  if (detail.case_detail.case.status === "CLOSED") {
    throw new DomainError(409, "Case is closed; cannot request additional information.");
  }
  if (!input.question || !input.question.trim()) {
    throw new DomainError(422, "Information request question cannot be empty.");
  }

  const id = `IREQ-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const realConId = String(detail.consultation.id);
  const caseId = String(detail.consultation.case_id);

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO information_requests (
        id, consultation_id, case_id, requested_by, question, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
    `
    ).run(id, realConId, caseId, actor.userId, input.question.trim(), now);

    db.prepare(
      `
      UPDATE cases
      SET status = 'NEEDS_INFO',
          first_specialist_response_at = COALESCE(first_specialist_response_at, ?),
          updated_at = ?
      WHERE id = ?
    `
    ).run(now, now, caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'INFORMATION_REQUESTED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({ info_request_id: id, question: input.question.trim() }),
      now
    );
  });

  return {
    id,
    consultation_id: realConId,
    case_id: caseId,
    question: input.question.trim(),
    status: "OPEN",
    created_at: now,
  };
}

export function respondToInformationRequest(
  infoRequestId: string,
  actor: ActorContext,
  input: {
    response_text: string;
    additional_document?: {
      filename: string;
      content: string;
    };
  }
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const db = getDb();

  const ireq = db
    .prepare("SELECT * FROM information_requests WHERE id = ?")
    .get(infoRequestId) as Record<string, unknown> | undefined;
  if (!ireq) {
    throw new DomainError(404, "Information request not found.");
  }

  const caseId = String(ireq.case_id);
  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;
  if (!caseRow || String(caseRow.organization_id) !== actor.organizationId) {
    throw new AuthError(403, "Not authorized to respond to an information request for another organization.");
  }

  if (!input.response_text || !input.response_text.trim()) {
    throw new DomainError(422, "Supplemental information response cannot be empty.");
  }

  // Optionally attach a supplemental document first
  if (input.additional_document && input.additional_document.content.trim()) {
    addDocumentToCase(caseId, actor, {
      filename: input.additional_document.filename || "supplemental_info.txt",
      doc_type: "INFO_RESPONSE_ATTACHMENT",
      content: input.additional_document.content,
    });
  }

  const freshCase = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown>;
  const prevSnap = db
    .prepare(
      "SELECT * FROM referral_snapshots WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown>;

  const nextSnapVersion = Number(freshCase.snapshot_version) + 1;
  const newSnapId = `SNAP-${caseId}-V${nextSnapVersion}`;
  const now = new Date().toISOString();

  // Create a new ReferralSnapshot version preserving history (Section 9, A09)
  const prevSections = JSON.parse(
    String(prevSnap?.summary_sections_json || "[]")
  ) as Array<{
    key: string;
    title: string;
    claims: Array<Record<string, unknown>>;
  }>;

  const updatedSections = prevSections.map((sec) => {
    if (sec.key === "available_data" || sec.key === "clinical_course") {
      return {
        ...sec,
        claims: [
          ...sec.claims,
          {
            id: `CLM-SUPP-V${nextSnapVersion}`,
            text: `[Supplemental Update v${nextSnapVersion}]: ${input.response_text.trim()}`,
            source_refs: [],
            provenance: "CLINICIAN_EDIT",
          },
        ],
      };
    }
    return sec;
  });

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO referral_snapshots (
        id, case_id, version, input_version, preparation_run_id,
        summary_sections_json, unknowns_json, contradictions_json,
        questions_json, selected_specialties_json, manual_edits_json,
        confirmed_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      newSnapId,
      caseId,
      nextSnapVersion,
      Number(freshCase.input_version),
      prevSnap?.preparation_run_id ? String(prevSnap.preparation_run_id) : null,
      JSON.stringify(updatedSections),
      String(prevSnap?.unknowns_json || "[]"),
      String(prevSnap?.contradictions_json || "[]"),
      String(prevSnap?.questions_json || "[]"),
      String(prevSnap?.selected_specialties_json || "[]"),
      JSON.stringify([
        ...JSON.parse(String(prevSnap?.manual_edits_json || "[]")),
        {
          field: "information_response",
          action: "AMEND_SNAPSHOT",
          note: input.response_text.trim(),
          at: now,
        },
      ]),
      actor.userId,
      now
    );

    db.prepare(
      `
      UPDATE information_requests
      SET status = 'RESPONDED',
          response_text = ?,
          response_snapshot_id = ?,
          responded_at = ?
      WHERE id = ?
    `
    ).run(input.response_text.trim(), newSnapId, now, infoRequestId);

    db.prepare(
      `
      UPDATE consultations
      SET snapshot_id = ?
      WHERE id = ?
    `
    ).run(newSnapId, String(ireq.consultation_id));

    db.prepare(
      `
      UPDATE cases
      SET status = 'IN_CONSULTATION',
          snapshot_version = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(nextSnapVersion, now, caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'INFORMATION_REQUEST_RESPONDED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        info_request_id: infoRequestId,
        new_snapshot_id: newSnapId,
        new_snapshot_version: nextSnapVersion,
      }),
      now
    );
  });

  return {
    info_request_id: infoRequestId,
    status: "RESPONDED",
    new_snapshot_id: newSnapId,
    new_snapshot_version: nextSnapVersion,
    case_status: "IN_CONSULTATION",
    responded_at: now,
  };
}

export function submitConsultationResponse(
  consultationId: string,
  actor: ActorContext,
  input: {
    question_answers: Array<{
      question_id: string;
      question_text: string;
      answer: string;
    }>;
    clinical_recommendations: string;
    limitations: string;
    is_demo_sample?: boolean;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["consulting_specialist"]);
  const detail = getConsultationDetail(consultationId, actor);
  const db = getDb();

  if (detail.case_detail.case.status === "CLOSED") {
    throw new DomainError(409, "Case is closed; cannot submit a new consultation response.");
  }

  if (
    !input.clinical_recommendations ||
    input.clinical_recommendations.trim().length < 10
  ) {
    throw new DomainError(
      422,
      "Specialist clinical recommendations must be provided (minimum 10 characters)."
    );
  }

  const realConId = String(detail.consultation.id);
  const caseId = String(detail.consultation.case_id);

  const maxVerRow = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_v FROM consultation_responses WHERE consultation_id = ?"
    )
    .get(realConId) as { max_v: number };
  const nextVersion = Number(maxVerRow.max_v) + 1;
  const respId = `RESP-${caseId}-V${nextVersion}`;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO consultation_responses (
        id, consultation_id, author_id, question_answers_json,
        clinical_recommendations, limitations, is_demo_sample, version, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      respId,
      realConId,
      actor.userId,
      JSON.stringify(input.question_answers || []),
      input.clinical_recommendations.trim(),
      (
        input.limitations ||
        "Recommendations are based on structured text records provided by the referring clinic; correlate with direct bedside examination."
      ).trim(),
      input.is_demo_sample ? 1 : 0,
      nextVersion,
      now
    );

    db.prepare(
      `
      UPDATE cases
      SET status = 'ANSWERED',
          first_specialist_response_at = COALESCE(first_specialist_response_at, ?),
          answered_at = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(now, now, now, caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'CONSULTATION_RESPONSE_SUBMITTED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        response_id: respId,
        version: nextVersion,
        is_demo_sample: Boolean(input.is_demo_sample),
      }),
      now
    );
  });

  return {
    id: respId,
    consultation_id: realConId,
    case_id: caseId,
    version: nextVersion,
    case_status: "ANSWERED",
    submitted_at: now,
  };
}

export function closeConsultationCase(
  consultationId: string,
  actor: ActorContext,
  input: { closure_note?: string } = {}
) {
  ensureSeeded();
  requireRoles(actor, ["referring_clinician"]);
  const detail = getConsultationDetail(consultationId, actor);
  const db = getDb();

  const realConId = String(detail.consultation.id);
  const caseId = String(detail.consultation.case_id);
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      UPDATE consultations
      SET closed_at = ?
      WHERE id = ?
    `
    ).run(now, realConId);

    db.prepare(
      `
      UPDATE cases
      SET status = 'CLOSED',
          closed_at = ?,
          updated_at = ?
      WHERE id = ?
    `
    ).run(now, now, caseId);

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, 'CASE_CLOSED', ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      JSON.stringify({
        consultation_id: realConId,
        closure_note: input.closure_note || "Acknowledged specialist response and closed consultation case.",
      }),
      now
    );
  });

  return {
    consultation_id: realConId,
    case_id: caseId,
    case_status: "CLOSED",
    closed_at: now,
  };
}

export function updateSpecialistAvailability(
  actor: ActorContext,
  input: {
    availability_state: "AVAILABLE" | "SCHEDULED" | "BUSY" | "PAUSED";
    expires_in_minutes?: number;
  }
) {
  ensureSeeded();
  requireRoles(actor, ["consulting_specialist"]);
  const db = getDb();

  const now = new Date();
  const nowIso = now.toISOString();
  const expiresMinutes = Math.max(
    5,
    Math.min(1440, Number(input.expires_in_minutes ?? 240))
  );
  const expiresIso = new Date(
    now.getTime() + expiresMinutes * 60000
  ).toISOString();

  db.prepare(
    `
    UPDATE specialist_profiles
    SET availability_state = ?,
        availability_updated_at = ?,
        availability_expires_at = ?
    WHERE user_id = ?
  `
  ).run(input.availability_state, nowIso, expiresIso, actor.userId);

  return {
    user_id: actor.userId,
    availability_state: input.availability_state,
    availability_updated_at: nowIso,
    availability_expires_at: expiresIso,
  };
}
