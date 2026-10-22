import { getDb } from "./db";
import type {
  AvailabilityState,
  SpecialistMatchCandidate,
  SpecialtyCode,
} from "./types";
import { SPECIALTY_LABELS } from "./types";

interface DbSpecialistRow {
  user_id: string;
  display_name: string;
  title: string;
  organization_id: string;
  organization_name: string;
  tide_roles_json: string;
  approved_specialty_codes_json: string;
  approved_topic_tags_json: string;
  languages_json: string;
  availability_state: AvailabilityState;
  availability_updated_at: string;
  availability_expires_at: string;
  max_open_cases: number;
}

export function getActiveConsultationCount(specialistId: string): number {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT COUNT(*) as cnt
      FROM consultations c
      JOIN cases cs ON cs.id = c.case_id
      WHERE c.specialist_id = ?
        AND cs.status IN ('IN_CONSULTATION', 'NEEDS_INFO')
    `
    )
    .get(specialistId) as { cnt: number };
  return Number(row?.cnt || 0);
}

export function computeMatchesForCase(
  caseId: string,
  nowDate: Date = new Date()
): {
  case_id: string;
  primary_specialty: SpecialtyCode;
  accepted_specialties: SpecialtyCode[];
  case_topic_tags: string[];
  eligible: SpecialistMatchCandidate[];
  ineligible: SpecialistMatchCandidate[];
  computed_at: string;
  disclaimer: string;
} {
  const db = getDb();
  const caseRow = db
    .prepare("SELECT * FROM cases WHERE id = ?")
    .get(caseId) as Record<string, unknown> | undefined;

  if (!caseRow) {
    const err = new Error("Case record not found.") as Error & {
      status: number;
    };
    err.status = 404;
    throw err;
  }

  const latestSnapshot = db
    .prepare(
      "SELECT * FROM referral_snapshots WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown> | undefined;

  const primarySpecialty = (caseRow.specialty_requested ||
    "RESPIRATORY") as SpecialtyCode;

  let acceptedSpecialties: SpecialtyCode[] = [primarySpecialty];
  if (latestSnapshot?.selected_specialties_json) {
    const parsed = JSON.parse(
      String(latestSnapshot.selected_specialties_json)
    ) as SpecialtyCode[];
    if (parsed.length > 0) {
      acceptedSpecialties = parsed;
    }
  } else if (caseRow.secondary_specialties_json) {
    const sec = JSON.parse(
      String(caseRow.secondary_specialties_json)
    ) as SpecialtyCode[];
    acceptedSpecialties = Array.from(new Set([primarySpecialty, ...sec]));
  }

  const caseTopicTags: string[] = caseRow.topic_tags_json
    ? JSON.parse(String(caseRow.topic_tags_json))
    : [];

  const requiredLanguage = String(caseRow.language_required || "vi");
  const referringOrgId = String(caseRow.organization_id);
  const referringClinicianId = String(caseRow.referring_clinician_id);

  // Active network agreements for referringOrgId
  const agreements = db
    .prepare(
      `
      SELECT * FROM network_agreements
      WHERE source_org_id = ? AND status = 'ACTIVE'
    `
    )
    .all(referringOrgId) as unknown as Array<{
    target_org_id: string;
    allowed_specialties_json: string;
  }>;
  const agreementsByTargetOrg = new Map<string, SpecialtyCode[]>();
  for (const ag of agreements) {
    agreementsByTargetOrg.set(
      ag.target_org_id,
      JSON.parse(ag.allowed_specialties_json || "[]")
    );
  }

  // Specialists who already declined or expired in the current round for this case
  const declinedOrExpiredRows = db
    .prepare(
      `
      SELECT specialist_id, status
      FROM invitations
      WHERE case_id = ? AND status IN ('DECLINED', 'EXPIRED')
    `
    )
    .all(caseId) as unknown as Array<{
    specialist_id: string;
    status: string;
  }>;
  const previousAttemptStatus = new Map<string, string>();
  for (const r of declinedOrExpiredRows) {
    previousAttemptStatus.set(r.specialist_id, r.status);
  }

  // Pending governance links (for clearer explanation when network_consultant is missing)
  const pendingGovRows = db
    .prepare(
      `
      SELECT target_user_id, tide_change_request_id, approvals_observed, threshold_observed
      FROM governance_links
      WHERE role_name = 'network_consultant' AND last_observed_status = 'PENDING'
    `
    )
    .all() as unknown as Array<{
    target_user_id: string;
    tide_change_request_id: string;
    approvals_observed: number;
    threshold_observed: number;
  }>;
  const pendingGovByUser = new Map(
    pendingGovRows.map((g) => [g.target_user_id, g])
  );

  // Load all specialist profiles
  const specialists = db
    .prepare(
      `
      SELECT
        u.id as user_id,
        u.display_name,
        u.title,
        u.organization_id,
        o.name as organization_name,
        u.tide_roles_json,
        sp.approved_specialty_codes_json,
        sp.approved_topic_tags_json,
        sp.languages_json,
        sp.availability_state,
        sp.availability_updated_at,
        sp.availability_expires_at,
        sp.max_open_cases
      FROM specialist_profiles sp
      JOIN users u ON u.id = sp.user_id
      JOIN organizations o ON o.id = u.organization_id
      ORDER BY u.id ASC
    `
    )
    .all() as unknown as DbSpecialistRow[];

  const eligible: SpecialistMatchCandidate[] = [];
  const ineligible: SpecialistMatchCandidate[] = [];

  for (const sp of specialists) {
    const tideRoles: string[] = JSON.parse(sp.tide_roles_json || "[]");
    const hasProtectedRole = tideRoles.includes("network_consultant");
    const approvedSpecialties: SpecialtyCode[] = JSON.parse(
      sp.approved_specialty_codes_json || "[]"
    );
    const approvedTopics: string[] = JSON.parse(
      sp.approved_topic_tags_json || "[]"
    );
    const languages: string[] = JSON.parse(sp.languages_json || "[]");
    const activeCases = getActiveConsultationCount(sp.user_id);
    const maxOpenCases = Math.max(1, Number(sp.max_open_cases || 1));

    const ineligibleReasons: string[] = [];

    // 1. Not the referring clinician themselves
    if (sp.user_id === referringClinicianId) {
      ineligibleReasons.push(
        "Cannot self-accept a consultation referred by the same clinician."
      );
    }

    // 2. Protected QEA role check (network_consultant)
    if (!hasProtectedRole) {
      const gov = pendingGovByUser.get(sp.user_id);
      if (gov) {
        ineligibleReasons.push(
          `Missing cross-organization consultation role (network_consultant) — Tide QEA request #${gov.tide_change_request_id} is PENDING (${gov.approvals_observed}/${gov.threshold_observed} admin signatures).`
        );
      } else {
        ineligibleReasons.push(
          "Not granted the Tide QEA-protected cross-organization role (network_consultant)."
        );
      }
    }

    // 3. Organization agreement check
    const allowedAgreementSpecialties = agreementsByTargetOrg.get(
      sp.organization_id
    );
    if (!allowedAgreementSpecialties) {
      ineligibleReasons.push(
        `Organization '${sp.organization_name}' does not have an active consultation agreement with the referring clinic.`
      );
    } else {
      const hasAllowedSpecialtyInAgreement = acceptedSpecialties.some((code) =>
        allowedAgreementSpecialties.includes(code)
      );
      if (!hasAllowedSpecialtyInAgreement) {
        ineligibleReasons.push(
          `Inter-facility agreement does not cover requested specialty (${acceptedSpecialties
            .map((c) => SPECIALTY_LABELS[c] || c)
            .join(", ")}).`
        );
      }
    }

    // 4. Approved specialty match
    const matchedSpecialties = acceptedSpecialties.filter((code) =>
      approvedSpecialties.includes(code)
    );
    if (matchedSpecialties.length === 0) {
      ineligibleReasons.push(
        `Approved specialties (${approvedSpecialties
          .map((c) => SPECIALTY_LABELS[c] || c)
          .join(", ")}) do not match the case requirement (${acceptedSpecialties
          .map((c) => SPECIALTY_LABELS[c] || c)
          .join(", ")}).`
      );
    }

    // 5. Language check
    if (!languages.includes(requiredLanguage)) {
      ineligibleReasons.push(
        `Does not support the required consultation language (${requiredLanguage}).`
      );
    }

    // 6. Availability state & expiry
    const expiresAtDate = new Date(sp.availability_expires_at);
    if (
      sp.availability_state === "PAUSED" ||
      sp.availability_state === "BUSY"
    ) {
      ineligibleReasons.push(
        `Current schedule state is '${sp.availability_state}' (paused or busy).`
      );
    } else if (
      Number.isNaN(expiresAtDate.getTime()) ||
      expiresAtDate.getTime() <= nowDate.getTime()
    ) {
      ineligibleReasons.push(
        `Declared availability window expired at ${sp.availability_expires_at}.`
      );
    }

    // 7. Capacity check
    if (activeCases >= maxOpenCases) {
      ineligibleReasons.push(
        `Maximum open case capacity reached (${activeCases}/${maxOpenCases} active cases).`
      );
    }

    // 8. Previous decline/expiry in current round
    const prevAttempt = previousAttemptStatus.get(sp.user_id);
    if (prevAttempt) {
      ineligibleReasons.push(
        `Already ${
          prevAttempt === "DECLINED" ? "declined" : "timed out"
        } in the current routing round for this case.`
      );
    }

    if (ineligibleReasons.length > 0) {
      ineligible.push({
        user_id: sp.user_id,
        display_name: sp.display_name,
        title: sp.title,
        organization_id: sp.organization_id,
        organization_name: sp.organization_name,
        approved_specialty_codes: approvedSpecialties,
        approved_topic_tags: approvedTopics,
        languages,
        availability_state: sp.availability_state,
        availability_updated_at: sp.availability_updated_at,
        availability_expires_at: sp.availability_expires_at,
        active_cases: activeCases,
        max_open_cases: maxOpenCases,
        has_protected_role: hasProtectedRole,
        eligible: false,
        ineligible_reasons: ineligibleReasons,
        score: null,
        score_breakdown: null,
        ranking_reasons: [],
      });
      continue;
    }

    // Deterministic ranking formula (Section 7):
    // score = 40 * specialty_fit + 30 * availability_fit + 20 * remaining_capacity_ratio + 10 * approved_topic_fit
    const isPrimaryMatch = approvedSpecialties.includes(primarySpecialty);
    const specialtyFit = isPrimaryMatch ? 1.0 : 0.6;

    const availabilityFit =
      sp.availability_state === "AVAILABLE" ? 1.0 : 0.6;

    const remainingCapacityRatio = Math.max(
      0,
      (maxOpenCases - activeCases) / maxOpenCases
    );

    let approvedTopicFit = 0;
    const matchedTopics = caseTopicTags.filter((t) =>
      approvedTopics.includes(t)
    );
    if (caseTopicTags.length > 0) {
      approvedTopicFit = matchedTopics.length / caseTopicTags.length;
    } else if (approvedTopics.length > 0) {
      approvedTopicFit = 0.5;
    }

    const rawScore =
      40 * specialtyFit +
      30 * availabilityFit +
      20 * remainingCapacityRatio +
      10 * approvedTopicFit;
    const score = Number(rawScore.toFixed(1));

    const rankingReasons: string[] = [
      isPrimaryMatch
        ? `Matches primary specialty: ${SPECIALTY_LABELS[primarySpecialty]} (+${(
            40 * specialtyFit
          ).toFixed(1)} pts)`
        : `Matches secondary specialty (+${(40 * specialtyFit).toFixed(1)} pts)`,
      `Availability status '${sp.availability_state}' valid until ${new Date(
        sp.availability_expires_at
      ).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })} (+${(30 * availabilityFit).toFixed(1)} pts)`,
      `Remaining case capacity: ${maxOpenCases - activeCases}/${maxOpenCases} open slots (+${(
        20 * remainingCapacityRatio
      ).toFixed(1)} pts)`,
      `Clinical topic overlap (${matchedTopics.length}/${Math.max(
        1,
        caseTopicTags.length
      )}): ${matchedTopics.join(", ") || "general"} (+${(
        10 * approvedTopicFit
      ).toFixed(1)} pts)`,
      `Verified Tide QEA role 'network_consultant' & active inter-facility agreement`,
    ];

    eligible.push({
      user_id: sp.user_id,
      display_name: sp.display_name,
      title: sp.title,
      organization_id: sp.organization_id,
      organization_name: sp.organization_name,
      approved_specialty_codes: approvedSpecialties,
      approved_topic_tags: approvedTopics,
      languages,
      availability_state: sp.availability_state,
      availability_updated_at: sp.availability_updated_at,
      availability_expires_at: sp.availability_expires_at,
      active_cases: activeCases,
      max_open_cases: maxOpenCases,
      has_protected_role: hasProtectedRole,
      eligible: true,
      ineligible_reasons: [],
      score,
      score_breakdown: {
        specialty_fit: Number((40 * specialtyFit).toFixed(1)),
        availability_fit: Number((30 * availabilityFit).toFixed(1)),
        remaining_capacity_ratio: Number(
          (20 * remainingCapacityRatio).toFixed(1)
        ),
        approved_topic_fit: Number((10 * approvedTopicFit).toFixed(1)),
      },
      ranking_reasons: rankingReasons,
    });
  }

  // Sort eligible by score DESC, then tie-break by user_id ASC
  eligible.sort((a, b) => {
    const diff = (b.score ?? 0) - (a.score ?? 0);
    if (Math.abs(diff) > 0.001) return diff;
    return a.user_id.localeCompare(b.user_id);
  });

  return {
    case_id: caseId,
    primary_specialty: primarySpecialty,
    accepted_specialties: acceptedSpecialties,
    case_topic_tags: caseTopicTags,
    eligible,
    ineligible,
    computed_at: nowDate.toISOString(),
    disclaimer:
      "Rankings are computed deterministically from Tide QEA-governed credentials, inter-facility agreements, live capacity, and specialty fit — never black-box clinical quality scores.",
  };
}
