"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAppSession,
  ParallaxHero,
  ParallaxCard,
} from "@/components/AppShell";
import {
  CASE_STATUS_LABELS,
  SPECIALTY_LABELS,
  type CaseStatus,
  type SpecialtyCode,
} from "@/lib/types";
import {
  PlusCircle,
  Clock,
  CheckCircle2,
  ArrowRight,
  FileText,
  Users,
  ShieldAlert,
  Sparkles,
  Activity,
} from "lucide-react";

interface WorkspaceCaseItem {
  id: string;
  case_code: string;
  organization_id: string;
  organization_name: string;
  referring_clinician_id: string;
  referring_clinician_name: string;
  patient_label: string;
  patient_age_band: string;
  patient_sex: string;
  title: string;
  clinical_question: string | null;
  specialty_requested: SpecialtyCode;
  urgency_tier: string;
  status: CaseStatus;
  input_version: number;
  snapshot_version: number;
  waiting_age_minutes: number | null;
  latest_invitation: {
    id: string;
    specialist_id: string;
    specialist_name: string;
    status: string;
    expires_at: string;
  } | null;
  consultation: {
    id: string;
    specialist_id: string;
    specialist_name: string;
  } | null;
  clinical_payload_redacted: boolean;
}

// 2-minute demo: metrics strip hidden
const SHOW_METRICS = false as boolean;

interface TurnaroundMetrics {
  sample_size_total_cases: number;
  prep_time_avg_minutes: number | null;
  prep_time_sample_size: number;
  match_time_avg_minutes: number | null;
  match_time_sample_size: number;
  invite_accept_avg_minutes: number | null;
  invite_accept_sample_size: number;
  first_response_avg_minutes: number | null;
  first_response_sample_size: number;
  waiting_unmatched_cases_count: number;
}

const STATUS_BADGE_STYLES: Record<CaseStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-700 border-slate-300",
  READY: "bg-sky-50 text-sky-800 border-sky-200",
  WAITING_MATCH: "bg-amber-50 text-amber-800 border-amber-200",
  INVITED: "bg-indigo-50 text-indigo-800 border-indigo-200",
  IN_CONSULTATION: "bg-rose-50 text-rose-700 border-rose-200",
  NEEDS_INFO: "bg-orange-50 text-orange-800 border-orange-300",
  ANSWERED: "bg-emerald-50 text-emerald-800 border-emerald-200",
  CLOSED: "bg-slate-200 text-slate-700 border-slate-300",
  CANCELLED: "bg-rose-50 text-rose-800 border-rose-200",
};

export default function WorkspacePage() {
  const { actor, apiFetch, switchPersona } = useAppSession();
  const router = useRouter();

  const [cases, setCases] = useState<WorkspaceCaseItem[]>([]);
  const [metrics, setMetrics] = useState<TurnaroundMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPatientLabel, setNewPatientLabel] = useState(
    "PT-AB-099 (Male, 50–59 yrs)"
  );
  const [newSpecialty, setNewSpecialty] =
    useState<SpecialtyCode>("RESPIRATORY");
  const [newQuestion, setNewQuestion] = useState("");
  const [newDocContent, setNewDocContent] = useState(
    "Patient male 55 yrs presenting with subacute cough for 4 weeks and exertional dyspnea.\nCompleted 7 days of empiric oral antibiotics without improvement.\nChest X-ray 1 week ago showed mild right lower-zone opacity; post-bronchodilator spirometry not yet performed."
  );
  const [creating, setCreating] = useState(false);

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        cases: WorkspaceCaseItem[];
        metrics: TurnaroundMetrics;
      }>("/api/cases");
      setCases(data.cases);
      setMetrics(data.metrics);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load workspace cases."
      );
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (actor) {
      loadWorkspace();
    }
  }, [actor, loadWorkspace]);

  const handleCreateCase = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const created = await apiFetch<{ case: { id: string } }>("/api/cases", {
        method: "POST",
        json: {
          title: newTitle,
          patient_label: newPatientLabel,
          patient_age_band: "50–59 yrs",
          patient_sex: "Male",
          specialty_requested: newSpecialty,
          clinical_question: newQuestion,
          topic_tags: ["subacute_cough", "pulmonary_nodule"],
          initial_document: {
            filename: "initial_clinical_note.txt",
            content: newDocContent,
          },
        },
      });
      setShowCreateModal(false);
      router.push(`/cases/${created.case.id}/prepare`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create case.");
    } finally {
      setCreating(false);
    }
  };

  const featuredDemoCases = cases.filter((c) =>
    ["CASE-DEMO-001", "CASE-DEMO-002", "CASE-DEMO-003"].includes(c.id)
  );

  return (
    <div className="space-y-6">
      <ParallaxHero
        badge="TIDECLOAK QEA + GROUNDED CLINICAL PACKAGING"
        title="Clinical Consultation Coordination Workspace"
        subtitle="Transform fragmented outpatient records into source-grounded consultation packages, review diagnostic suggestions, and route cases to verified specialists."
        rightContent={
          actor?.role === "referring_clinician" ? (
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="px-4 py-2.5 rounded-xl bg-rose-500 hover:bg-rose-400 text-slate-950 text-sm font-bold flex items-center gap-2 shadow-lg transition cursor-pointer"
            >
              <PlusCircle className="w-4 h-4" />
              <span>New Consultation Case</span>
            </button>
          ) : null
        }
      />

      {/* Role Boundary Notice for Coordinator / Admin */}
      {(actor?.role === "coordinator" || actor?.role === "network_admin") && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3.5 text-xs text-indigo-950 flex items-center gap-2.5">
          <ShieldAlert className="w-4 h-4 text-indigo-700 shrink-0" />
          <div>
            <strong>Zero Clinical Exposure Boundary:</strong> As{" "}
            <code className="font-mono font-bold">{actor.role}</code>, clinical
            notes and patient descriptions are automatically redacted on the
            server. You only see operational routing metadata.
          </div>
        </div>
      )}

      {actor && actor.role !== "referring_clinician" && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-sm text-amber-950 flex flex-wrap items-center justify-between gap-3">
          <span>
            You are signed in as <strong>{actor.displayName}</strong>. Demo
            cases belong to the Doctor.
          </span>
          <button
            type="button"
            onClick={() => switchPersona("USR-REF-01")}
            className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-500 text-white font-bold cursor-pointer"
          >
            Switch to Doctor
          </button>
        </div>
      )}

      {/* 3 Core Demo Scenarios (Case A, Case B, Case C) with 3D Parallax Tilt */}
      {featuredDemoCases.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-rose-500" />
              <span>3 Core Interactive Demo Scenarios</span>
            </h2>
            <span className="text-xs text-slate-500">
              Hover cards for 3D parallax • Click to launch scenario
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {featuredDemoCases.map((c) => {
              const scenarioLabel =
                c.id === "CASE-DEMO-001"
                  ? "Scenario A • End-to-End Happy Path"
                  : c.id === "CASE-DEMO-002"
                    ? "Scenario B • Vague Question Clarification"
                    : "Scenario C • Zero Available Specialists (QEA Pending)";
              const targetHref =
                c.status === "WAITING_MATCH" || c.status === "READY"
                  ? `/cases/${c.id}/match`
                  : `/cases/${c.id}/prepare`;

              return (
                <ParallaxCard
                  key={c.id}
                  intensity={6}
                  className="bg-white rounded-xl border border-slate-200/90 p-4 shadow-sm hover:shadow-xl hover:border-rose-400 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200">
                        {scenarioLabel}
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                          STATUS_BADGE_STYLES[c.status]
                        }`}
                      >
                        {CASE_STATUS_LABELS[c.status]}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-500 mb-1">
                      {c.case_code} • {SPECIALTY_LABELS[c.specialty_requested]}
                    </div>
                    <h3 className="font-bold text-sm text-slate-900 line-clamp-2 mb-2">
                      {c.title}
                    </h3>
                    {c.clinical_question && (
                      <p className="text-xs text-slate-600 bg-slate-50 rounded-lg p-2 border border-slate-100 line-clamp-2">
                        <strong>Question:</strong> {c.clinical_question}
                      </p>
                    )}
                  </div>
                  <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <span className="text-[11px] text-slate-500">
                      Source v{c.input_version} • Snapshot v{c.snapshot_version}
                    </span>
                    <Link
                      href={targetHref}
                      className="inline-flex items-center gap-1 text-xs font-bold text-rose-600 font-medium hover:text-rose-500"
                    >
                      <span>
                        {c.status === "WAITING_MATCH"
                          ? "Inspect Matching"
                          : "Open Package"}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  </div>
                </ParallaxCard>
              );
            })}
          </div>
        </div>
      )}

      {/* Turnaround Metrics Strip */}
      {metrics && SHOW_METRICS && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
          <ParallaxCard className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
            <div className="text-xs text-slate-500 font-medium flex items-center justify-between">
              <span>Avg Package Prep Time</span>
              <Clock className="w-4 h-4 text-rose-500" />
            </div>
            <div className="text-2xl font-bold text-slate-900 mt-1">
              {metrics.prep_time_avg_minutes ?? "—"} min
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Draft → Snapshot ({metrics.prep_time_sample_size} cases)
            </div>
          </ParallaxCard>

          <ParallaxCard className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
            <div className="text-xs text-slate-500 font-medium flex items-center justify-between">
              <span>Avg Specialist Match Time</span>
              <Users className="w-4 h-4 text-sky-600" />
            </div>
            <div className="text-2xl font-bold text-slate-900 mt-1">
              {metrics.match_time_avg_minutes ?? "—"} min
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Snapshot → Accepted ({metrics.match_time_sample_size} cases)
            </div>
          </ParallaxCard>

          <ParallaxCard className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
            <div className="text-xs text-slate-500 font-medium flex items-center justify-between">
              <span>First Specialist Response</span>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            </div>
            <div className="text-2xl font-bold text-slate-900 mt-1">
              {metrics.first_response_avg_minutes ?? "—"} min
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Accepted → Response ({metrics.first_response_sample_size} cases)
            </div>
          </ParallaxCard>

          <ParallaxCard className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs">
            <div className="text-xs text-slate-500 font-medium flex items-center justify-between">
              <span>Cases Awaiting Match</span>
              <Activity className="w-4 h-4 text-amber-600" />
            </div>
            <div className="text-2xl font-bold text-amber-700 mt-1">
              {metrics.waiting_unmatched_cases_count} cases
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Total network sample: {metrics.sample_size_total_cases} cases
            </div>
          </ParallaxCard>
        </div>
      )}

      {/* Full Case Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-xs font-bold uppercase tracking-wider text-slate-600">
            All Consultation Cases ({cases.length})
          </div>
          <div className="text-xs text-slate-500">
            Real-time SQLite state + Tide QEA access enforcement
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">
            Loading consultation cases...
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-rose-700 bg-rose-50">{error}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[11px] font-semibold uppercase text-slate-500 bg-slate-50/60">
                  <th className="py-2.5 px-4">Case & Patient</th>
                  <th className="py-2.5 px-4">Clinical Summary / Question</th>
                  <th className="py-2.5 px-4">Specialty</th>
                  <th className="py-2.5 px-4">Status</th>
                  <th className="py-2.5 px-4">Assigned Specialist</th>
                  <th className="py-2.5 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {cases.map((c) => (
                  <tr
                    key={c.id}
                    className="hover:bg-slate-50/80 transition group"
                  >
                    <td className="py-3 px-4 align-top">
                      <div className="font-mono text-xs font-bold text-slate-900">
                        {c.case_code}
                      </div>
                      <div className="text-xs text-slate-600 mt-0.5">
                        {c.patient_label}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        {c.organization_name}
                      </div>
                    </td>

                    <td className="py-3 px-4 align-top max-w-md">
                      <div className="font-medium text-slate-900 line-clamp-1">
                        {c.title}
                      </div>
                      {c.clinical_payload_redacted ? (
                        <span className="inline-block mt-1 text-[11px] text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-200">
                          Clinical payload redacted for {actor?.role}
                        </span>
                      ) : (
                        <div className="text-xs text-slate-500 line-clamp-1 mt-0.5">
                          Q: {c.clinical_question || "Not yet specified"}
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-4 align-top">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-800">
                        {SPECIALTY_LABELS[c.specialty_requested] ||
                          c.specialty_requested}
                      </span>
                    </td>

                    <td className="py-3 px-4 align-top">
                      <span
                        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${
                          STATUS_BADGE_STYLES[c.status]
                        }`}
                      >
                        {CASE_STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>

                    <td className="py-3 px-4 align-top text-xs">
                      {c.consultation ? (
                        <div className="font-medium text-rose-700">
                          {c.consultation.specialist_name}
                        </div>
                      ) : c.latest_invitation ? (
                        <div className="text-slate-600">
                          Invited: {c.latest_invitation.specialist_name} (
                          {c.latest_invitation.status})
                        </div>
                      ) : (
                        <span className="text-slate-400 italic">
                          Not yet assigned
                        </span>
                      )}
                    </td>

                    <td className="py-3 px-4 align-top text-right">
                      <div className="inline-flex items-center gap-1.5">
                        {actor?.role === "referring_clinician" && (
                          <>
                            <Link
                              href={`/cases/${c.id}/prepare`}
                              className="px-2.5 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium inline-flex items-center gap-1 transition"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              <span>Prepare</span>
                            </Link>
                            {["READY", "WAITING_MATCH", "INVITED"].includes(
                              c.status
                            ) && (
                              <Link
                                href={`/cases/${c.id}/match`}
                                className="px-2.5 py-1 rounded-md bg-rose-500 hover:bg-rose-500 text-white text-xs font-medium inline-flex items-center gap-1 transition"
                              >
                                <span>Match</span>
                                <ArrowRight className="w-3.5 h-3.5" />
                              </Link>
                            )}
                          </>
                        )}

                        {c.consultation &&
                          (actor?.role === "referring_clinician" ||
                            actor?.role === "consulting_specialist") && (
                            <Link
                              href={`/consultations/${c.consultation.id}`}
                              className="px-2.5 py-1 rounded-md bg-[#0f2942] hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1 transition"
                            >
                              <span>Consult Room</span>
                              <ArrowRight className="w-3.5 h-3.5" />
                            </Link>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create Case Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 max-w-xl w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h2 className="text-base font-bold text-slate-900">
                Create New Consultation Case
              </h2>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-xs text-slate-500 hover:text-slate-800"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleCreateCase} className="space-y-3.5 text-sm">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    De-identified Patient Label
                  </label>
                  <input
                    type="text"
                    required
                    value={newPatientLabel}
                    onChange={(e) => setNewPatientLabel(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Primary Specialty
                  </label>
                  <select
                    value={newSpecialty}
                    onChange={(e) =>
                      setNewSpecialty(e.target.value as SpecialtyCode)
                    }
                    className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    {Object.entries(SPECIALTY_LABELS).map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Case Title (min 5 chars)
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g., Persistent subacute cough with right upper-lobe opacity"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Initial Consultation Question
                </label>
                <input
                  type="text"
                  placeholder="Write 'Please advise' to test AI question clarification, or enter a specific question"
                  value={newQuestion}
                  onChange={(e) => setNewQuestion(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Clinical Source Note (UTF-8 Text — Auto-segmented into #S-001...)
                </label>
                <textarea
                  rows={4}
                  required
                  value={newDocContent}
                  onChange={(e) => setNewDocContent(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-500 text-white text-xs font-semibold cursor-pointer"
                >
                  {creating ? "Creating..." : "Create & Prepare Package"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
