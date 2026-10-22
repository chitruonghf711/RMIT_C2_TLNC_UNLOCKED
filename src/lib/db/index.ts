import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

let _db: DatabaseSync | null = null;
let _initializedPath: string | null = null;

export function getDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }
  return join(process.cwd(), "data", "casebridge.db");
}

export function getPrivateStorageDir(): string {
  if (process.env.PRIVATE_STORAGE_DIR) {
    return process.env.PRIVATE_STORAGE_DIR;
  }
  return join(process.cwd(), "data", "private-storage");
}

export function getDb(): DatabaseSync {
  const dbPath = getDatabasePath();
  if (_db && _initializedPath === dbPath) {
    return _db;
  }
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  mkdirSync(getPrivateStorageDir(), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  initSchema(db);
  _db = db;
  _initializedPath = dbPath;
  return db;
}

export function resetDbConnection(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // ignore close errors
    }
  }
  _db = null;
  _initializedPath = null;
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE TRANSACTION;");
  try {
    const result = fn();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      network_status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tide_subject TEXT UNIQUE,
      organization_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      title TEXT NOT NULL,
      email TEXT,
      tide_roles_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS specialist_profiles (
      user_id TEXT PRIMARY KEY,
      approved_specialty_codes_json TEXT NOT NULL,
      approved_topic_tags_json TEXT NOT NULL,
      languages_json TEXT NOT NULL,
      availability_state TEXT NOT NULL,
      availability_updated_at TEXT NOT NULL,
      availability_expires_at TEXT NOT NULL,
      max_open_cases INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS network_agreements (
      id TEXT PRIMARY KEY,
      source_org_id TEXT NOT NULL,
      target_org_id TEXT NOT NULL,
      organization_pair TEXT NOT NULL,
      allowed_specialties_json TEXT NOT NULL,
      status TEXT NOT NULL,
      policy_reference TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cases (
      id TEXT PRIMARY KEY,
      case_code TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      referring_clinician_id TEXT NOT NULL,
      patient_label TEXT NOT NULL,
      patient_age_band TEXT NOT NULL,
      patient_sex TEXT NOT NULL DEFAULT 'Nam',
      title TEXT NOT NULL,
      clinical_question TEXT NOT NULL DEFAULT '',
      specialty_requested TEXT NOT NULL DEFAULT 'RESPIRATORY',
      secondary_specialties_json TEXT NOT NULL DEFAULT '[]',
      topic_tags_json TEXT NOT NULL DEFAULT '[]',
      language_required TEXT NOT NULL DEFAULT 'vi',
      urgency_tier TEXT NOT NULL DEFAULT 'ROUTINE',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      input_version INTEGER NOT NULL DEFAULT 1,
      snapshot_version INTEGER NOT NULL DEFAULT 0,
      accepted_specialist_id TEXT,
      draft_created_at TEXT NOT NULL,
      review_completed_at TEXT,
      invitation_sent_at TEXT,
      accepted_at TEXT,
      first_specialist_response_at TEXT,
      answered_at TEXT,
      closed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS document_versions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      filename TEXT NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'CLINICAL_NOTE',
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      storage_path TEXT NOT NULL,
      extracted_text TEXT NOT NULL,
      segments_json TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preparation_runs (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      input_version INTEGER NOT NULL,
      adapter_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      output_json TEXT NOT NULL,
      validation_errors_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS referral_snapshots (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      input_version INTEGER NOT NULL,
      preparation_run_id TEXT,
      summary_sections_json TEXT NOT NULL,
      unknowns_json TEXT NOT NULL DEFAULT '[]',
      contradictions_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT NOT NULL DEFAULT '[]',
      selected_specialties_json TEXT NOT NULL DEFAULT '[]',
      manual_edits_json TEXT NOT NULL DEFAULT '[]',
      confirmed_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clinical_assessments (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      case_input_version INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      working_impression TEXT NOT NULL,
      differential_diagnoses_json TEXT NOT NULL DEFAULT '[]',
      red_flags_checked_json TEXT NOT NULL DEFAULT '[]',
      unresolved_questions_json TEXT NOT NULL DEFAULT '[]',
      urgency_level TEXT NOT NULL DEFAULT 'NON_EMERGENT_SPECIALIST_CONSULT',
      rationale_notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS knowledge_document_versions (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      specialty_code TEXT NOT NULL,
      review_status TEXT NOT NULL,
      sections_json TEXT NOT NULL,
      published_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_catalog_entries (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name_vi TEXT NOT NULL,
      modality TEXT NOT NULL,
      typical_turnaround_hours INTEGER NOT NULL DEFAULT 2,
      contraindication_notes_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS test_suggestion_runs (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      case_input_version INTEGER NOT NULL,
      clinical_assessment_id TEXT NOT NULL,
      clinical_assessment_version INTEGER NOT NULL,
      knowledge_versions_json TEXT NOT NULL,
      adapter_mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_suggestions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      catalog_test_id TEXT NOT NULL,
      target_question TEXT NOT NULL,
      patient_evidence_refs_json TEXT NOT NULL,
      guideline_refs_json TEXT NOT NULL,
      applicability_conditions_json TEXT NOT NULL,
      unmet_or_unknown_conditions_json TEXT NOT NULL,
      existing_test_refs_json TEXT NOT NULL,
      duplicate_status TEXT NOT NULL,
      limitations_json TEXT NOT NULL,
      evidence_status TEXT NOT NULL,
      generation_basis_versions_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_suggestion_decisions (
      id TEXT PRIMARY KEY,
      suggestion_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      reviewer_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      edited_content_json TEXT,
      rationale TEXT NOT NULL,
      reviewed_basis_versions_json TEXT NOT NULL,
      reviewed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clinician_added_tests (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      catalog_test_id TEXT NOT NULL,
      target_question TEXT NOT NULL,
      rationale TEXT NOT NULL,
      added_by TEXT NOT NULL,
      added_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_plan_versions (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      items_json TEXT NOT NULL,
      basis_versions_json TEXT NOT NULL,
      confirmed_by TEXT NOT NULL,
      confirmed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mock_test_orders (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      plan_version_id TEXT NOT NULL,
      catalog_test_id TEXT NOT NULL,
      target_question TEXT NOT NULL,
      status TEXT NOT NULL,
      idempotency_key TEXT UNIQUE NOT NULL,
      ordered_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS test_results (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      mock_order_id TEXT,
      catalog_test_id TEXT NOT NULL,
      result_summary TEXT NOT NULL,
      structured_values_json TEXT NOT NULL DEFAULT '{}',
      source_label TEXT NOT NULL DEFAULT 'CLINICIAN_ENTERED',
      recorded_by TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      specialist_id TEXT NOT NULL,
      status TEXT NOT NULL,
      fallback_enabled INTEGER NOT NULL DEFAULT 0,
      fallback_queue_json TEXT NOT NULL DEFAULT '[]',
      preview_summary_json TEXT NOT NULL DEFAULT '{}',
      decline_reason TEXT,
      sent_by TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS consultations (
      id TEXT PRIMARY KEY,
      case_id TEXT UNIQUE NOT NULL,
      invitation_id TEXT NOT NULL,
      referring_clinician_id TEXT NOT NULL,
      specialist_id TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      opened_at TEXT NOT NULL,
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS information_requests (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL,
      response_text TEXT,
      response_snapshot_id TEXT,
      created_at TEXT NOT NULL,
      responded_at TEXT
    );

    CREATE TABLE IF NOT EXISTS consultation_responses (
      id TEXT PRIMARY KEY,
      consultation_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      question_answers_json TEXT NOT NULL,
      clinical_recommendations TEXT NOT NULL,
      limitations TEXT NOT NULL,
      is_demo_sample INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      submitted_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS governance_links (
      id TEXT PRIMARY KEY,
      tide_change_request_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      requested_action TEXT NOT NULL,
      role_name TEXT NOT NULL,
      status_source TEXT NOT NULL,
      last_observed_status TEXT NOT NULL,
      approvals_observed INTEGER NOT NULL DEFAULT 0,
      threshold_observed INTEGER NOT NULL DEFAULT 2,
      ready_to_commit INTEGER NOT NULL DEFAULT 0,
      checked_at TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS reference_cases (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      specialty_code TEXT NOT NULL,
      summary_approved TEXT NOT NULL,
      relevant_features_json TEXT NOT NULL,
      consultation_questions_json TEXT NOT NULL,
      approved_response_excerpt TEXT NOT NULL,
      source_organization_name TEXT NOT NULL,
      published_at TEXT NOT NULL,
      allowed_org_ids_json TEXT NOT NULL
    );
  `);
}
