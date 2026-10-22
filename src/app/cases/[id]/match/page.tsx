"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useAppSession,
  ParallaxHero,
  ParallaxCard,
} from "@/components/AppShell";
import {
  SPECIALTY_LABELS,
  type SpecialistMatchCandidate,
  type SpecialtyCode,
} from "@/lib/types";
import {
  Users,
  ShieldCheck,
  ShieldAlert,
  Send,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowLeft,
  Inbox,
} from "lucide-react";

export default function CaseMatchPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const caseId = params.id;
  const { actor, apiFetch, switchPersona } = useAppSession();

  const [matchData, setMatchData] = useState<{
    case_id: string;
    primary_specialty: SpecialtyCode;
    accepted_specialties: SpecialtyCode[];
    case_topic_tags: string[];
    eligible: SpecialistMatchCandidate[];
    ineligible: SpecialistMatchCandidate[];
    computed_at: string;
    disclaimer: string;
  } | null>(null);
  const [caseDetail, setCaseDetail] = useState<Record<string, any> | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [bannerMsg, setBannerMsg] = useState<string | null>(null);

  const [fallbackEnabled, setFallbackEnabled] = useState(true);
  const [expiresSeconds, setExpiresSeconds] = useState(60);
  const [sendingTo, setSendingTo] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!actor || !caseId) return;
    setLoading(true);
    setError(null);
    try {
      const [mRes, cRes] = await Promise.all([
        apiFetch<any>(`/api/cases/${caseId}/matches`),
        apiFetch<any>(`/api/cases/${caseId}`),
      ]);
      setMatchData(mRes);
      setCaseDetail(cRes);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to load specialist matching results."
      );
    } finally {
      setLoading(false);
    }
  }, [actor, apiFetch, caseId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSendInvitation = async (specialistId: string) => {
    if (!matchData) return;
    setSendingTo(specialistId);
    setError(null);
    setBannerMsg(null);
    try {
      const fallbackIds = matchData.eligible
        .map((c) => c.user_id)
        .filter((id) => id !== specialistId);

      const res = await apiFetch<Record<string, any>>(
        `/api/cases/${caseId}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({
            specialist_id: specialistId,
            fallback_enabled: fallbackEnabled,
            fallback_specialist_ids: fallbackIds,
            expires_in_seconds: expiresSeconds,
          }),
        }
      );

      setBannerMsg(
        `Sent consultation invitation ${res.id} to ${res.specialist_name} (Expires at ${new Date(
          res.expires_at
        ).toLocaleTimeString("en-US")}). ${
          fallbackEnabled && fallbackIds.length > 0
            ? `Auto-fallback enabled (${fallbackIds.join(", ")}) on decline or expiry.`
            : ""
        }`
      );
      await loadData();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not send invitation."
      );
    } finally {
      setSendingTo(null);
    }
  };

  if (loading) {
    return (
      <div className="p-8 bg-white rounded-xl border border-slate-200 text-center text-sm text-slate-600">
        Running mandatory eligibility filters & explainable specialist ranking...
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* 3D Parallax Hero Header */}
      <ParallaxHero
        badge={`Specialist Matching • ${caseDetail?.case?.case_code || caseId}`}
        title="Explainable Specialist Matching & Routing"
        subtitle="Formula: score = 40×specialty + 30×availability + 20×capacity_ratio + 10×topic_fit (Tie-break: specialist_id)"
        variant="navy"
        rightContent={
          <div className="flex items-center gap-2">
            <Link
              href={`/cases/${caseId}/prepare`}
              className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white border border-white/15 text-xs font-bold flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Prepare
            </Link>
            {[
              { id: "CASE-DEMO-001", label: "Case A" },
              { id: "CASE-DEMO-002", label: "Case B" },
              { id: "CASE-DEMO-003", label: "Case C" },
            ].map((item) => (
              <Link
                key={item.id}
                href={`/cases/${item.id}/match`}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${
                  caseId === item.id
                    ? "bg-rose-400 text-slate-950 border-rose-300"
                    : "bg-white/10 text-white border-white/15 hover:bg-white/20"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        }
      />

      {error && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs flex items-start gap-2">
          <ShieldAlert className="w-4 h-4 text-rose-600 font-medium shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {bannerMsg && (
        <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-950 text-xs flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span>{bannerMsg}</span>
          </div>
          <button
            type="button"
            onClick={async () => {
              await switchPersona("USR-SPEC-01");
              router.push("/specialist/inbox");
            }}
            className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-semibold flex items-center gap-1.5"
          >
            <Inbox className="w-3.5 h-3.5" />
            Switch to Professor to Accept →
          </button>
        </div>
      )}

      {/* Invitation Settings Bar */}
      {false && actor?.role === "referring_clinician" && (
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-xs flex flex-wrap items-center justify-between gap-4 text-xs">
          <label className="flex items-center gap-2 font-medium text-slate-800 cursor-pointer">
            <input
              type="checkbox"
              checked={fallbackEnabled}
              onChange={(e) => setFallbackEnabled(e.target.checked)}
            />
            <span>
              <strong>Enable Auto-Fallback Queue:</strong> Automatically
              route to the next eligible specialist if the primary candidate
              declines or the timer expires.
            </span>
          </label>

          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-rose-600 font-medium" />
            <span className="font-semibold text-slate-700">
              Invitation SLA Timer:
            </span>
            <select
              value={expiresSeconds}
              onChange={(e) => setExpiresSeconds(Number(e.target.value))}
              className="border border-slate-300 rounded px-2 py-1 bg-white font-medium"
            >
              <option value={60}>60 seconds (Default Demo)</option>
              <option value={15}>15 seconds (Fast Expiry Test)</option>
              <option value={300}>300 seconds (5 minutes)</option>
            </select>
          </div>
        </div>
      )}

      {matchData && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* LEFT: ELIGIBLE SPECIALISTS */}
          <div className="lg:col-span-7 space-y-3">
            <h2 className="text-sm font-bold text-emerald-900 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-700" />
              ELIGIBLE Specialist Candidates ({matchData.eligible.length})
            </h2>

            {matchData.eligible.length === 0 ? (
              <div className="p-6 bg-amber-50 border border-amber-300 rounded-xl text-xs text-amber-950 space-y-2">
                <div className="font-bold">
                  Zero Eligible Specialists Available Right Now (WAITING_MATCH)
                </div>
                <p>
                  CaseBridge keeps the case in <strong>WAITING_MATCH</strong>{" "}
                  for clinician/coordinator review — it never silently expands
                  sharing to unauthorized hospitals or specialists whose QEA
                  role is still pending.
                </p>
              </div>
            ) : (
              matchData.eligible.map((cand, idx) => (
                <ParallaxCard
                  key={cand.user_id}
                  intensity={4}
                  className="bg-white rounded-xl border-2 border-emerald-600/30 p-4 shadow-xs space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-xs">
                          Rank #{idx + 1}
                        </span>
                        <h3 className="text-base font-bold text-slate-900">
                          {cand.display_name}
                        </h3>
                        <span className="text-[11px] px-2 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 font-semibold flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3" />
                          network_consultant (QEA Active)
                        </span>
                      </div>
                      <div className="text-xs text-slate-600 mt-0.5">
                        {cand.title} • <strong>{cand.organization_name}</strong>
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-xs text-slate-500">Routing Score</div>
                      <div className="text-xl font-black text-rose-700">
                        {cand.score} / 100
                      </div>
                    </div>
                  </div>

                  {/* Score Breakdown */}
                  {cand.score_breakdown && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                      <div className="p-2 rounded bg-slate-50 border border-slate-200">
                        <div className="text-slate-500">Specialty (×40)</div>
                        <div className="font-bold text-slate-900">
                          {(cand.score_breakdown.specialty_fit * 40).toFixed(1)}{" "}
                          pts
                        </div>
                      </div>
                      <div className="p-2 rounded bg-slate-50 border border-slate-200">
                        <div className="text-slate-500">Availability (×30)</div>
                        <div className="font-bold text-slate-900">
                          {(cand.score_breakdown.availability_fit * 30).toFixed(
                            1
                          )}{" "}
                          pts ({cand.availability_state})
                        </div>
                      </div>
                      <div className="p-2 rounded bg-slate-50 border border-slate-200">
                        <div className="text-slate-500">Capacity (×20)</div>
                        <div className="font-bold text-slate-900">
                          {(
                            cand.score_breakdown.remaining_capacity_ratio * 20
                          ).toFixed(1)}{" "}
                          pts (Open {cand.active_cases}/{cand.max_open_cases})
                        </div>
                      </div>
                      <div className="p-2 rounded bg-slate-50 border border-slate-200">
                        <div className="text-slate-500">Topic Fit (×10)</div>
                        <div className="font-bold text-slate-900">
                          {(
                            cand.score_breakdown.approved_topic_fit * 10
                          ).toFixed(1)}{" "}
                          pts
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Reasons */}
                  <div className="bg-emerald-50/50 p-2.5 rounded-lg border border-emerald-200 text-xs space-y-1">
                    <div className="font-bold text-emerald-950">
                      Eligibility & Ranking Explanation:
                    </div>
                    {cand.ranking_reasons.map((r, i) => (
                      <div key={i} className="text-slate-700">
                        • {r}
                      </div>
                    ))}
                  </div>

                  {actor?.role === "referring_clinician" && (
                    <div className="flex items-center justify-end pt-1">
                      <button
                        type="button"
                        onClick={() => handleSendInvitation(cand.user_id)}
                        disabled={sendingTo === cand.user_id}
                        className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-xs disabled:opacity-50"
                      >
                        <Send className="w-3.5 h-3.5" />
                        {sendingTo === cand.user_id
                          ? "Sending Invitation..."
                          : `Invite ${cand.display_name}`}
                      </button>
                    </div>
                  )}
                </ParallaxCard>
              ))
            )}
          </div>

          {/* RIGHT: INELIGIBLE SPECIALISTS WITH EXPLICIT REASONS */}
          <div className="lg:col-span-5 space-y-3">
            <h2 className="text-sm font-bold text-rose-900 flex items-center gap-2">
              <XCircle className="w-4 h-4 text-rose-700" />
              INELIGIBLE Candidates Excluded ({matchData.ineligible.length})
            </h2>

            <div className="space-y-3">
              {matchData.ineligible.map((cand) => (
                <ParallaxCard
                  key={cand.user_id}
                  intensity={3}
                  className="bg-white rounded-xl border border-rose-200 p-4 shadow-xs space-y-2.5 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-slate-900 text-sm">
                        {cand.display_name}
                      </div>
                      <div className="text-slate-500">
                        {cand.title} • {cand.organization_name}
                      </div>
                    </div>
                    <span
                      className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                        cand.has_protected_role
                          ? "bg-slate-100 text-slate-700 border-slate-300"
                          : "bg-amber-100 text-amber-900 border-amber-300"
                      }`}
                    >
                      {cand.has_protected_role
                        ? `Load: ${cand.active_cases}/${cand.max_open_cases}`
                        : "Pending QEA"}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {cand.approved_specialty_codes.map((code) => (
                      <span
                        key={code}
                        className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px]"
                      >
                        {SPECIALTY_LABELS[code] || code}
                      </span>
                    ))}
                  </div>

                  <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-rose-900 space-y-1">
                    <div className="font-bold">Mandatory Exclusion Reason:</div>
                    {cand.ineligible_reasons.map((reason, idx) => (
                      <div key={idx}>• {reason}</div>
                    ))}
                  </div>
                </ParallaxCard>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
