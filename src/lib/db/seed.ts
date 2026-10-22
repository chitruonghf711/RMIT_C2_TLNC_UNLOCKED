import { getDb, withTransaction } from "./index";
import {
  parseClinicalTextDocument,
  writePrivateDocumentFile,
} from "../documents";
import { prepareCase } from "../ai/service";
import type { ActorContext } from "../auth/session";

export function ensureSeeded(forceReset = false): void {
  const db = getDb();
  const existingOrg = db
    .prepare("SELECT COUNT(*) as cnt FROM organizations")
    .get() as { cnt: number };

  if (existingOrg.cnt > 0 && !forceReset) {
    return;
  }

  withTransaction(db, () => {
    if (forceReset) {
      db.exec(`
        DELETE FROM activity_events;
        DELETE FROM consultation_responses;
        DELETE FROM information_requests;
        DELETE FROM messages;
        DELETE FROM consultations;
        DELETE FROM invitations;
        DELETE FROM referral_snapshots;
        DELETE FROM test_results;
        DELETE FROM mock_test_orders;
        DELETE FROM test_plan_versions;
        DELETE FROM clinician_added_tests;
        DELETE FROM test_suggestion_decisions;
        DELETE FROM test_suggestions;
        DELETE FROM test_suggestion_runs;
        DELETE FROM clinical_assessments;
        DELETE FROM preparation_runs;
        DELETE FROM document_versions;
        DELETE FROM cases;
        DELETE FROM reference_cases;
        DELETE FROM test_catalog_entries;
        DELETE FROM knowledge_document_versions;
        DELETE FROM network_agreements;
        DELETE FROM specialist_profiles;
        DELETE FROM organizations;
        DELETE FROM users;
        DELETE FROM governance_links;
      `);
    }

    const now = new Date();
    const iso = (offsetMinutes: number) =>
      new Date(now.getTime() + offsetMinutes * 60_000).toISOString();

    // 1. Organizations
    const insertOrg = db.prepare(`
      INSERT INTO organizations (id, name, type, network_status)
      VALUES (?, ?, ?, ?)
    `);
    insertOrg.run(
      "ORG-AN-BINH",
      "An Binh Community Polyclinic",
      "REFERRING_CLINIC",
      "ACTIVE"
    );
    insertOrg.run(
      "ORG-MINH-AN",
      "Minh An Tertiary Specialist Center",
      "SPECIALIST_CENTER",
      "ACTIVE"
    );
    insertOrg.run(
      "ORG-DONG-DO",
      "Dong Do Regional Clinic (Outside Agreement)",
      "REFERRING_CLINIC",
      "PENDING_GOVERNANCE"
    );

    // 2. Network Agreement
    db.prepare(`
      INSERT INTO network_agreements (id, source_org_id, target_org_id, organization_pair, allowed_specialties_json, status, policy_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "AGR-AB-MA-01",
      "ORG-AN-BINH",
      "ORG-MINH-AN",
      "ORG-AN-BINH::ORG-MINH-AN",
      JSON.stringify(["RESPIRATORY", "CARDIOLOGY", "INTERNAL_MEDICINE"]),
      "ACTIVE",
      "TIDE-QEA-AGREEMENT-2026-01"
    );

    // 3. Users
    const insertUser = db.prepare(`
      INSERT INTO users (id, tide_subject, organization_id, display_name, role, title, email, tide_roles_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertUser.run(
      "USR-REF-01",
      "dr_khoa",
      "ORG-AN-BINH",
      "Doctor",
      "referring_clinician",
      "General Internist — Referring Clinic",
      "khoa.anbinh@casebridge.demo",
      JSON.stringify(["_tide_enabled", "appUser", "referring_clinician"])
    );

    insertUser.run(
      "USR-REF-02",
      "dr_vu_external",
      "ORG-DONG-DO",
      "Outside Doctor",
      "referring_clinician",
      "General Practitioner — Dong Do Clinic",
      "vu.dongdo@casebridge.demo",
      JSON.stringify(["_tide_enabled", "appUser", "referring_clinician"])
    );

    // Specialist 1: Available, RESPIRATORY + INTERNAL_MEDICINE, has QEA network_consultant, 1/3 open cases
    insertUser.run(
      "USR-SPEC-01",
      "spec_bao",
      "ORG-MINH-AN",
      "Professor",
      "consulting_specialist",
      "Senior Consultant in Pulmonology & Internal Medicine",
      "bao.minhan@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "consulting_specialist",
        "network_consultant",
      ])
    );

    // Specialist 2: RESPIRATORY + CARDIOLOGY, has network_consultant, but BUSY (3/3 open cases)
    insertUser.run(
      "USR-SPEC-02",
      "spec_ha",
      "ORG-MINH-AN",
      "Specialist B (busy 3/3)",
      "consulting_specialist",
      "Consultant in Cardiopulmonary Medicine",
      "ha.minhan@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "consulting_specialist",
        "network_consultant",
      ])
    );

    // Specialist 3: RESPIRATORY + CARDIOLOGY, AVAILABLE, but MISSING QEA network_consultant role!
    insertUser.run(
      "USR-SPEC-03",
      "spec_nam",
      "ORG-MINH-AN",
      "Specialist C (pending QEA)",
      "consulting_specialist",
      "Cardiopulmonary Specialist (Pending Tide QEA Approval)",
      "nam.minhan@casebridge.demo",
      JSON.stringify(["_tide_enabled", "appUser", "consulting_specialist"])
    );

    // Specialist 4: Has network_consultant, AVAILABLE, wrong specialty (ENDOCRINOLOGY only)
    insertUser.run(
      "USR-SPEC-04",
      "spec_hung",
      "ORG-MINH-AN",
      "Specialist D (wrong specialty)",
      "consulting_specialist",
      "Consultant in Endocrinology",
      "hung.minhan@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "consulting_specialist",
        "network_consultant",
      ])
    );

    // Specialist 5: Fallback candidate — Has network_consultant, AVAILABLE, INTERNAL_MEDICINE + RESPIRATORY, 2/4 open cases
    insertUser.run(
      "USR-SPEC-05",
      "spec_lananh",
      "ORG-MINH-AN",
      "Specialist E (fallback)",
      "consulting_specialist",
      "Consultant in Internal Medicine & Pulmonology",
      "lananh.minhan@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "consulting_specialist",
        "network_consultant",
      ])
    );

    insertUser.run(
      "USR-COORD-01",
      "coord_mai",
      "ORG-MINH-AN",
      "Coordinator",
      "coordinator",
      "Inter-Facility Consultation Coordinator",
      "mai.minhan@casebridge.demo",
      JSON.stringify(["_tide_enabled", "appUser", "coordinator"])
    );

    insertUser.run(
      "USR-ADMIN-01",
      "admin",
      "ORG-MINH-AN",
      "Admin",
      "network_admin",
      "Network Governance Administrator — QEA Council #1",
      "truongledanchi07@gmail.com",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "network_admin",
        "tide-realm-admin",
      ])
    );
    insertUser.run(
      "USR-ADMIN-02",
      "admin2",
      "ORG-AN-BINH",
      "Admin 2 (QEA quorum)",
      "network_admin",
      "Network Governance Administrator — QEA Council #2",
      "admin2@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "network_admin",
        "tide-realm-admin",
      ])
    );
    insertUser.run(
      "USR-ADMIN-03",
      "admin3",
      "ORG-MINH-AN",
      "Admin 3 (QEA quorum)",
      "network_admin",
      "Network Governance Administrator — QEA Council #3",
      "admin3@casebridge.demo",
      JSON.stringify([
        "_tide_enabled",
        "appUser",
        "network_admin",
        "tide-realm-admin",
      ])
    );

    // 4. Specialist Profiles
    const insertProfile = db.prepare(`
      INSERT INTO specialist_profiles (
        user_id, approved_specialty_codes_json, approved_topic_tags_json,
        languages_json, availability_state, availability_updated_at,
        availability_expires_at, max_open_cases
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProfile.run(
      "USR-SPEC-01",
      JSON.stringify(["RESPIRATORY", "INTERNAL_MEDICINE"]),
      JSON.stringify([
        "pleural_effusion",
        "pulmonary_nodule",
        "subacute_cough",
        "copd",
      ]),
      JSON.stringify(["vi", "en"]),
      "AVAILABLE",
      iso(-25),
      iso(240),
      3
    );

    insertProfile.run(
      "USR-SPEC-02",
      JSON.stringify(["RESPIRATORY", "CARDIOLOGY"]),
      JSON.stringify(["heart_failure", "pleural_effusion", "dyspnea"]),
      JSON.stringify(["vi", "en"]),
      "BUSY",
      iso(-40),
      iso(180),
      3
    );

    insertProfile.run(
      "USR-SPEC-03",
      JSON.stringify(["RESPIRATORY", "CARDIOLOGY"]),
      JSON.stringify(["pleural_effusion", "arrhythmia"]),
      JSON.stringify(["vi", "en"]),
      "AVAILABLE",
      iso(-15),
      iso(240),
      3
    );

    insertProfile.run(
      "USR-SPEC-04",
      JSON.stringify(["ENDOCRINOLOGY"]),
      JSON.stringify(["diabetes", "thyroid"]),
      JSON.stringify(["vi", "en"]),
      "AVAILABLE",
      iso(-30),
      iso(240),
      2
    );

    insertProfile.run(
      "USR-SPEC-05",
      JSON.stringify(["INTERNAL_MEDICINE", "RESPIRATORY"]),
      JSON.stringify(["subacute_cough", "copd"]),
      JSON.stringify(["vi", "en"]),
      "AVAILABLE",
      iso(-20),
      iso(240),
      4
    );

    // 5. Knowledge Documents (DEMO_ONLY vs CLINICIAN_APPROVED)
    const insertKnowledge = db.prepare(`
      INSERT INTO knowledge_document_versions (
        id, version, title, specialty_code, review_status, sections_json, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertKnowledge.run(
      "KB-VN-RESP-01",
      1,
      "[DEMO_ONLY] Simulated Guideline: Primary Evaluation of Chronic Dyspnea, Pulmonary Nodule & Pleural Effusion",
      "RESPIRATORY",
      "DEMO_ONLY",
      JSON.stringify([
        {
          section_id: "SEC-RESP-1",
          heading: "Post-Bronchodilator Spirometry Assessment",
          content:
            "In patients with persistent subacute cough, wheezing, or chronic dyspnea despite ICS/LABA therapy, perform spirometry with bronchodilator reversibility (CAT-SPIRO-BD) to quantify FEV1/FVC and airflow reversibility.",
        },
        {
          section_id: "SEC-RESP-2",
          heading: "Peripheral Blood Eosinophil Count & Total IgE",
          content:
            "Peripheral blood eosinophil count and total IgE (CAT-IGE-EOS) support Type 2 airway inflammation phenotyping when optimizing inhaled corticosteroid regimens.",
        },
        {
          section_id: "SEC-RESP-3",
          heading: "Indications for High-Resolution Chest CT (HRCT Chest)",
          content:
            "Consider non-contrast HRCT chest (CAT-HRCT-CHEST) when an indeterminate pulmonary nodule or suspected bronchiectasis is present; if a recent chest X-ray is already on file without acute red flags, review carefully to avoid duplicate imaging.",
        },
      ]),
      "2026-09-01T00:00:00.000Z"
    );

    insertKnowledge.run(
      "KB-VN-RESP-02",
      1,
      "Minh An Network Protocol (Clinician Approved): Mycobacterial Screening & Arterial Blood Gas in Respiratory Consults",
      "RESPIRATORY",
      "CLINICIAN_APPROVED",
      JSON.stringify([
        {
          section_id: "SEC-RESP-201",
          heading: "Sputum AFB Smear & GeneXpert MTB/RIF Screening",
          content:
            "For patients with cough lasting > 3 weeks accompanied by weight loss or upper-lobe pulmonary opacity, consider sputum AFB smear and GeneXpert MTB/RIF (CAT-AFB-XPERT).",
        },
        {
          section_id: "SEC-RESP-202",
          heading: "Arterial Blood Gas Analysis When SpO2 Declines",
          content:
            "Consider arterial blood gas analysis (CAT-ABG) when resting SpO2 is < 94% or chronic hypercapnic respiratory insufficiency is suspected.",
        },
      ]),
      "2026-08-15T00:00:00.000Z"
    );

    insertKnowledge.run(
      "KB-VN-CARD-01",
      1,
      "[DEMO_ONLY] Simulated Guideline: Differentiating Dyspnea & Suspected Heart Failure in Outpatient Clinics",
      "CARDIOLOGY",
      "DEMO_ONLY",
      JSON.stringify([
        {
          section_id: "SEC-CARD-1",
          heading: "Serum NT-proBNP & Transthoracic Echocardiography",
          content:
            "In patients presenting with exertional dyspnea, ankle edema, or atrial fibrillation, serum NT-proBNP (CAT-NTPROBNP) and transthoracic Doppler echocardiography (CAT-ECHO-TTE) stratify heart failure risk.",
        },
      ]),
      "2026-09-10T00:00:00.000Z"
    );

    // 6. Test Catalog Entries (7 entries)
    const insertCatalog = db.prepare(`
      INSERT INTO test_catalog_entries (
        id, code, name_vi, modality, typical_turnaround_hours, contraindication_notes_json, active
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
    `);

    insertCatalog.run(
      "CAT-SPIRO-BD",
      "SPIRO_POST_BD",
      "Spirometry with Post-Bronchodilator Reversibility Test",
      "Pulmonary Function",
      2,
      JSON.stringify([
        "Contraindicated in active hemoptysis or untreated pneumothorax",
      ])
    );
    insertCatalog.run(
      "CAT-IGE-EOS",
      "CBC_EOS_TOTAL_IGE",
      "Peripheral Blood Eosinophil Count & Total Serum IgE",
      "Hematology & Immunology",
      3,
      JSON.stringify([
        "Document any recent systemic corticosteroid use prior to sampling",
      ])
    );
    insertCatalog.run(
      "CAT-HRCT-CHEST",
      "HRCT_CHEST_NON_CONTRAST",
      "High-Resolution Chest CT (Non-Contrast HRCT)",
      "Diagnostic Imaging",
      4,
      JSON.stringify([
        "Consider radiation exposure and compare against existing chest X-ray films",
      ])
    );
    insertCatalog.run(
      "CAT-ABG",
      "ARTERIAL_BLOOD_GAS",
      "Arterial Blood Gas Analysis (ABG)",
      "Point-of-Care Chemistry",
      1,
      JSON.stringify([
        "Verify collateral radial artery perfusion (Allen test) prior to puncture",
      ])
    );
    insertCatalog.run(
      "CAT-AFB-XPERT",
      "SPUTUM_AFB_GENEXPERT",
      "Sputum AFB Smear & GeneXpert MTB/RIF Assay",
      "Microbiology",
      12,
      JSON.stringify([
        "Instruct patient on deep early-morning sputum collection",
      ])
    );
    insertCatalog.run(
      "CAT-NTPROBNP",
      "SERUM_NT_PROBNP",
      "Serum NT-proBNP Natriuretic Peptide Assay",
      "Cardiac Biomarker",
      2,
      JSON.stringify(["Interpret cutoffs alongside patient age and eGFR"]),
    );
    insertCatalog.run(
      "CAT-ECHO-TTE",
      "ECHO_TRANSTHORACIC_DOPPLER",
      "Transthoracic Doppler Echocardiogram (TTE)",
      "Cardiac Imaging",
      4,
      JSON.stringify([])
    );

    // 7. Helper to create case documents
    const insertDoc = db.prepare(`
      INSERT INTO document_versions (
        id, case_id, version, filename, doc_type, mime_type,
        storage_path, extracted_text, segments_json, uploaded_by, created_at
      ) VALUES (?, ?, ?, ?, ?, 'text/plain', ?, ?, ?, ?, ?)
    `);

    const addDoc = (
      id: string,
      caseId: string,
      version: number,
      filename: string,
      docType: string,
      rawText: string,
      uploadedBy: string,
      createdAt: string
    ) => {
      const parsed = parseClinicalTextDocument(filename, rawText, "text/plain");
      const storagePath = writePrivateDocumentFile(
        caseId,
        id,
        version,
        filename,
        parsed.normalizedText
      );
      insertDoc.run(
        id,
        caseId,
        version,
        filename,
        docType,
        storagePath,
        parsed.normalizedText,
        JSON.stringify(parsed.segments),
        uploadedBy,
        createdAt
      );
    };

    // 8. Seed Cases (Case A, Case B, Case C + active workload cases)
    const insertCase = db.prepare(`
      INSERT INTO cases (
        id, case_code, organization_id, referring_clinician_id,
        patient_label, patient_age_band, patient_sex,
        title, clinical_question, specialty_requested,
        secondary_specialties_json, topic_tags_json, language_required,
        urgency_tier, status, input_version, snapshot_version,
        accepted_specialist_id, draft_created_at, review_completed_at,
        invitation_sent_at, accepted_at, first_specialist_response_at,
        answered_at, closed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // --- CASE A: Primary End-to-End Demo Case (CASE-DEMO-001) ---
    insertCase.run(
      "CASE-DEMO-001",
      "CB-AB-2026-014",
      "ORG-AN-BINH",
      "USR-REF-01",
      "PT-AB-014 (Male, 50–59 yrs)",
      "50–59 yrs",
      "Male",
      "5-Week Subacute Cough with Right Upper-Lobe Pulmonary Nodule & Exertional Dyspnea",
      "What is the recommended diagnostic and management strategy for a 16mm right upper-lobe pulmonary nodule with mild pleural effusion and persistent dyspnea at the primary clinic prior to referral?",
      "RESPIRATORY",
      JSON.stringify(["INTERNAL_MEDICINE"]),
      JSON.stringify(["pleural_effusion", "pulmonary_nodule", "subacute_cough"]),
      "PRIORITY",
      "DRAFT",
      1,
      0,
      null,
      iso(-35),
      null,
      null,
      null,
      null,
      null,
      null,
      iso(-35),
      iso(-30)
    );

    const doc1Text = [
      "OUTPATIENT CLINICAL NOTE — AN BINH POLYCLINIC (SYNTHETIC DEMO DATA)",
      "Patient: Male, age band 50–59. Chief complaint: persistent dry cough for 5 weeks, mild exertional dyspnea, and dull right-sided chest discomfort.",
      "Clinical course: Completed 7 days of oral empiric antibiotics and maintenance ICS/LABA inhaler at a local clinic without improvement in cough or wheezing.",
      "History: 15 pack-year smoking history; hypertension controlled on Amlodipine 5mg daily. Patient mentioned a chest X-ray taken 6 months ago at another clinic, but the prior film is not yet available.",
    ].join("\n");

    const doc2Text = [
      "BASELINE DIAGNOSTIC RESULTS — AN BINH POLYCLINIC (SYNTHETIC DEMO DATA)",
      "1. Chest X-ray (PA view, 2 weeks ago): Shows an approximately 16mm indeterminate nodule in the right infraclavicular zone with mild blunting of the right costophrenic angle.",
      "2. Complete Blood Count (24 hours ago): WBC 9.4 G/L; peripheral blood Eosinophil count 420 cells/uL (4.5%); Hemoglobin 134 g/L; Platelets 265 G/L.",
      "3. Basic Chemistry: Fasting glucose 5.6 mmol/L; Serum creatinine 84 umol/L (eGFR 86 mL/min/1.73m2). Post-bronchodilator spirometry and HRCT chest have not yet been performed.",
    ].join("\n");

    addDoc(
      "DOC-DEMO-001",
      "CASE-DEMO-001",
      1,
      "DOC-01_outpatient_clinical_note.txt",
      "CLINICAL_NOTE",
      doc1Text,
      "USR-REF-01",
      iso(-34)
    );

    addDoc(
      "DOC-DEMO-002",
      "CASE-DEMO-001",
      1,
      "DOC-02_chest_xray_and_baseline_labs.txt",
      "LAB_AND_IMAGING",
      doc2Text,
      "USR-REF-01",
      iso(-33)
    );

    db.prepare(`
      INSERT INTO clinical_assessments (
        id, case_id, version, case_input_version, author_id,
        working_impression, differential_diagnoses_json,
        red_flags_checked_json, unresolved_questions_json,
        urgency_level, rationale_notes, created_at
      ) VALUES (?, ?, 1, 1, 'USR-REF-01', ?, ?, ?, ?, 'NON_EMERGENT_SPECIALIST_CONSULT', ?, ?)
    `).run(
      "ASSESS-CASE-DEMO-001-V1",
      "CASE-DEMO-001",
      "Uncontrolled chronic airway disease with a 16mm right upper-lobe pulmonary nodule requiring exclusion of focal parenchymal or infectious etiology.",
      JSON.stringify([
        "Uncontrolled COPD / Asthma-COPD Overlap (ACOS)",
        "Solitary right upper-lobe pulmonary nodule with mild pleural reaction (rule out mycobacterial vs. neoplastic process)",
      ]),
      JSON.stringify([
        "No acute respiratory distress (resting SpO2 95% on room air)",
        "Hemodynamically stable (BP 130/80 mmHg)",
      ]),
      JSON.stringify([
        "Need objective post-bronchodilator spirometry to quantify airflow obstruction",
        "Clarify whether to perform non-contrast HRCT chest locally or refer directly to Pulmonology",
      ]),
      "Patient exhibits both persistent airway symptoms and a focal upper-lobe opacity on recent chest X-ray; prior 6-month baseline film is still missing.",
      iso(-31)
    );

    // --- CASE B: Ambiguous Referral Question Case (CASE-DEMO-002) ---
    insertCase.run(
      "CASE-DEMO-002",
      "CB-AB-2026-018",
      "ORG-AN-BINH",
      "USR-REF-01",
      "PT-AB-018 (Female, 60–69 yrs)",
      "60–69 yrs",
      "Female",
      "Progressive Exertional Dyspnea & Bilateral Ankle Edema with History of Hypertension and Mild COPD",
      "Please advise",
      "RESPIRATORY",
      JSON.stringify(["CARDIOLOGY"]),
      JSON.stringify(["subacute_cough", "copd"]),
      "ROUTINE",
      "DRAFT",
      1,
      0,
      null,
      iso(-90),
      null,
      null,
      null,
      null,
      null,
      null,
      iso(-90),
      iso(-85)
    );

    const caseBDocText = [
      "INITIAL INTAKE NOTE — CASE CB-AB-2026-018 (SYNTHETIC DEMO DATA)",
      "Patient: Female, age band 60–69. Presenting with progressively worsening dyspnea when climbing stairs over the past 2 weeks.",
      "History: 8-year history of hypertension and mild GOLD Group A COPD using rescue bronchodilator inhaler as needed. Notes mild evening bilateral ankle edema.",
      "Baseline exam: Pulse 88 bpm, BP 145/85 mmHg, SpO2 94% on room air. Transthoracic echocardiogram, serum NT-proBNP, and repeat spirometry have not yet been performed.",
    ].join("\n");

    addDoc(
      "DOC-DEMO-B01",
      "CASE-DEMO-002",
      1,
      "DOC-B01_dyspnea_intake_note.txt",
      "CLINICAL_NOTE",
      caseBDocText,
      "USR-REF-01",
      iso(-88)
    );

    // --- CASE C: Zero Available Specialist Case (CASE-DEMO-003) ---
    insertCase.run(
      "CASE-DEMO-003",
      "CB-AB-2026-021",
      "ORG-AN-BINH",
      "USR-REF-01",
      "PT-AB-021 (Male, 60–69 yrs)",
      "60–69 yrs",
      "Male",
      "Orthopnea & Atrial Fibrillation with Moderate Ventricular Response Suspected of HFpEF",
      "Requesting Cardiology guidance on ventricular rate control and prioritizing NT-proBNP / Doppler echocardiography for atrial fibrillation with orthopnea.",
      "CARDIOLOGY",
      JSON.stringify([]),
      JSON.stringify(["heart_failure", "arrhythmia"]),
      "PRIORITY",
      "WAITING_MATCH",
      1,
      1,
      null,
      iso(-120),
      iso(-75),
      null,
      null,
      null,
      null,
      null,
      iso(-120),
      iso(-75)
    );

    const caseCDocText = [
      "CARDIOLOGY CONSULTATION SUMMARY — CASE CB-AB-2026-021 (SYNTHETIC DEMO DATA)",
      "Patient: Male, age band 60–69, presenting with fatigue and orthopnea for the past 10 days.",
      "12-Lead ECG at An Binh Polyclinic: Atrial fibrillation with ventricular response of 92 bpm, no acute ST-T elevation.",
      "Vitals: BP 138/82 mmHg, SpO2 96%. Serum NT-proBNP and transthoracic Doppler echocardiography are not yet available.",
    ].join("\n");

    addDoc(
      "DOC-DEMO-C01",
      "CASE-DEMO-003",
      1,
      "DOC-C01_cardiology_note_and_ecg.txt",
      "CLINICAL_NOTE",
      caseCDocText,
      "USR-REF-01",
      iso(-115)
    );

    const caseCSummary = [
      {
        key: "reason_for_consult",
        title: "1. Reason for Consultation",
        claims: [
          {
            id: "CL-C1",
            text: "Cardiology consultation requested regarding ventricular rate control and diagnostic workup for atrial fibrillation with orthopnea.",
            source_refs: [
              { document_id: "DOC-DEMO-C01", version: 1, segment_id: "S-002" },
              { document_id: "DOC-DEMO-C01", version: 1, segment_id: "S-003" },
            ],
            provenance: "AI_DRAFT",
          },
        ],
      },
    ];

    const caseCQuestions = [
      {
        id: "Q-C1",
        text: "Should we complete serum NT-proBNP and transthoracic echocardiography locally before rate-control titration, or refer directly to Cardiology?",
        source_refs: [
          { document_id: "DOC-DEMO-C01", version: 1, segment_id: "S-004" },
        ],
        provenance: "AI_DRAFT",
        selected: true,
      },
    ];

    db.prepare(`
      INSERT INTO referral_snapshots (
        id, case_id, version, input_version, preparation_run_id,
        summary_sections_json, unknowns_json, contradictions_json,
        questions_json, selected_specialties_json, manual_edits_json,
        confirmed_by, created_at
      ) VALUES (?, ?, 1, 1, NULL, ?, '[]', '[]', ?, ?, '[]', 'USR-REF-01', ?)
    `).run(
      "SNAP-CASE-DEMO-003-V1",
      "CASE-DEMO-003",
      JSON.stringify(caseCSummary),
      JSON.stringify(caseCQuestions),
      JSON.stringify(["CARDIOLOGY"]),
      iso(-75)
    );

    // 9. Seed active consultations to reflect real specialist active_cases load & dashboard metrics!
    const seedWorkloadCase = (
      caseId: string,
      conId: string,
      code: string,
      specialistId: string,
      specialty: string,
      status: "IN_CONSULTATION" | "ANSWERED",
      createdAgoMin: number,
      reviewedAgoMin: number,
      invitedAgoMin: number,
      acceptedAgoMin: number,
      answeredAgoMin: number | null
    ) => {
      insertCase.run(
        caseId,
        code,
        "ORG-AN-BINH",
        "USR-REF-01",
        `PT-${code.slice(-3)} (40–49 yrs)`,
        "40–49 yrs",
        "Male",
        `${
          specialty === "RESPIRATORY"
            ? "Pulmonology"
            : specialty === "CARDIOLOGY"
              ? "Cardiology"
              : "Internal Medicine"
        } Consultation — Case ${code}`,
        `Requesting outpatient regimen review for case ${code}`,
        specialty,
        JSON.stringify([]),
        JSON.stringify(["subacute_cough"]),
        "ROUTINE",
        status,
        1,
        1,
        specialistId,
        iso(-createdAgoMin),
        iso(-reviewedAgoMin),
        iso(-invitedAgoMin),
        iso(-acceptedAgoMin),
        answeredAgoMin ? iso(-answeredAgoMin) : iso(-acceptedAgoMin + 5),
        answeredAgoMin ? iso(-answeredAgoMin) : null,
        null,
        iso(-createdAgoMin),
        iso(-(answeredAgoMin || acceptedAgoMin))
      );

      const snapId = `SNAP-${caseId}-V1`;
      const invId = `INV-${caseId}-01`;

      db.prepare(`
        INSERT INTO referral_snapshots (
          id, case_id, version, input_version, preparation_run_id,
          summary_sections_json, unknowns_json, contradictions_json,
          questions_json, selected_specialties_json, manual_edits_json,
          confirmed_by, created_at
        ) VALUES (?, ?, 1, 1, NULL, '[]', '[]', '[]', ?, ?, '[]', 'USR-REF-01', ?)
      `).run(
        snapId,
        caseId,
        JSON.stringify([
          {
            id: "Q-1",
            text: `Consultation question for case ${code}`,
            source_refs: [],
            provenance: "CLINICIAN_EDIT",
            selected: true,
          },
        ]),
        JSON.stringify([specialty]),
        iso(-reviewedAgoMin)
      );

      db.prepare(`
        INSERT INTO invitations (
          id, case_id, snapshot_id, specialist_id, status,
          fallback_enabled, fallback_queue_json, preview_summary_json,
          sent_by, sent_at, expires_at, responded_at
        ) VALUES (?, ?, ?, ?, 'ACCEPTED', 0, '[]', ?, 'USR-REF-01', ?, ?, ?)
      `).run(
        invId,
        caseId,
        snapId,
        specialistId,
        JSON.stringify({
          case_code: code,
          referring_organization: "An Binh Community Polyclinic",
          specialty_requested: specialty,
          patient_age_band: "40–49 yrs",
          patient_sex: "Male",
          brief_title: `Confirmed referral package for case ${code}`,
          primary_question: `Consultation question for case ${code}`,
          snapshot_version: 1,
          urgency_tier: "ROUTINE",
        }),
        iso(-invitedAgoMin),
        iso(-invitedAgoMin + 60),
        iso(-acceptedAgoMin)
      );

      db.prepare(`
        INSERT INTO consultations (
          id, case_id, invitation_id, referring_clinician_id,
          specialist_id, snapshot_id, opened_at, closed_at
        ) VALUES (?, ?, ?, 'USR-REF-01', ?, ?, ?, NULL)
      `).run(
        conId,
        caseId,
        invId,
        specialistId,
        snapId,
        iso(-acceptedAgoMin)
      );

      if (status === "ANSWERED" && answeredAgoMin) {
        db.prepare(`
          INSERT INTO consultation_responses (
            id, consultation_id, author_id, question_answers_json,
            clinical_recommendations, limitations, is_demo_sample, version, submitted_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
        `).run(
          `RESP-${caseId}-01`,
          conId,
          specialistId,
          JSON.stringify([
            {
              question_id: "Q-1",
              question_text: `Consultation question for case ${code}`,
              answer:
                "Reviewed referral package; recommend continuing outpatient therapy with follow-up assessment in 2 weeks.",
            },
          ]),
          "Continue current maintenance regimen and monitor symptom progression.",
          "Recommendations are based on structured text records provided by the referring clinic.",
          iso(-answeredAgoMin)
        );
      }
    };

    // 1 active case for USR-SPEC-01 (1/3 active)
    seedWorkloadCase(
      "CASE-HIST-001",
      "CON-DEMO-003",
      "CB-AB-2026-009",
      "USR-SPEC-01",
      "RESPIRATORY",
      "IN_CONSULTATION",
      180,
      162,
      160,
      148,
      null
    );

    // 1 answered case for USR-SPEC-01
    seedWorkloadCase(
      "CASE-HIST-002",
      "CON-HIST-002",
      "CB-AB-2026-004",
      "USR-SPEC-01",
      "RESPIRATORY",
      "ANSWERED",
      320,
      295,
      290,
      272,
      210
    );

    // 3 active cases for USR-SPEC-02 (3/3 active)
    seedWorkloadCase(
      "CASE-LOAD-01",
      "CON-LOAD-01",
      "CB-AB-2026-010",
      "USR-SPEC-02",
      "CARDIOLOGY",
      "IN_CONSULTATION",
      240,
      220,
      215,
      200,
      null
    );
    seedWorkloadCase(
      "CASE-LOAD-02",
      "CON-LOAD-02",
      "CB-AB-2026-011",
      "USR-SPEC-02",
      "RESPIRATORY",
      "IN_CONSULTATION",
      210,
      195,
      190,
      175,
      null
    );
    seedWorkloadCase(
      "CASE-LOAD-03",
      "CON-LOAD-03",
      "CB-AB-2026-012",
      "USR-SPEC-02",
      "CARDIOLOGY",
      "IN_CONSULTATION",
      150,
      135,
      130,
      118,
      null
    );

    // 2 active cases for USR-SPEC-05 (2/4 active)
    seedWorkloadCase(
      "CASE-LOAD-04",
      "CON-LOAD-04",
      "CB-AB-2026-013",
      "USR-SPEC-05",
      "INTERNAL_MEDICINE",
      "IN_CONSULTATION",
      190,
      175,
      170,
      155,
      null
    );
    seedWorkloadCase(
      "CASE-LOAD-05",
      "CON-LOAD-05",
      "CB-AB-2026-015",
      "USR-SPEC-05",
      "RESPIRATORY",
      "IN_CONSULTATION",
      140,
      125,
      120,
      105,
      null
    );

    // 10. GovernanceLink (pending QEA role grant for Dr. Hoang Nam Pham)
    db.prepare(`
      INSERT INTO governance_links (
        id, tide_change_request_id, target_user_id, requested_action,
        role_name, status_source, last_observed_status, approvals_observed,
        threshold_observed, ready_to_commit, checked_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "GOV-LINK-001",
      "b9cef8cc-cc88-4af2-8b9c-eece1800b640",
      "USR-SPEC-03",
      "GRANT_ROLES",
      "network_consultant",
      "TIDE_IGA_SYNC",
      "PENDING",
      1,
      2,
      0,
      iso(-10),
      "Proposal to grant 'network_consultant' role to Dr. Hoang Nam Pham. Currently holds 1/2 independent admin signatures (quorum threshold for N=3 admins is max(1, floor(0.7*3)) = 2). Excluded from specialist matching until quorum is met."
    );

    // 11. Reference Cases (P1: Curated Network Reference Case Library)
    const insertRefCase = db.prepare(`
      INSERT INTO reference_cases (
        id, title, specialty_code, summary_approved, relevant_features_json,
        consultation_questions_json, approved_response_excerpt,
        source_organization_name, published_at, allowed_org_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertRefCase.run(
      "REF-RESP-2026-01",
      "Reference Case #1: Solitary Upper-Lobe Pulmonary Nodule with Mild Pleural Effusion in a Former Smoker",
      "RESPIRATORY",
      "Male patient aged 50–59 presenting with subacute cough > 4 weeks, mild weight loss, and a chest X-ray showing an upper-lobe nodule with mild ipsilateral pleural effusion. Referring clinic coordinated post-bronchodilator spirometry and non-contrast HRCT in parallel with Pulmonology consult.",
      JSON.stringify({
        similarities: [
          "Age band 50–59, smoking history, subacute cough > 4 weeks with exertional dyspnea",
          "Chest X-ray shows an upper-lobe nodular opacity with mild ipsilateral costophrenic blunting",
        ],
        differences: [
          "Reference case had a prior 12-month chest X-ray available for comparison; current case is missing the 6-month prior film",
          "Reference case completed thoracic ultrasound measuring an 18mm pleural fluid pocket prior to consult",
        ],
        to_clarify: [
          "Clarify presence of evening fevers, night sweats, or tuberculosis exposure",
          "Evaluate spirometry and consider non-contrast HRCT if parenchymal lesion remains indeterminate",
        ],
      }),
      JSON.stringify([
        "For a 16mm upper-lobe nodule with mild pleural effusion, should we prioritize local non-contrast HRCT and sputum AFB/GeneXpert before referral?",
        "How should maintenance bronchodilator therapy be adjusted while awaiting imaging?",
      ]),
      "Pulmonology Recommendation: Do not delay specialist consultation. Perform post-bronchodilator spirometry to quantify airflow limitation and obtain non-contrast HRCT chest to characterize the parenchymal lesion and mediastinum.",
      "Minh An Tertiary Specialist Center (Curated & De-identified)",
      "2026-09-15T08:00:00.000Z",
      JSON.stringify(["ORG-AN-BINH", "ORG-MINH-AN"])
    );

    insertRefCase.run(
      "REF-RESP-2026-02",
      "Reference Case #2: Differentiating Mild COPD Progression from Concomitant Heart Failure in an Older Adult",
      "RESPIRATORY",
      "Patient aged 60–69 with hypertension and mild COPD presenting with progressive exertional dyspnea and bilateral ankle edema. Consultation helped clarify cardiac vs. pulmonary contribution prior to inhaler escalation.",
      JSON.stringify({
        similarities: [
          "Progressive exertional dyspnea over 2 weeks on a background of hypertension and chronic airway disease",
          "Presence of peripheral fluid retention (mild bilateral ankle edema)",
        ],
        differences: [
          "Reference case had markedly elevated NT-proBNP documented prior to referral",
        ],
        to_clarify: [
          "Presence of orthopnea or paroxysmal nocturnal dyspnea?",
          "Heart rate and rhythm on 12-lead ECG (rule out atrial fibrillation)?",
        ],
      }),
      JSON.stringify([
        "In a patient with mild COPD presenting with exertional dyspnea and ankle edema, should we prioritize heart failure screening (NT-proBNP, TTE) before escalating bronchodilators?",
      ]),
      "Specialist Recommendation: When peripheral edema or orthopnea is present, do not attribute all dyspnea to COPD; obtain 12-lead ECG, serum NT-proBNP, and transthoracic echocardiography.",
      "Minh An Tertiary Specialist Center (Curated & De-identified)",
      "2026-09-20T09:30:00.000Z",
      JSON.stringify(["ORG-AN-BINH", "ORG-MINH-AN"])
    );
  });

  const drKhoaActor: ActorContext = {
    userId: "USR-REF-01",
    tideSubject: "dr_khoa",
    displayName: "Doctor",
    role: "referring_clinician",
    title: "General Internist — Referring Clinic",
    email: "khoa.anbinh@casebridge.demo",
    organizationId: "ORG-AN-BINH",
    organizationName: "An Binh Community Polyclinic",
    tideRoles: ["_tide_enabled", "appUser", "referring_clinician"],
    hasProtectedNetworkRole: false,
    authSource: "demo_dpop",
  };
  // prepareCase("CASE-DEMO-001", drKhoaActor, { mode: "fixture" });
  prepareCase("CASE-DEMO-002", drKhoaActor, { mode: "fixture" });
}
