"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
  MessageSquare,
  FileText,
  FlaskConical,
  CheckCircle2,
  HelpCircle,
  Send,
  Lock,
  Sparkles,
  ShieldAlert,
} from "lucide-react";

export default function ConsultationWorkspacePage() {
  const params = useParams<{ id: string }>();
  const consultationId = params.id;
  const { actor, switchPersona, apiFetch } = useAppSession();

  const [data, setData] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<
    "HANDOVER" | "ASSESSMENT_PLAN" | "MESSAGES_INFO" | "DOCUMENTS" | "RESPONSE"
  >("HANDOVER");

  // Message & InfoRequest States
  const [msgText, setMsgText] = useState("");
  const [infoReqQuestion, setInfoReqQuestion] = useState(
    "Please clarify if the patient has orthopnea, paroxysmal nocturnal dyspnea, or exertional chest pain. If a 12-lead ECG was recorded at the clinic, please attach the summary."
  );
  const [infoReplyText, setInfoReplyText] = useState(
    "Follow-up history & clinic ECG: Patient requires 2 pillows to sleep over the past week; 12-lead ECG shows sinus rhythm 88 bpm, left axis deviation, no acute ST-T changes. Repeats confirm NT-proBNP = 620 pg/mL."
  );

  // Specialist Structured Response States
  const [answersMap, setAnswersMap] = useState<Record<string, string>>({});
  const [recommendations, setRecommendations] = useState("");
  const [limitations, setLimitations] = useState(
    "Recommendations are based on the clinical summary and lab results provided by the referring clinic; direct hemodynamic and SpO2 monitoring is required if symptoms worsen."
  );
  const [isDemoSampleLoaded, setIsDemoSampleLoaded] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const loadWorkspace = useCallback(async () => {
    if (!actor || !consultationId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch<Record<string, any>>(
        `/api/consultations/${consultationId}`
      );
      setData(res);

      const latestSnap = res.case_detail?.snapshots?.[0];
      const qs = latestSnap?.questions || [];
      setAnswersMap((prev) => {
        const next = { ...prev };
        for (const q of qs) {
          if (!next[q.id]) {
            next[q.id] = "";
          }
        }
        return next;
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not access consultation workspace."
      );
    } finally {
      setLoading(false);
    }
  }, [actor, apiFetch, consultationId]);

  useEffect(() => {
    loadWorkspace();
  }, [loadWorkspace]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgText.trim()) return;
    setBusyAction("msg");
    setError(null);
    try {
      await apiFetch(`/api/consultations/${consultationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ body: msgText }),
      });
      setMsgText("");
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message.");
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateInfoRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusyAction("create-ireq");
    setError(null);
    try {
      await apiFetch(
        `/api/consultations/${consultationId}/information-requests`,
        {
          method: "POST",
          body: JSON.stringify({ question: infoReqQuestion }),
        }
      );
      setBannerMsg(
        "Created structured InformationRequest. Case status transitioned to NEEDS_INFO."
      );
      await loadWorkspace();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not create information request."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRespondInfoRequest = async (ireqId: string) => {
    setBusyAction(`reply-${ireqId}`);
    setError(null);
    try {
      const res = await apiFetch<Record<string, any>>(
        `/api/information-requests/${ireqId}/respond`,
        {
          method: "POST",
          body: JSON.stringify({
            response_text: infoReplyText,
            additional_document: {
              filename: "supplemental_ecg_ntprobnp.txt",
              content: infoReplyText,
            },
          }),
        }
      );
      setBannerMsg(
        `Submitted supplemental information and automatically published immutable snapshot ${res.new_snapshot_id} (v${res.new_snapshot_version}). Case status returned to IN_CONSULTATION.`
      );
      await loadWorkspace();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to respond to information request."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleLoadDemoSampleResponse = () => {
    if (!data) return;
    const latestSnap = data.case_detail?.snapshots?.[0];
    const qs = latestSnap?.questions || [];
    const filled: Record<string, string> = {};
    qs.forEach((q: any, idx: number) => {
      filled[q.id] =
        idx === 0
          ? "Evaluate pulmonary function (spirometry with bronchodilator) alongside cardiac evaluation (NT-proBNP and transthoracic echocardiography) before escalating ICS/LABA therapy alone."
          : "Outpatient management is appropriate if room-air SpO2 >= 94% without resting dyspnea; arrange urgent specialist referral if edema progresses or NT-proBNP > 400 pg/mL.";
    });
    setAnswersMap(filled);
    setRecommendations(
      "1. Complete spirometry with bronchodilator testing and transthoracic echocardiography.\n2. Verify inhaler technique and maintain blood pressure control < 130/80 mmHg.\n3. Re-evaluate or send an updated consultation once echocardiography and spirometry results are available."
    );
    setIsDemoSampleLoaded(true);
    setBannerMsg(
      "Loaded sample specialist response into the form (flagged is_demo_sample = true). Review and click 'Submit Official Specialist Response' to save."
    );
  };

  const handleSubmitResponse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;
    setBusyAction("submit-response");
    setError(null);
    try {
      const latestSnap = data.case_detail?.snapshots?.[0];
      const qs = latestSnap?.questions || [];
      const questionAnswers = qs.map((q: any) => ({
        question_id: q.id,
        question_text: q.text,
        answer:
          answersMap[q.id] ||
          "Reviewed and integrated into the clinical recommendations below.",
      }));

      const res = await apiFetch<Record<string, any>>(
        `/api/consultations/${consultationId}/response`,
        {
          method: "POST",
          body: JSON.stringify({
            question_answers: questionAnswers,
            clinical_recommendations: recommendations,
            limitations,
            is_demo_sample: isDemoSampleLoaded,
          }),
        }
      );

      setBannerMsg(
        `Submitted Official Specialist Response ${res.id} (v${res.version}). Case status transitioned to ANSWERED.`
      );
      await loadWorkspace();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not submit specialist response."
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleCloseCase = async () => {
    setBusyAction("close-case");
    setError(null);
    try {
      await apiFetch(`/api/consultations/${consultationId}/close`, {
        method: "POST",
        body: JSON.stringify({
          closure_note:
            "Referring clinician reviewed the specialist recommendations and finalized the outpatient follow-up plan.",
        }),
      });
      setBannerMsg(
        "Closed consultation case (CLOSED). Historical records remain readable by participating clinicians, while further edits are locked."
      );
      await loadWorkspace();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not close case.");
    } finally {
      setBusyAction(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8 bg-white rounded-xl border border-slate-200 text-center text-sm text-slate-500">
        Loading Consultation Workspace...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-xl p-6 text-rose-950 space-y-3">
        <div className="font-bold flex items-center gap-2 text-base">
          <ShieldAlert className="w-5 h-5 text-rose-700" />
          Consultation Access Blocked (Object-Level Authorization)
        </div>
        <p className="text-sm">{error}</p>
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
          <span>Switch to a participating clinician for this consultation:</span>
          <button
            type="button"
            onClick={() => switchPersona("USR-REF-01")}
            className="px-3 py-1.5 rounded bg-white border border-rose-300 font-semibold text-rose-900 hover:bg-rose-100"
          >
            Doctor (Referring Clinician)
          </button>
          <button
            type="button"
            onClick={() => switchPersona("USR-SPEC-01")}
            className="px-3 py-1.5 rounded bg-rose-500 text-white font-semibold hover:bg-rose-600"
          >
            Professor (Consulting Specialist)
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const con = data.consultation;
  const c = data.case_detail.case;
  const snapshots = data.case_detail.snapshots || [];
  const activeSnap = snapshots[0];
  const pinnedQuestions = activeSnap?.questions || [];
  const latestResponse = data.responses?.[0];
  const isClosed = c.status === "CLOSED";

  return (
    <div className="space-y-5">
      {/* 3D Parallax Hero Header */}
      <ParallaxHero
        badge={`${c.case_code} • ${CASE_STATUS_LABELS[c.status as CaseStatus] || c.status} • Snapshot v${activeSnap?.version || 1}`}
        title={c.title}
        subtitle={`Referring: ${con.referring_clinician_name} (${con.referring_organization_name}) • Specialist: ${con.specialist_name} (${con.specialist_organization_name})`}
        variant="indigo"
        rightContent={
          actor?.role === "referring_clinician" && c.status === "ANSWERED" ? (
            <button
              type="button"
              onClick={handleCloseCase}
              disabled={busyAction === "close-case"}
              className="px-4 py-2 rounded-lg bg-rose-400 hover:bg-rose-300 text-slate-950 text-xs font-black flex items-center gap-1.5 shadow-sm"
            >
              <Lock className="w-3.5 h-3.5" />
              Acknowledge & Close Case
            </button>
          ) : undefined
        }
      />

      {error && (
        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {bannerMsg && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{bannerMsg}</span>
        </div>
      )}

      {/* 5 Tabs Navigation */}
      <div className="bg-white rounded-xl border border-slate-200 p-1.5 flex flex-wrap gap-1 shadow-xs">
        {[
          {
            id: "HANDOVER",
            label: `1. Handover Snapshot (v${activeSnap?.version || 1})`,
            icon: FileText,
          },
          {
            id: "ASSESSMENT_PLAN",
            label: "2. Clinical Assessment & Workup",
            icon: FlaskConical,
          },
          {
            id: "MESSAGES_INFO",
            label: `3. Info Requests & Chat (${
              (data.information_requests?.length || 0) +
              (data.messages?.length || 0)
            })`,
            icon: MessageSquare,
          },
          {
            id: "DOCUMENTS",
            label: `4. Source Documents (${
              data.case_detail.documents?.length || 0
            })`,
            icon: FileText,
          },
          {
            id: "RESPONSE",
            label: `2. Specialist Response (${data.responses?.length || 0})`,
            icon: CheckCircle2,
          },
        ]
          .filter((t) => t.id === "HANDOVER" || t.id === "RESPONSE")
          .map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id as any)}
              className={`flex-1 min-w-[155px] px-3 py-2 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-colors ${
                active
                  ? "bg-rose-500 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* TAB 1: HANDOVER SNAPSHOT */}
      {activeTab === "HANDOVER" && (
        <ParallaxCard
          intensity={2}
          className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4 text-xs"
        >
          <div className="flex items-center justify-between border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Immutable Handover Snapshot ({activeSnap?.id})
              </h2>
            </div>
            <span className="font-mono text-slate-600 bg-slate-100 px-2.5 py-1 rounded">
              Total Snapshot Versions: {snapshots.length}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(activeSnap?.summary_sections || []).map((sec: any) => (
              <div
                key={sec.key}
                className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-2"
              >
                <div className="font-bold text-slate-900 uppercase">
                  {sec.title}
                </div>
                {(sec.claims || []).map((clm: any) => (
                  <div
                    key={clm.id}
                    className="bg-white p-2.5 rounded border border-slate-200 space-y-1"
                  >
                    <div className="text-slate-800">{clm.text}</div>
                    <div className="flex flex-wrap gap-1">
                      {(clm.source_refs || []).map((r: any, i: number) => (
                        <span
                          key={i}
                          className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200"
                        >
                          [{r.document_id} v{r.version} #{r.segment_id}]
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {activeSnap?.unknowns?.length > 0 && (
            <div className="p-3.5 rounded-lg bg-amber-50/70 border border-amber-200 space-y-1.5">
              <div className="font-bold text-amber-950">
                Confirmed Missing Information (Unknowns):
              </div>
              {activeSnap.unknowns.map((u: any, idx: number) => (
                <div key={idx} className="text-slate-800">
                  • <strong>{u.label}:</strong> {u.reason}
                </div>
              ))}
            </div>
          )}
        </ParallaxCard>
      )}

      {/* TAB 2: CLINICAL ASSESSMENT & TEST PLAN */}
      {activeTab === "ASSESSMENT_PLAN" && (
        <ParallaxCard
          intensity={2}
          className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4 text-xs"
        >
          <h2 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-2.5">
            Referring Clinician Assessment & Diagnostic Workup Plan
          </h2>

          {data.case_detail.assessments?.length > 0 ? (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
              <div className="font-bold text-slate-900">
                Working Impression (v{data.case_detail.assessments[0].version}):
              </div>
              <div className="text-slate-800">
                {data.case_detail.assessments[0].working_impression}
              </div>
              <div className="text-slate-600">
                <strong>Differential Diagnoses:</strong>{" "}
                {(
                  data.case_detail.assessments[0].differential_diagnoses || []
                ).join(", ")}
              </div>
            </div>
          ) : (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">
              Referred via &ldquo;Consult First&rdquo; pathway prior to local
              test plan confirmation.
            </div>
          )}

          {data.case_detail.test_plans?.length > 0 && (
            <div className="space-y-2">
              <div className="font-bold text-slate-900">
                Confirmed Workup Plan:
              </div>
              {data.case_detail.test_plans.map((tp: any) => (
                <div
                  key={tp.id}
                  className="p-3 rounded-lg bg-rose-50/50 border border-rose-200 space-y-1"
                >
                  <div className="font-bold">
                    {tp.id} (v{tp.version}) — Status: {tp.status}
                  </div>
                  {(tp.items || []).map((item: any, idx: number) => (
                    <div key={idx} className="text-slate-700">
                      • <strong>{item.catalog_test_code}</strong> (
                      {item.catalog_test_name}): {item.target_question} [
                      {item.source_label}]
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </ParallaxCard>
      )}

      {/* TAB 3: MESSAGES & STRUCTURED INFORMATION REQUESTS */}
      {activeTab === "MESSAGES_INFO" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start text-xs">
          {/* Structured Information Requests (Left 6 cols) */}
          <ParallaxCard
            intensity={2}
            className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4"
          >
            <div className="border-b border-slate-200 pb-2.5">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <HelpCircle className="w-4 h-4 text-orange-600" />
                Structured Information Requests
              </h2>
            </div>

            {actor?.role === "consulting_specialist" && !isClosed && (
              <form
                onSubmit={handleCreateInfoRequest}
                className="p-3.5 rounded-lg bg-orange-50/60 border border-orange-200 space-y-2.5"
              >
                <div className="font-bold text-orange-950">
                  + Request Additional Clinical Information:
                </div>
                <textarea
                  rows={3}
                  value={infoReqQuestion}
                  onChange={(e) => setInfoReqQuestion(e.target.value)}
                  className="w-full border border-orange-300 rounded p-2 bg-white"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={busyAction === "create-ireq"}
                    className="px-3 py-1.5 rounded bg-orange-700 hover:bg-orange-800 text-white font-semibold"
                  >
                    Send Request (Set NEEDS_INFO)
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-3">
              {(data.information_requests || []).map((ir: any) => (
                <div
                  key={ir.id}
                  className="p-3.5 rounded-lg border border-slate-200 bg-slate-50 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-slate-900">
                      {ir.id} • By: {ir.requested_by_name}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded font-bold text-[10px] ${
                        ir.status === "OPEN"
                          ? "bg-orange-100 text-orange-900"
                          : "bg-emerald-100 text-emerald-900"
                      }`}
                    >
                      {ir.status}
                    </span>
                  </div>
                  <div className="text-slate-800">
                    <strong>Question:</strong> {ir.question}
                  </div>

                  {ir.response_text && (
                    <div className="p-2.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-950 space-y-1">
                      <div className="font-bold">
                        Referring Clinician Reply (Linked to{" "}
                        {ir.response_snapshot_id}):
                      </div>
                      <div>{ir.response_text}</div>
                    </div>
                  )}

                  {ir.status === "OPEN" &&
                    actor?.role === "referring_clinician" &&
                    !isClosed && (
                      <div className="pt-2 border-t border-slate-200 space-y-2">
                        <div className="font-bold text-rose-900">
                          Provide Supplemental Info & Publish New Snapshot:
                        </div>
                        <textarea
                          rows={3}
                          value={infoReplyText}
                          onChange={(e) => setInfoReplyText(e.target.value)}
                          className="w-full border border-slate-300 rounded p-2 bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => handleRespondInfoRequest(ir.id)}
                          disabled={busyAction === `reply-${ir.id}`}
                          className="px-3 py-1.5 rounded bg-rose-500 hover:bg-rose-600 text-white font-bold"
                        >
                          Submit Reply & Publish Snapshot v
                          {Number(c.snapshot_version) + 1}
                        </button>
                      </div>
                    )}
                </div>
              ))}
            </div>
          </ParallaxCard>

          {/* Persistent Consultation Chat (Right 6 cols) */}
          <ParallaxCard
            intensity={2}
            className="lg:col-span-6 bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4"
          >
            <div className="border-b border-slate-200 pb-2.5">
              <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                <MessageSquare className="w-4 h-4 text-rose-600 font-medium" />
                Clinical Consultation Thread
              </h2>
            </div>

            <div className="space-y-2.5 max-h-[380px] overflow-y-auto p-1">
              {(data.messages || []).map((m: any) => (
                <div
                  key={m.id}
                  className={`p-3 rounded-lg border ${
                    m.sender_role === "consulting_specialist"
                      ? "bg-rose-50/70 border-rose-200"
                      : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                    <span className="font-bold text-slate-800">
                      {m.sender_name} ({m.sender_role})
                    </span>
                    <span>
                      {new Date(m.created_at).toLocaleTimeString("en-US")}
                    </span>
                  </div>
                  <div className="text-slate-800">{m.body}</div>
                </div>
              ))}
            </div>

            {!isClosed && (
              <form onSubmit={handleSendMessage} className="flex gap-2 pt-2">
                <input
                  type="text"
                  value={msgText}
                  onChange={(e) => setMsgText(e.target.value)}
                  placeholder="Write a clinical message..."
                  className="flex-1 border border-slate-300 rounded-lg px-3 py-2"
                />
                <button
                  type="submit"
                  disabled={busyAction === "msg"}
                  className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-600 text-white font-bold flex items-center gap-1"
                >
                  <Send className="w-3.5 h-3.5" />
                  Send
                </button>
              </form>
            )}
          </ParallaxCard>
        </div>
      )}

      {/* TAB 4: SOURCE DOCUMENTS */}
      {activeTab === "DOCUMENTS" && (
        <ParallaxCard
          intensity={2}
          className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-4 text-xs"
        >
          <h2 className="text-base font-bold text-slate-900 border-b border-slate-200 pb-2.5">
            Source Clinical Documents Attached to Handover
          </h2>
          {(data.case_detail.documents || []).map((doc: any) => (
            <div
              key={doc.id}
              className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2"
            >
              <div className="flex items-center justify-between font-bold text-slate-900">
                <span>
                  {doc.filename} ({doc.id} • v{doc.version})
                </span>
                <span className="text-slate-500">{doc.doc_type}</span>
              </div>
              <pre className="whitespace-pre-wrap font-mono bg-white p-3 rounded border border-slate-200 text-slate-800">
                {doc.extracted_text}
              </pre>
            </div>
          ))}
        </ParallaxCard>
      )}

      {/* TAB 5: STRUCTURED SPECIALIST RESPONSE & AMENDMENTS */}
      {activeTab === "RESPONSE" && (
        <ParallaxCard
          intensity={2}
          className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs space-y-5 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Structured Specialist Consultation Response
              </h2>
            </div>

            {actor?.role === "consulting_specialist" && !isClosed && (
              <button
                type="button"
                onClick={handleLoadDemoSampleResponse}
                className="px-3 py-1.5 rounded-lg bg-amber-100 hover:bg-amber-200 text-amber-950 border border-amber-300 font-semibold flex items-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Load Sample Response (Requires Explicit Submit)
              </button>
            )}
          </div>

          {/* Existing Responses */}
          {(data.responses || []).length > 0 && (
            <div className="space-y-3">
              {(data.responses || []).map((resp: any) => (
                <div
                  key={resp.id}
                  className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-2.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-emerald-950 text-sm">
                      {resp.id} (v{resp.version} —{" "}
                      {resp.is_amendment ? "Amendment" : "Initial Response"}) •{" "}
                      {resp.specialist_name}
                    </span>
                    <span className="text-[11px] text-emerald-800">
                      Snapshot: {resp.snapshot_id}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {(resp.question_answers || []).map(
                      (qa: any, idx: number) => (
                        <div
                          key={idx}
                          className="p-2.5 rounded bg-white border border-emerald-200"
                        >
                          <div className="font-bold text-slate-900">
                            Q: {qa.question_text}
                          </div>
                          <div className="text-slate-800 mt-1">
                            A: {qa.answer}
                          </div>
                        </div>
                      )
                    )}
                  </div>

                  <div>
                    <div className="font-bold text-emerald-950">
                      Clinical Recommendations:
                    </div>
                    <pre className="whitespace-pre-wrap font-sans text-slate-800 mt-0.5">
                      {resp.clinical_recommendations}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Specialist Submission Form */}
          {actor?.role === "consulting_specialist" && !isClosed && (
            <form
              onSubmit={handleSubmitResponse}
              className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3"
            >
              <div className="font-bold text-slate-900 text-sm">
                {latestResponse
                  ? `Submit Response Amendment (v${latestResponse.version + 1})`
                  : "Compose Official Specialist Response (v1)"}
              </div>

              {pinnedQuestions.map((q: any, idx: number) => (
                <div key={q.id || idx} className="space-y-1">
                  <label className="font-bold text-slate-800 block">
                    Question {idx + 1}: {q.text}
                  </label>
                  <textarea
                    rows={2}
                    value={answersMap[q.id] || ""}
                    onChange={(e) =>
                      setAnswersMap({ ...answersMap, [q.id]: e.target.value })
                    }
                    placeholder="Enter specialist answer for this question..."
                    className="w-full border border-slate-300 rounded p-2 bg-white"
                  />
                </div>
              ))}

              <div className="space-y-1">
                <label className="font-bold text-slate-800 block">
                  Clinical Recommendations & Follow-Up Plan:
                </label>
                <textarea
                  rows={3}
                  value={recommendations}
                  onChange={(e) => setRecommendations(e.target.value)}
                  placeholder="Enter structured management and diagnostic recommendations..."
                  className="w-full border border-slate-300 rounded p-2 bg-white"
                />
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={busyAction === "submit-response"}
                  className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-600 text-white font-bold flex items-center gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  {busyAction === "submit-response"
                    ? "Submitting..."
                    : "Submit Official Specialist Response"}
                </button>
              </div>
            </form>
          )}
        </ParallaxCard>
      )}
    </div>
  );
}
