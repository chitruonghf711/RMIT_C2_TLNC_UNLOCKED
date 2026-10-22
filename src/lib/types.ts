export type UserRole =
  | "referring_clinician"
  | "consulting_specialist"
  | "coordinator"
  | "network_admin";

export type SpecialtyCode =
  | "RESPIRATORY"
  | "CARDIOLOGY"
  | "INTERNAL_MEDICINE"
  | "ENDOCRINOLOGY"
  | "INFECTIOUS_DISEASE";

export const SPECIALTY_LABELS: Record<SpecialtyCode, string> = {
  RESPIRATORY: "Pulmonology & Respiratory",
  CARDIOLOGY: "Cardiology",
  INTERNAL_MEDICINE: "Internal Medicine",
  ENDOCRINOLOGY: "Endocrinology",
  INFECTIOUS_DISEASE: "Infectious Disease",
};

export type CaseStatus =
  | "DRAFT"
  | "READY"
  | "WAITING_MATCH"
  | "INVITED"
  | "IN_CONSULTATION"
  | "NEEDS_INFO"
  | "ANSWERED"
  | "CLOSED"
  | "CANCELLED";

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  DRAFT: "Preparing (Draft)",
  READY: "Package Ready",
  WAITING_MATCH: "Awaiting Specialist",
  INVITED: "Invitation Sent",
  IN_CONSULTATION: "In Consultation",
  NEEDS_INFO: "Needs Information",
  ANSWERED: "Specialist Answered",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
};

export type InvitationStatus =
  | "PENDING"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELLED";

export type InformationRequestStatus = "OPEN" | "RESPONDED" | "ACKNOWLEDGED";

export type AvailabilityState = "AVAILABLE" | "SCHEDULED" | "BUSY" | "PAUSED";

export type FieldProvenance = "AI_DRAFT" | "CLINICIAN_EDIT" | "SOURCE_EXTRACT";

export type EvidenceStatus =
  | "SUPPORTED"
  | "NEEDS_INFORMATION"
  | "ABSTAIN"
  | "UNSUPPORTED";

export type DuplicateStatus =
  | "NONE"
  | "ALREADY_AVAILABLE"
  | "PENDING_RESULT"
  | "POSSIBLE_DUPLICATE_NEEDS_REVIEW";

export type SuggestionDecisionType =
  | "PENDING_REVIEW"
  | "APPROVED"
  | "MODIFIED"
  | "REJECTED"
  | "DEFERRED";

export type MockTestOrderStatus =
  | "PLANNED"
  | "REQUESTED"
  | "RESULT_AVAILABLE"
  | "CANCELLED";

export interface SourceRef {
  document_id: string;
  version: number;
  segment_id: string;
}

export interface DocumentSegment {
  segment_id: string;
  line_start: number;
  line_end: number;
  text: string;
  suspicious_instruction_detected?: boolean;
}

export interface SummaryClaim {
  id: string;
  text: string;
  source_refs: SourceRef[];
  provenance: FieldProvenance;
}

export type SummarySectionKey =
  | "reason_for_consult"
  | "clinical_course"
  | "relevant_context"
  | "available_data";

export interface SummarySection {
  key: SummarySectionKey;
  title: string;
  claims: SummaryClaim[];
}

export interface UnknownItem {
  field: string;
  label: string;
  reason: string;
  provenance: FieldProvenance;
}

export interface ContradictionItem {
  topic: string;
  description: string;
  source_refs: SourceRef[];
}

export interface QuestionDraft {
  id: string;
  text: string;
  rationale?: string;
  source_refs: SourceRef[];
  provenance: FieldProvenance;
  selected?: boolean;
}

export interface SpecialtyCandidate {
  code: SpecialtyCode;
  reason: string;
  certainty: "clear" | "uncertain";
  source_refs: SourceRef[];
}

export interface AIContractOutput {
  case_id: string;
  input_version: number;
  summary_sections: SummarySection[];
  unknowns: UnknownItem[];
  contradictions: ContradictionItem[];
  question_drafts: QuestionDraft[];
  clarification_required?: boolean;
  clarification_prompt?: string;
  clarification_options?: string[];
  specialty_candidates: SpecialtyCandidate[];
  needs_clinician_review: boolean;
  citation_validation_errors?: string[];
  prompt_injection_warnings?: string[];
}

export interface PatientEvidenceRef {
  type: "document_segment" | "clinical_assessment";
  document_id?: string;
  version: number;
  segment_id?: string;
  assessment_field?: string;
  excerpt: string;
}

export interface GuidelineRef {
  knowledge_document_id: string;
  version: number;
  section_id: string;
  title: string;
  review_status: "DEMO_ONLY" | "CLINICIAN_APPROVED";
  excerpt: string;
}

export interface ExistingTestRef {
  type: "test_result" | "mock_order" | "document_mention";
  id: string;
  test_code: string;
  summary: string;
  observed_at?: string;
  status: string;
}

export interface GenerationBasisVersions {
  case_version: number;
  assessment_version: number;
  knowledge_versions: Record<string, number>;
}

export interface TestSuggestionDTO {
  id: string;
  run_id: string;
  case_id: string;
  catalog_test_id: string;
  catalog_test_code: string;
  catalog_test_name: string;
  modality: string;
  target_question: string;
  patient_evidence_refs: PatientEvidenceRef[];
  guideline_refs: GuidelineRef[];
  applicability_conditions: string[];
  unmet_or_unknown_conditions: string[];
  existing_test_refs: ExistingTestRef[];
  duplicate_status: DuplicateStatus;
  limitations: string[];
  evidence_status: EvidenceStatus;
  generation_basis_versions: GenerationBasisVersions;
  decision?: {
    id: string;
    reviewer_id: string;
    reviewer_name: string;
    decision: SuggestionDecisionType;
    edited_content?: {
      target_question?: string;
      catalog_test_id?: string;
      note?: string;
    } | null;
    rationale: string;
    reviewed_basis_versions: GenerationBasisVersions;
    reviewed_at: string;
    needs_re_review?: boolean;
  } | null;
}

export interface ClinicianAddedTestItem {
  id: string;
  catalog_test_id: string;
  catalog_test_code: string;
  catalog_test_name: string;
  modality: string;
  target_question: string;
  rationale: string;
  added_by: string;
  added_by_name: string;
  added_at: string;
  source_label: "CLINICIAN_ADDED";
}

export interface SpecialistMatchCandidate {
  user_id: string;
  display_name: string;
  title: string;
  organization_id: string;
  organization_name: string;
  approved_specialty_codes: SpecialtyCode[];
  approved_topic_tags: string[];
  languages: string[];
  availability_state: AvailabilityState;
  availability_updated_at: string;
  availability_expires_at: string;
  active_cases: number;
  max_open_cases: number;
  has_protected_role: boolean;
  eligible: boolean;
  ineligible_reasons: string[];
  score: number | null;
  score_breakdown: {
    specialty_fit: number;
    availability_fit: number;
    remaining_capacity_ratio: number;
    approved_topic_fit: number;
  } | null;
  ranking_reasons: string[];
}
