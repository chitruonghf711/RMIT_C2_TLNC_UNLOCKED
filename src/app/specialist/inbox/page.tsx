"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useAppSession,
  ParallaxHero,
  ParallaxCard,
} from "@/components/AppShell";
import { SPECIALTY_LABELS, type SpecialtyCode } from "@/lib/types";
import {
  Inbox,
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  ArrowRight,
  Lock,
} from "lucide-react";

interface InboxInvitation {
  id: string;
  case_id: string;
  snapshot_id: string;
  status: string;
  preview_summary: {
    case_code: string;
    referring_organization: string;
    specialty_requested: SpecialtyCode;
    patient_age_band: string;
    patient_sex: string;
    brief_title: string;
    primary_question: string;
    snapshot_version: number;
    urgency_tier: string;
  };
  referring_organization_name: string;
  sent_at: string;
  expires_at: string;
  responded_at: string | null;
  decline_reason: string | null;
  consultation_id: string | null;
}

interface SpecialistProfileDTO {
  user_id: string;
  approved_specialty_codes: SpecialtyCode[];
  availability_state: "AVAILABLE" | "SCHEDULED" | "BUSY" | "PAUSED";
  availability_expires_at: string;
  max_open_cases: number;
  active_cases: number;
  has_protected_role: boolean;
}

export default function SpecialistInboxPage() {
  const { actor, apiFetch, switchPersona } = useAppSession();
  const router = useRouter();

  const [profile, setProfile] = useState<SpecialistProfileDTO | null>(null);
  const [invitations, setInvitations] = useState<InboxInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const loadInbox = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{
        specialist_profile: SpecialistProfileDTO | null;
        invitations: InboxInvitation[];
      }>("/api/invitations");
      setProfile(data.specialist_profile);
      setInvitations(data.invitations);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load inbox.");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (actor?.role === "consulting_specialist") {
      loadInbox();
    } else {
      setLoading(false);
    }
  }, [actor, loadInbox]);

  const handleAccept = async (invId: string) => {
    setProcessingId(invId);
    try {
      const res = await apiFetch<{ consultation_id: string }>(
        `/api/invitations/${invId}/accept`,
        { method: "POST" }
      );
      router.push(`/consultations/${res.consultation_id}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to accept invitation.");
      loadInbox();
    } finally {
      setProcessingId(null);
    }
  };

  const handleDecline = async (invId: string) => {
    setProcessingId(invId);
    try {
      const res = await apiFetch<{
        fallback_triggered: boolean;
        next_specialist_id: string | null;
      }>(`/api/invitations/${invId}/decline`, {
        method: "POST",
        json: {
          reason: "In an urgent bedside procedure; triggering fallback queue.",
        },
      });
      if (res.fallback_triggered) {
        alert(
          `Invitation declined. Automatic fallback triggered to specialist ${res.next_specialist_id}!`
        );
      }
      loadInbox();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to decline.");
    } finally {
      setProcessingId(null);
    }
  };

  const handleAvailabilityChange = async (
    state: "AVAILABLE" | "SCHEDULED" | "BUSY" | "PAUSED"
  ) => {
    try {
      await apiFetch("/api/me/availability", {
        method: "PATCH",
        json: { availability_state: state, expires_in_minutes: 240 },
      });
      loadInbox();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to update status.");
    }
  };

  if (actor?.role !== "consulting_specialist") {
    return (
      <div className="space-y-4">
        <ParallaxHero
          badge="SPECIALIST CONSULTATION INBOX"
          title="Specialist Triage & Minimal Preview Inbox"
          subtitle="Switch to a Consulting Specialist persona to inspect incoming consultation invitations, minimal pre-acceptance previews, and atomic case acceptance."
          variant="teal"
        />
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-center space-y-3">
          <p className="text-sm text-slate-600">
            You are currently signed in as{" "}
            <strong>{actor?.displayName}</strong> (<code>{actor?.role}</code>).
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => switchPersona("USR-SPEC-01")}
              className="px-4 py-2 rounded-lg bg-rose-500 hover:bg-rose-500 text-white text-xs font-bold cursor-pointer"
            >
              Switch to Professor (Available • QEA Approved)
            </button>
            <button
              type="button"
              onClick={() => switchPersona("USR-SPEC-03")}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold cursor-pointer"
            >
              Switch to Dr. Hoang Nam Pham (Pending QEA Role)
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ParallaxHero
        badge="PRIVACY-PRESERVING TRIAGE INBOX"
        title={`Specialist Inbox — ${actor.displayName}`}
        subtitle="Before accepting an invitation, you only see the de-identified minimal preview. Full source records and clinical attachments unlock atomically upon acceptance."
        variant="teal"
        rightContent={
          profile && (
            <div className="bg-slate-900/80 border border-teal-500/30 rounded-xl p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-300">Active Workload:</span>
                <span className="font-bold text-white">
                  {profile.active_cases} / {profile.max_open_cases} open cases
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-slate-300">Status:</span>
                {(["AVAILABLE", "BUSY", "PAUSED"] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => handleAvailabilityChange(st)}
                    className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer ${
                      profile.availability_state === st
                        ? "bg-rose-500 text-slate-950"
                        : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    }`}
                  >
                    {st}
                  </button>
                ))}
              </div>
            </div>
          )
        }
      />

      {/* QEA Role Status Banner */}
      {profile && !profile.has_protected_role && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-xs text-amber-950 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0" />
            <div>
              <strong>Pending TideCloak QEA Role:</strong> Your account
              does not yet hold the QEA-governed{" "}
              <code className="font-mono font-bold">network_consultant</code>{" "}
              role (1/2 admin signatures collected). You are excluded from
              cross-organization specialist matching until quorum is met.
            </div>
          </div>
          <Link
            href="/network/governance"
            className="px-3 py-1.5 rounded-lg bg-amber-800 text-white font-semibold shrink-0 hover:bg-amber-700"
          >
            View QEA Status
          </Link>
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
          Loading specialist invitations...
        </div>
      ) : error ? (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">
          {error}
        </div>
      ) : invitations.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center space-y-2">
          <Inbox className="w-8 h-8 text-slate-400 mx-auto" />
          <div className="text-sm font-semibold text-slate-800">
            No consultation invitations for {actor.displayName}
          </div>
          <p className="text-xs text-slate-500">
            Send an invitation from a Referring Clinician account to see it
            appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {invitations.map((inv) => {
            const p = inv.preview_summary;
            return (
              <ParallaxCard
                key={inv.id}
                intensity={5}
                className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs flex flex-col justify-between space-y-4"
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-bold text-slate-800">
                      {p.case_code || inv.case_id} • Snapshot v
                      {p.snapshot_version || 1}
                    </span>
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${
                        inv.status === "PENDING"
                          ? "bg-amber-100 text-amber-900"
                          : inv.status === "ACCEPTED"
                            ? "bg-emerald-100 text-emerald-900"
                            : "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {inv.status}
                    </span>
                  </div>

                  <div className="text-xs text-slate-500">
                    From: <strong>{inv.referring_organization_name}</strong> •{" "}
                    {SPECIALTY_LABELS[p.specialty_requested] ||
                      p.specialty_requested}{" "}
                    • Patient: {p.patient_sex}, {p.patient_age_band}
                  </div>

                  <h3 className="font-bold text-base text-slate-900">
                    {p.brief_title}
                  </h3>

                  <div className="bg-slate-50 rounded-lg p-3 border border-slate-200 text-xs text-slate-700 space-y-1">
                    <div className="font-semibold text-slate-900">
                      Consultation Question (Minimal Preview):
                    </div>
                    <div>{p.primary_question}</div>
                  </div>

                  {inv.status === "PENDING" && (
                    <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Lock className="w-3.5 h-3.5 text-rose-500" />
                      <span>
                        Full source documents are locked until you accept this
                        invitation.
                      </span>
                    </div>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div className="text-[11px] text-slate-400 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5" />
                    <span>
                      Expires:{" "}
                      {new Date(inv.expires_at).toLocaleTimeString("en-US", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </div>

                  {inv.status === "PENDING" ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={processingId === inv.id}
                        onClick={() => handleDecline(inv.id)}
                        className="px-3 py-1.5 rounded-lg border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Decline (Trigger Fallback)</span>
                      </button>
                      <button
                        type="button"
                        disabled={processingId === inv.id}
                        onClick={() => handleAccept(inv.id)}
                        className="px-3.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-500 text-white text-xs font-bold flex items-center gap-1 shadow-xs cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Accept Case</span>
                      </button>
                    </div>
                  ) : inv.consultation_id ? (
                    <Link
                      href={`/consultations/${inv.consultation_id}`}
                      className="px-3.5 py-1.5 rounded-lg bg-[#0f2942] hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1"
                    >
                      <span>Open Consultation Room</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Link>
                  ) : null}
                </div>
              </ParallaxCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
