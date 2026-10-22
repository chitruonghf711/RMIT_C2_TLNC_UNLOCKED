import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getDb, withTransaction } from "../db";
import type {
  AIContractOutput,
  DuplicateStatus,
  ExistingTestRef,
  GenerationBasisVersions,
  GuidelineRef,
  PatientEvidenceRef,
  SourceRef,
  TestSuggestionDTO,
} from "../types";
import type { ActorContext } from "../auth/session";
import { requireRoles } from "../auth/session";

export class ValidationError extends Error {
  status = 422;
  code: string;
  details?: unknown;
  constructor(message: string, code = "VALIDATION_ERROR", details?: unknown) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

export const SourceRefSchema = z.object({
  document_id: z.string().min(1),
  version: z.number().int().positive(),
  segment_id: z.string().min(1),
});

export const SummaryClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source_refs: z.array(SourceRefSchema).min(1),
  provenance: z.enum(["AI_DRAFT", "CLINICIAN_EDIT", "SOURCE_EXTRACT"]),
});

export const SummarySectionSchema = z.object({
  key: z.enum([
    "reason_for_consult",
    "clinical_course",
    "relevant_context",
    "available_data",
  ]),
  title: z.string().min(1),
  claims: z.array(SummaryClaimSchema),
});

export const UnknownItemSchema = z.object({
  field: z.string().min(1),
  label: z.string().min(1),
  reason: z.string().min(1),
  provenance: z.enum(["AI_DRAFT", "CLINICIAN_EDIT", "SOURCE_EXTRACT"]),
});

export const ContradictionItemSchema = z.object({
  topic: z.string().min(1),
  description: z.string().min(1),
  source_refs: z.array(SourceRefSchema).min(1),
});

export const QuestionDraftSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  rationale: z.string().optional(),
  source_refs: z.array(SourceRefSchema).min(1),
  provenance: z.enum(["AI_DRAFT", "CLINICIAN_EDIT", "SOURCE_EXTRACT"]),
  selected: z.boolean().optional(),
});

export const SpecialtyCandidateSchema = z.object({
  code: z.enum([
    "RESPIRATORY",
    "CARDIOLOGY",
    "INTERNAL_MEDICINE",
    "ENDOCRINOLOGY",
    "INFECTIOUS_DISEASE",
  ]),
  reason: z.string().min(1),
  certainty: z.enum(["clear", "uncertain"]),
  source_refs: z.array(SourceRefSchema).min(1),
});

export const AIContractOutputSchema = z.object({
  case_id: z.string().min(1),
  input_version: z.number().int().positive(),
  summary_sections: z.array(SummarySectionSchema).min(1),
  unknowns: z.array(UnknownItemSchema),
  contradictions: z.array(ContradictionItemSchema),
  question_drafts: z.array(QuestionDraftSchema).min(1),
  clarification_required: z.boolean().optional(),
  clarification_prompt: z.string().optional(),
  clarification_options: z.array(z.string()).optional(),
  specialty_candidates: z.array(SpecialtyCandidateSchema).min(1),
  needs_clinician_review: z.boolean(),
  citation_validation_errors: z.array(z.string()).optional(),
  prompt_injection_warnings: z.array(z.string()).optional(),
});

interface DbDocRow {
  id: string;
  case_id: string;
  version: number;
  filename: string;
  doc_type: string;
  extracted_text: string;
  segments_json: string;
}

export function validateCitationRefsAgainstDocs(
  refs: SourceRef[],
  docs: DbDocRow[]
): string[] {
  const errors: string[] = [];
  const validKeys = new Set<string>();
  for (const doc of docs) {
    const segments = JSON.parse(doc.segments_json || "[]") as Array<{
      segment_id: string;
    }>;
    for (const seg of segments) {
      validKeys.add(`${doc.id}::${doc.version}::${seg.segment_id}`);
    }
  }
  for (const ref of refs) {
    const key = `${ref.document_id}::${ref.version}::${ref.segment_id}`;
    if (!validKeys.has(key)) {
      errors.push(
        `Source citation does not exist in current document versions: ${ref.document_id} v${ref.version} #${ref.segment_id}`
      );
    }
  }
  return errors;
}

export function isVagueReferralQuestion(
  question: string | null | undefined
): boolean {
  const q = (question || "").trim().toLowerCase();
  if (q.length < 28) return true;
  const vaguePhrases = [
    "please advise",
    "need specialist input",
    "requesting consultation",
    "please review",
    "second opinion",
    "next steps?",
  ];
  if (vaguePhrases.some((p) => q === p || (q.includes(p) && q.length < 55))) {
    return true;
  }
  return false;
}

export interface PrepareCaseOptions {
  mode?: "fixture" | "live";
  customOutputOverride?: Partial<AIContractOutput>;
  strictRejectInvalidCitations?: boolean;
}

export function prepareCase(
  caseId: string,
  actor: ActorContext,
  options: PrepareCaseOptions = {}
) {
  requireRoles(actor, ["referring_clinician"]);
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
  if (caseRow.organization_id !== actor.organizationId) {
    const err = new Error(
      "You are only authorized to run AI preparation for cases belonging to your own organization."
    ) as Error & { status: number };
    err.status = 403;
    throw err;
  }

  const docs = db
    .prepare(
      "SELECT * FROM document_versions WHERE case_id = ? ORDER BY version ASC, id ASC"
    )
    .all(caseId) as unknown as DbDocRow[];

  if (docs.length === 0) {
    throw new ValidationError(
      "At least 1 clinical document must be uploaded before running AI preparation.",
      "NO_DOCUMENTS"
    );
  }

  const inputVersion = Number(caseRow.input_version || 1);
  const rawQuestion = String(caseRow.clinical_question || "");
  const clarificationRequired = isVagueReferralQuestion(rawQuestion);

  // Scan all segments for prompt injection attempts (A14)
  const injectionWarnings: string[] = [];
  const safeSegmentsByDoc = new Map<
    string,
    Array<{
      document_id: string;
      version: number;
      segment_id: string;
      text: string;
      suspicious: boolean;
    }>
  >();

  for (const doc of docs) {
    const segs = JSON.parse(doc.segments_json || "[]") as Array<{
      segment_id: string;
      text: string;
      suspicious_instruction_detected?: boolean;
    }>;
    const mapped = segs.map((s) => {
      const suspicious = Boolean(
        s.suspicious_instruction_detected ||
          /ignore all|system override|bypass qea|grant.*network_consultant|diagnosis is certain no tests needed/i.test(
            s.text
          )
      );
      if (suspicious) {
        injectionWarnings.push(
          `Suspicious instruction detected (${doc.id} #${s.segment_id}): Quarantined as untrusted source text; embedded directive was not executed.`
        );
      }
      return {
        document_id: doc.id,
        version: doc.version,
        segment_id: s.segment_id,
        text: s.text,
        suspicious,
      };
    });
    safeSegmentsByDoc.set(doc.id, mapped);
  }

  let draftOutput: AIContractOutput;

  if (options.customOutputOverride) {
    draftOutput = {
      case_id: caseId,
      input_version: inputVersion,
      summary_sections: options.customOutputOverride.summary_sections || [],
      unknowns: options.customOutputOverride.unknowns || [],
      contradictions: options.customOutputOverride.contradictions || [],
      question_drafts: options.customOutputOverride.question_drafts || [],
      clarification_required:
        options.customOutputOverride.clarification_required ??
        clarificationRequired,
      clarification_prompt: options.customOutputOverride.clarification_prompt,
      clarification_options: options.customOutputOverride.clarification_options,
      specialty_candidates:
        options.customOutputOverride.specialty_candidates || [],
      needs_clinician_review: true,
      prompt_injection_warnings: injectionWarnings,
    };
  } else {
    draftOutput = buildDeterministicGroundedOutput(
      caseId,
      inputVersion,
      caseRow,
      docs,
      safeSegmentsByDoc,
      clarificationRequired,
      injectionWarnings
    );
  }

  // 1. Validate schema
  const schemaParse = AIContractOutputSchema.safeParse(draftOutput);
  if (!schemaParse.success) {
    throw new ValidationError(
      "AI output failed mandatory schema validation. Manual clinician review is required.",
      "AI_SCHEMA_INVALID",
      schemaParse.error.flatten()
    );
  }

  // 2. Collect all source_refs across claims, contradictions, questions, and specialty_candidates
  const allRefs: SourceRef[] = [];
  for (const sec of draftOutput.summary_sections) {
    for (const claim of sec.claims) {
      allRefs.push(...claim.source_refs);
    }
  }
  for (const c of draftOutput.contradictions) {
    allRefs.push(...c.source_refs);
  }
  for (const q of draftOutput.question_drafts) {
    allRefs.push(...q.source_refs);
  }
  for (const sc of draftOutput.specialty_candidates) {
    allRefs.push(...sc.source_refs);
  }

  const citationErrors = validateCitationRefsAgainstDocs(allRefs, docs);
  if (citationErrors.length > 0) {
    draftOutput.citation_validation_errors = citationErrors;
    draftOutput.needs_clinician_review = true;
    const runId = `PREP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const now = new Date().toISOString();
    db.prepare(
      `
      INSERT INTO preparation_runs (id, case_id, input_version, adapter_mode, status, output_json, validation_errors_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      runId,
      caseId,
      inputVersion,
      options.mode === "live" ? "LIVE_LLM" : "FIXTURE_SIMULATED",
      "REJECTED_INVALID_CITATIONS",
      JSON.stringify(draftOutput),
      JSON.stringify(citationErrors),
      actor.userId,
      now
    );

    throw new ValidationError(
      `Rejected AI draft due to invalid source citations (${citationErrors.join("; ")}). Clinician review required.`,
      "INVALID_AI_CITATIONS",
      { runId, citationErrors }
    );
  }

  const runId = `PREP-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO preparation_runs (id, case_id, input_version, adapter_mode, status, output_json, validation_errors_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      runId,
      caseId,
      inputVersion,
      options.mode === "live" ? "LIVE_LLM" : "FIXTURE_SIMULATED",
      "VALIDATED_NEEDS_REVIEW",
      JSON.stringify(draftOutput),
      JSON.stringify([]),
      actor.userId,
      now
    );

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      "PREPARATION_RUN_COMPLETED",
      JSON.stringify({
        run_id: runId,
        input_version: inputVersion,
        adapter_mode:
          options.mode === "live" ? "LIVE_LLM" : "FIXTURE_SIMULATED",
        prompt_injection_warnings: injectionWarnings,
      }),
      now
    );
  });

  return {
    id: runId,
    case_id: caseId,
    input_version: inputVersion,
    adapter_mode: options.mode === "live" ? "LIVE_LLM" : "FIXTURE_SIMULATED",
    status: "VALIDATED_NEEDS_REVIEW",
    output: draftOutput,
    created_at: now,
  };
}

function buildDeterministicGroundedOutput(
  caseId: string,
  inputVersion: number,
  caseRow: Record<string, unknown>,
  docs: DbDocRow[],
  safeSegmentsByDoc: Map<
    string,
    Array<{
      document_id: string;
      version: number;
      segment_id: string;
      text: string;
      suspicious: boolean;
    }>
  >,
  clarificationRequired: boolean,
  injectionWarnings: string[]
): AIContractOutput {
  const allSafeSegs = Array.from(safeSegmentsByDoc.values())
    .flat()
    .filter((s) => !s.suspicious);

  const firstSeg = allSafeSegs[0] || {
    document_id: docs[0].id,
    version: docs[0].version,
    segment_id: "S-001",
    text: docs[0].extracted_text.slice(0, 120),
    suspicious: false,
  };

  const refOf = (idx: number): SourceRef => {
    const target =
      allSafeSegs[Math.min(idx, allSafeSegs.length - 1)] || firstSeg;
    return {
      document_id: target.document_id,
      version: target.version,
      segment_id: target.segment_id,
    };
  };

  const fullTextLower = allSafeSegs
    .map((s) => s.text.toLowerCase())
    .join("\n");

  const isCardioOverlap =
    fullTextLower.includes("edema") ||
    fullTextLower.includes("heart") ||
    fullTextLower.includes("nt-probnp") ||
    fullTextLower.includes("hypertension");

  // Unknowns: strictly facts missing from the uploaded record, never test orders
  const unknowns = [
    {
      field: "adherence_and_inhaler_technique",
      label: "Medication adherence & inhaler technique verification",
      reason:
        "No direct observation of inhaler technique or missed doses over the past 4 weeks is documented in the source notes.",
      provenance: "AI_DRAFT" as const,
    },
    {
      field: "prior_baseline_imaging_comparison",
      label: "Prior chest imaging film from 6 months ago",
      reason:
        "Patient mentioned a chest X-ray performed 6 months ago at an external clinic, but the prior film is not yet attached for comparison.",
      provenance: "AI_DRAFT" as const,
    },
  ];
  if (
    !fullTextLower.includes("spirometry") ||
    fullTextLower.includes("not yet performed")
  ) {
    unknowns.push({
      field: "recent_spirometry_post_bd",
      label: "Recent post-bronchodilator spirometry parameters",
      reason:
        "Objective FEV1/FVC ratio and bronchodilator reversibility from the last 6 months are not yet available in the record.",
      provenance: "AI_DRAFT" as const,
    });
  }

  // Contradictions
  const contradictions = [];
  if (allSafeSegs.length >= 2) {
    contradictions.push({
      topic: "Symptom persistence vs. current outpatient therapy response",
      description:
        "Exertional dyspnea and subacute cough persist despite outpatient maintenance inhaler and empiric oral antibiotic therapy.",
      source_refs: [refOf(0), refOf(1)],
    });
  }

  const summarySections: AIContractOutput["summary_sections"] = [
    {
      key: "reason_for_consult",
      title: "1. Reason for Consultation",
      claims: [
        {
          id: "CLM-1",
          text: `${String(caseRow.title || "Specialist consultation case")}: ${firstSeg.text}`,
          source_refs: [refOf(0)],
          provenance: "AI_DRAFT",
        },
      ],
    },
    {
      key: "clinical_course",
      title: "2. Clinical Course & Prior Management",
      claims: allSafeSegs.slice(1, 3).map((seg, i) => ({
        id: `CLM-2-${i + 1}`,
        text: seg.text,
        source_refs: [
          {
            document_id: seg.document_id,
            version: seg.version,
            segment_id: seg.segment_id,
          },
        ],
        provenance: "AI_DRAFT" as const,
      })),
    },
    {
      key: "relevant_context",
      title: "3. Relevant History & Comorbidities",
      claims: [
        {
          id: "CLM-3-1",
          text:
            allSafeSegs[2]?.text ||
            allSafeSegs[1]?.text ||
            firstSeg.text,
          source_refs: [refOf(2)],
          provenance: "AI_DRAFT",
        },
      ],
    },
    {
      key: "available_data",
      title: "4. Available Baseline Findings & Labs",
      claims: allSafeSegs.slice(3, 6).length
        ? allSafeSegs.slice(3, 6).map((seg, i) => ({
            id: `CLM-4-${i + 1}`,
            text: seg.text,
            source_refs: [
              {
                document_id: seg.document_id,
                version: seg.version,
                segment_id: seg.segment_id,
              },
            ],
            provenance: "AI_DRAFT" as const,
          }))
        : [
            {
              id: "CLM-4-1",
              text: allSafeSegs[allSafeSegs.length - 1].text,
              source_refs: [refOf(allSafeSegs.length - 1)],
              provenance: "AI_DRAFT",
            },
          ],
    },
  ];

  const specialtyCandidates: AIContractOutput["specialty_candidates"] =
    isCardioOverlap
      ? [
          {
            code: "RESPIRATORY",
            reason:
              "Persistent subacute cough, wheezing, or chronic airway disease requires Pulmonology evaluation.",
            certainty: "uncertain",
            source_refs: [refOf(0), refOf(1)],
          },
          {
            code: "CARDIOLOGY",
            reason:
              "Exertional dyspnea with peripheral ankle edema and cardiovascular risk factors warrants Cardiology differentiation.",
            certainty: "uncertain",
            source_refs: [refOf(1), refOf(2)],
          },
        ]
      : [
          {
            code: "RESPIRATORY",
            reason:
              "Persistent cough, upper-lobe pulmonary nodule/pleural effusion, and poor response to outpatient therapy align with Pulmonology.",
            certainty: "clear",
            source_refs: [refOf(0), refOf(1)],
          },
          {
            code: "INTERNAL_MEDICINE",
            reason:
              "Internal Medicine co-management may help review systemic comorbidities and medication interactions.",
            certainty: "uncertain",
            source_refs: [refOf(2)],
          },
        ];

  return {
    case_id: caseId,
    input_version: inputVersion,
    summary_sections: summarySections,
    unknowns,
    contradictions,
    question_drafts: [
      {
        id: "QD-1",
        text: "How should we adjust the current outpatient maintenance regimen, and which clinical parameters must be clarified before escalating therapy?",
        rationale:
          "Focuses specialist guidance on actionable outpatient management decisions.",
        source_refs: [refOf(0), refOf(1)],
        provenance: "AI_DRAFT",
        selected: true,
      },
      {
        id: "QD-2",
        text: "Are there red-flag features of overlapping structural lung disease or cardiac decompensation that warrant direct referral rather than local workup?",
        rationale:
          "Clarifies safety thresholds and risk stratification for the referring clinic.",
        source_refs: [refOf(1), refOf(2)],
        provenance: "AI_DRAFT",
        selected: false,
      },
    ],
    clarification_required: clarificationRequired,
    clarification_prompt: clarificationRequired
      ? "The initial referral question is too brief or generic. Which clinical decision should the specialist focus on?"
      : undefined,
    clarification_options: clarificationRequired
      ? [
          "1. Clarify the etiology of uncontrolled dyspnea and optimize the outpatient maintenance regimen",
          "2. Differentiate Pulmonary vs. Cardiac contribution to dyspnea and define referral thresholds",
          "3. Prioritize high-yield baseline diagnostic tests appropriate for the primary clinic",
        ]
      : undefined,
    specialty_candidates: specialtyCandidates,
    needs_clinician_review: true,
    prompt_injection_warnings:
      injectionWarnings.length > 0 ? injectionWarnings : undefined,
  };
}

export interface GenerateTestSuggestionsOptions {
  customRawSuggestions?: Array<{
    catalog_test_id: string;
    target_question: string;
    patient_evidence_refs: PatientEvidenceRef[];
    guideline_refs: GuidelineRef[];
    applicability_conditions?: string[];
    unmet_or_unknown_conditions?: string[];
    limitations?: string[];
    evidence_status:
      | "SUPPORTED"
      | "NEEDS_INFORMATION"
      | "ABSTAIN"
      | "UNSUPPORTED";
  }>;
  strictRejectInvalid?: boolean;
}

export function generateTestSuggestions(
  caseId: string,
  actor: ActorContext,
  options: GenerateTestSuggestionsOptions = {}
) {
  requireRoles(actor, ["referring_clinician"]);
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
  if (caseRow.organization_id !== actor.organizationId) {
    const err = new Error(
      "You are only authorized to generate test suggestions for cases belonging to your own organization."
    ) as Error & { status: number };
    err.status = 403;
    throw err;
  }

  // Must have a ClinicalAssessment before generating test suggestions (Section 8.1, A16)
  const latestAssessment = db
    .prepare(
      "SELECT * FROM clinical_assessments WHERE case_id = ? ORDER BY version DESC LIMIT 1"
    )
    .get(caseId) as Record<string, unknown> | undefined;

  if (!latestAssessment) {
    throw new ValidationError(
      "Referring clinician must save a Clinical Assessment before generating test suggestions (A16).",
      "ASSESSMENT_REQUIRED_BEFORE_SUGGESTIONS"
    );
  }

  const docs = db
    .prepare(
      "SELECT * FROM document_versions WHERE case_id = ? ORDER BY version ASC, id ASC"
    )
    .all(caseId) as unknown as DbDocRow[];

  const catalogRows = db
    .prepare("SELECT * FROM test_catalog_entries WHERE active = 1")
    .all() as unknown as Array<{
    id: string;
    code: string;
    name_vi: string;
    modality: string;
    typical_turnaround_hours: number;
    contraindication_notes_json: string;
  }>;
  const catalogById = new Map(catalogRows.map((c) => [c.id, c]));

  const kbRows = db
    .prepare("SELECT * FROM knowledge_document_versions")
    .all() as unknown as Array<{
    id: string;
    version: number;
    title: string;
    specialty_code: string;
    review_status: "DEMO_ONLY" | "CLINICIAN_APPROVED";
    sections_json: string;
  }>;

  const existingResults = db
    .prepare("SELECT * FROM test_results WHERE case_id = ?")
    .all(caseId) as unknown as Array<{
    id: string;
    catalog_test_id: string;
    result_summary: string;
    recorded_at: string;
  }>;

  const existingMockOrders = db
    .prepare(
      "SELECT * FROM mock_test_orders WHERE case_id = ? AND status IN ('PLANNED', 'REQUESTED', 'RESULT_AVAILABLE')"
    )
    .all(caseId) as unknown as Array<{
    id: string;
    catalog_test_id: string;
    status: string;
    created_at: string;
  }>;

  const knowledgeVersions: Record<string, number> = {};
  for (const k of kbRows) {
    knowledgeVersions[k.id] = k.version;
  }

  const basisVersions: GenerationBasisVersions = {
    case_version: Number(caseRow.input_version || 1),
    assessment_version: Number(latestAssessment.version || 1),
    knowledge_versions: knowledgeVersions,
  };

  // Validate valid document segment keys
  const validDocSegments = new Set<string>();
  for (const d of docs) {
    const segs = JSON.parse(d.segments_json || "[]") as Array<{
      segment_id: string;
    }>;
    for (const s of segs) {
      validDocSegments.add(`${d.id}::${d.version}::${s.segment_id}`);
    }
  }

  // Validate valid guideline section keys
  const validGuidelineSections = new Set<string>();
  for (const k of kbRows) {
    const secs = JSON.parse(k.sections_json || "[]") as Array<{
      section_id: string;
    }>;
    for (const sec of secs) {
      validGuidelineSections.add(`${k.id}::${k.version}::${sec.section_id}`);
    }
  }

  const rawItems =
    options.customRawSuggestions ??
    buildGroundedRawSuggestions(caseId, docs, latestAssessment, kbRows);

  // Validate every raw item against catalog & citation rules (A15, A18)
  const validationErrors: string[] = [];
  for (const item of rawItems) {
    const cat = catalogById.get(item.catalog_test_id);
    if (!cat) {
      validationErrors.push(
        `Test '${item.catalog_test_id}' is not in the approved TestCatalogEntry list (A18).`
      );
      continue;
    }

    if (item.evidence_status === "SUPPORTED") {
      if (
        !item.patient_evidence_refs ||
        item.patient_evidence_refs.length === 0
      ) {
        validationErrors.push(
          `Suggestion '${cat.code}' is marked SUPPORTED but lacks patient evidence citations (A15).`
        );
      }
      if (!item.guideline_refs || item.guideline_refs.length === 0) {
        validationErrors.push(
          `Suggestion '${cat.code}' is marked SUPPORTED but lacks clinical guideline citations (A15).`
        );
      }
    }

    for (const pRef of item.patient_evidence_refs || []) {
      if (pRef.type === "document_segment") {
        const key = `${pRef.document_id}::${pRef.version}::${pRef.segment_id}`;
        if (!validDocSegments.has(key)) {
          validationErrors.push(
            `Patient evidence citation does not exist: ${key} (A15).`
          );
        }
      } else if (pRef.type === "clinical_assessment") {
        if (pRef.version !== Number(latestAssessment.version)) {
          validationErrors.push(
            `Clinical assessment citation does not match current version v${latestAssessment.version} (A15).`
          );
        }
      }
    }

    for (const gRef of item.guideline_refs || []) {
      const key = `${gRef.knowledge_document_id}::${gRef.version}::${gRef.section_id}`;
      if (!validGuidelineSections.has(key)) {
        validationErrors.push(
          `Guideline citation does not exist in Knowledge Base: ${key} (A15).`
        );
      }
    }
  }

  if (validationErrors.length > 0) {
    throw new ValidationError(
      `Rejected test suggestions due to evidence/catalog validation errors: ${validationErrors.join(" ")}`,
      "INVALID_TEST_SUGGESTION_CITATIONS_OR_CATALOG",
      { validationErrors }
    );
  }

  const runId = `TSRUN-${randomUUID().slice(0, 8).toUpperCase()}`;
  const now = new Date().toISOString();
  const createdSuggestions: TestSuggestionDTO[] = [];

  withTransaction(db, () => {
    db.prepare(
      `
      INSERT INTO test_suggestion_runs (
        id, case_id, case_input_version, clinical_assessment_id, clinical_assessment_version,
        knowledge_versions_json, adapter_mode, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
    ).run(
      runId,
      caseId,
      basisVersions.case_version,
      String(latestAssessment.id),
      basisVersions.assessment_version,
      JSON.stringify(knowledgeVersions),
      "FIXTURE_GROUNDED",
      "COMPLETED",
      actor.userId,
      now
    );

    const fullDocText = docs
      .map((d) => d.extracted_text.toLowerCase())
      .join("\n");

    for (const item of rawItems) {
      const cat = catalogById.get(item.catalog_test_id)!;
      const existingRefs: ExistingTestRef[] = [];
      let duplicateStatus: DuplicateStatus = "NONE";

      for (const r of existingResults) {
        if (r.catalog_test_id === cat.id) {
          duplicateStatus = "ALREADY_AVAILABLE";
          existingRefs.push({
            type: "test_result",
            id: r.id,
            test_code: cat.code,
            summary: r.result_summary,
            observed_at: r.recorded_at,
            status: "RESULT_AVAILABLE",
          });
        }
      }

      for (const mo of existingMockOrders) {
        if (mo.catalog_test_id === cat.id && duplicateStatus === "NONE") {
          duplicateStatus =
            mo.status === "RESULT_AVAILABLE"
              ? "ALREADY_AVAILABLE"
              : "PENDING_RESULT";
          existingRefs.push({
            type: "mock_order",
            id: mo.id,
            test_code: cat.code,
            summary: `Simulated order (${mo.status})`,
            observed_at: mo.created_at,
            status: mo.status,
          });
        }
      }

      // Check document mentions for duplicate or related prior imaging/labs (A22)
      if (
        duplicateStatus === "NONE" &&
        cat.id === "CAT-HRCT-CHEST" &&
        (fullDocText.includes("chest x-ray") ||
          fullDocText.includes("chest radiograph"))
      ) {
        duplicateStatus = "POSSIBLE_DUPLICATE_NEEDS_REVIEW";
        existingRefs.push({
          type: "document_mention",
          id: `${docs[0].id}#S-001`,
          test_code: "CXR-PRIOR",
          summary:
            "A recent chest X-ray is already documented in the record; review carefully before ordering high-resolution chest CT.",
          status: "DOCUMENTED",
        });
      }
      if (
        duplicateStatus === "NONE" &&
        cat.id === "CAT-IGE-EOS" &&
        fullDocText.includes("eosinophil")
      ) {
        duplicateStatus = "ALREADY_AVAILABLE";
        existingRefs.push({
          type: "document_mention",
          id: `${docs[0].id}#S-002`,
          test_code: cat.code,
          summary:
            "Complete blood count with peripheral blood Eosinophil count is already documented in the record.",
          status: "DOCUMENTED",
        });
      }

      const sugId = `TSUG-${randomUUID().slice(0, 8).toUpperCase()}`;
      db.prepare(
        `
        INSERT INTO test_suggestions (
          id, run_id, case_id, catalog_test_id, target_question,
          patient_evidence_refs_json, guideline_refs_json,
          applicability_conditions_json, unmet_or_unknown_conditions_json,
          existing_test_refs_json, duplicate_status, limitations_json,
          evidence_status, generation_basis_versions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      ).run(
        sugId,
        runId,
        caseId,
        cat.id,
        item.target_question,
        JSON.stringify(item.patient_evidence_refs),
        JSON.stringify(item.guideline_refs),
        JSON.stringify(item.applicability_conditions || []),
        JSON.stringify(item.unmet_or_unknown_conditions || []),
        JSON.stringify(existingRefs),
        duplicateStatus,
        JSON.stringify(item.limitations || []),
        item.evidence_status,
        JSON.stringify(basisVersions),
        now
      );

      createdSuggestions.push({
        id: sugId,
        run_id: runId,
        case_id: caseId,
        catalog_test_id: cat.id,
        catalog_test_code: cat.code,
        catalog_test_name: cat.name_vi,
        modality: cat.modality,
        target_question: item.target_question,
        patient_evidence_refs: item.patient_evidence_refs,
        guideline_refs: item.guideline_refs,
        applicability_conditions: item.applicability_conditions || [],
        unmet_or_unknown_conditions: item.unmet_or_unknown_conditions || [],
        existing_test_refs: existingRefs,
        duplicate_status: duplicateStatus,
        limitations: item.limitations || [],
        evidence_status: item.evidence_status,
        generation_basis_versions: basisVersions,
        decision: null,
      });
    }

    db.prepare(
      `
      INSERT INTO activity_events (id, case_id, actor_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
    ).run(
      `EVT-${randomUUID().slice(0, 8).toUpperCase()}`,
      caseId,
      actor.userId,
      "TEST_SUGGESTIONS_GENERATED",
      JSON.stringify({
        run_id: runId,
        suggestion_count: createdSuggestions.length,
        basis_versions: basisVersions,
      }),
      now
    );
  });

  return {
    run_id: runId,
    case_id: caseId,
    basis_versions: basisVersions,
    suggestions: createdSuggestions,
    created_at: now,
  };
}

function buildGroundedRawSuggestions(
  caseId: string,
  docs: DbDocRow[],
  assessment: Record<string, unknown>,
  kbRows: Array<{
    id: string;
    version: number;
    title: string;
    review_status: "DEMO_ONLY" | "CLINICIAN_APPROVED";
    sections_json: string;
  }>
) {
  const firstDoc = docs[0];
  const segs = JSON.parse(firstDoc.segments_json || "[]") as Array<{
    segment_id: string;
    text: string;
  }>;
  const s1 = segs[0] || { segment_id: "S-001", text: firstDoc.extracted_text };
  const s2 = segs[1] || s1;

  const respKb = kbRows.find((k) => k.id === "KB-VN-RESP-01") || kbRows[0];
  const cardKb = kbRows.find((k) => k.id === "KB-VN-CARD-01") || respKb;
  const respSecs = JSON.parse(respKb.sections_json || "[]") as Array<{
    section_id: string;
    heading: string;
    content: string;
  }>;
  const cardSecs = JSON.parse(cardKb.sections_json || "[]") as Array<{
    section_id: string;
    heading: string;
    content: string;
  }>;

  const fullText = docs
    .map((d) => d.extracted_text.toLowerCase())
    .join("\n");
  const isCardioOverlap =
    fullText.includes("edema") ||
    fullText.includes("heart") ||
    String(assessment.working_impression || "")
      .toLowerCase()
      .includes("heart");

  const suggestions: GenerateTestSuggestionsOptions["customRawSuggestions"] = [
    {
      catalog_test_id: "CAT-SPIRO-BD",
      target_question:
        "Quantify airflow limitation (FEV1/FVC) and post-bronchodilator reversibility to guide maintenance inhaler adjustment.",
      patient_evidence_refs: [
        {
          type: "document_segment",
          document_id: firstDoc.id,
          version: firstDoc.version,
          segment_id: s1.segment_id,
          excerpt: s1.text,
        },
        {
          type: "clinical_assessment",
          version: Number(assessment.version),
          assessment_field: "working_impression",
          excerpt: String(assessment.working_impression),
        },
      ],
      guideline_refs: [
        {
          knowledge_document_id: respKb.id,
          version: respKb.version,
          section_id: respSecs[0]?.section_id || "SEC-RESP-1",
          title: respKb.title,
          review_status: respKb.review_status,
          excerpt:
            respSecs[0]?.content ||
            "Perform spirometry with bronchodilator reversibility testing when chronic respiratory symptoms persist.",
        },
      ],
      applicability_conditions: [
        "Patient has no acute contraindications to forced expiratory maneuvers (SpO2 >= 92%, hemodynamically stable)",
        "Withhold short-acting bronchodilator (SABA) for 4–6 hours prior to testing if clinically safe",
      ],
      unmet_or_unknown_conditions: [
        "Confirm whether rescue salbutamol inhaler was used within the past 4 hours",
      ],
      limitations: [
        "Results depend on adequate patient effort and reproducible spirometry coaching.",
      ],
      evidence_status: "SUPPORTED",
    },
    {
      catalog_test_id: "CAT-IGE-EOS",
      target_question:
        "Assess Type 2 eosinophilic airway inflammation phenotype to inform inhaled corticosteroid (ICS) optimization.",
      patient_evidence_refs: [
        {
          type: "document_segment",
          document_id: firstDoc.id,
          version: firstDoc.version,
          segment_id: s2.segment_id,
          excerpt: s2.text,
        },
      ],
      guideline_refs: [
        {
          knowledge_document_id: respKb.id,
          version: respKb.version,
          section_id:
            respSecs[1]?.section_id || respSecs[0]?.section_id || "SEC-RESP-2",
          title: respKb.title,
          review_status: respKb.review_status,
          excerpt:
            respSecs[1]?.content ||
            "Peripheral blood eosinophil count and total IgE support airway inflammation phenotyping.",
        },
      ],
      applicability_conditions: [
        "Patient has not received high-dose systemic corticosteroids within the past 2 weeks",
      ],
      unmet_or_unknown_conditions: [
        "Unknown whether over-the-counter oral corticosteroids were taken recently",
      ],
      limitations: [
        "May be confounded by parasitic infection or recent systemic corticosteroid exposure.",
      ],
      evidence_status: "SUPPORTED",
    },
    {
      catalog_test_id: "CAT-HRCT-CHEST",
      target_question:
        "Evaluate parenchymal pulmonary nodule characteristics, mediastinal lymphadenopathy, or bronchiectasis overlap.",
      patient_evidence_refs: [
        {
          type: "document_segment",
          document_id: firstDoc.id,
          version: firstDoc.version,
          segment_id: s2.segment_id,
          excerpt: s2.text,
        },
      ],
      guideline_refs: [
        {
          knowledge_document_id: respKb.id,
          version: respKb.version,
          section_id:
            respSecs[2]?.section_id || respSecs[0]?.section_id || "SEC-RESP-3",
          title: respKb.title,
          review_status: respKb.review_status,
          excerpt:
            respSecs[2]?.content ||
            "Avoid routine HRCT chest if a recent chest X-ray is unremarkable and no structural red flags are present.",
        },
      ],
      applicability_conditions: [
        "Indicated when hemoptysis, weight loss, persistent focal nodule, or suspected bronchiectasis is present",
      ],
      unmet_or_unknown_conditions: [
        "Prior chest X-ray from 6 months ago is not yet available for baseline comparison",
      ],
      limitations: [
        "Radiation exposure and higher cost; reference guidance recommends NEEDS_INFORMATION review if prior imaging is pending.",
      ],
      evidence_status: "NEEDS_INFORMATION",
    },
  ];

  if (isCardioOverlap) {
    suggestions.push({
      catalog_test_id: "CAT-NTPROBNP",
      target_question:
        "Differentiate heart failure decompensation from chronic obstructive airway disease progression.",
      patient_evidence_refs: [
        {
          type: "document_segment",
          document_id: firstDoc.id,
          version: firstDoc.version,
          segment_id: s1.segment_id,
          excerpt: s1.text,
        },
        {
          type: "clinical_assessment",
          version: Number(assessment.version),
          assessment_field: "differential_diagnoses",
          excerpt: String(assessment.differential_diagnoses_json),
        },
      ],
      guideline_refs: [
        {
          knowledge_document_id: cardKb.id,
          version: cardKb.version,
          section_id: cardSecs[0]?.section_id || "SEC-CARD-1",
          title: cardKb.title,
          review_status: cardKb.review_status,
          excerpt:
            cardSecs[0]?.content ||
            "Serum NT-proBNP helps stratify heart failure risk in patients presenting with exertional dyspnea and edema.",
        },
      ],
      applicability_conditions: [
        "Patient presents with exertional dyspnea and peripheral edema or cardiovascular comorbidities",
      ],
      unmet_or_unknown_conditions: [
        "Account for renal function (eGFR) and age when interpreting NT-proBNP cutoffs",
      ],
      limitations: [
        "NT-proBNP may be mildly elevated in cor pulmonale, atrial fibrillation, or chronic kidney disease.",
      ],
      evidence_status: "SUPPORTED",
    });
  }

  return suggestions;
}
