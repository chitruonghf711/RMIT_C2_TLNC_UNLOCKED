"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  useAppSession,
  ParallaxHero,
  ParallaxCard,
} from "@/components/AppShell";
import { SPECIALTY_LABELS, type SpecialtyCode } from "@/lib/types";
import {
  Scale,
  ShieldCheck,
  Clock,
  Users,
  Building2,
  PlusCircle,
  CheckCircle2,
  Server,
} from "lucide-react";

interface GovernanceChangeItem {
  id: string;
  tide_change_request_id: string;
  target_user_id: string;
  target_user_name: string;
  target_user_title: string;
  target_organization_name: string;
  requested_action: string;
  role_name: string;
  status_source: string;
  last_observed_status: "PENDING" | "APPROVED" | "DENIED" | "CANCELLED";
  approvals_observed: number;
  threshold_observed: number;
  ready_to_commit: boolean;
  checked_at: string;
  notes: string;
}

interface GovernanceOverviewDTO {
  quorum_policy: {
    formula: string;
    active_admin_count: number;
    required_approvals: number;
    protected_role: string;
    explanation: string;
  };
  tide_connection: {
    live_reachable: boolean;
    pending_change_requests_in_tide: number;
    error: string | null;
  };
  admins: Array<{
    id: string;
    display_name: string;
    title: string;
    email: string;
    organization_name: string;
  }>;
  governance_links: GovernanceChangeItem[];
  agreements: Array<{
    id: string;
    source_org_name: string;
    target_org_name: string;
    allowed_specialties: SpecialtyCode[];
    status: string;
    policy_reference: string;
  }>;
}

export default function GovernancePage() {
  const { actor, apiFetch } = useAppSession();
  const [data, setData] = useState<GovernanceOverviewDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState(
    "Requesting cross-organization 'network_consultant' role for Dr. Hoang Nam Pham."
  );
  const [submitting, setSubmitting] = useState(false);

  const loadGovernance = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<GovernanceOverviewDTO>(
        "/api/governance/changes"
      );
      setData(res);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (actor) {
      loadGovernance();
    }
  }, [actor, loadGovernance]);

  const handleCreateProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await apiFetch("/api/governance/changes", {
        method: "POST",
        json: {
          target_user_id: "USR-SPEC-03",
          role_name: "network_consultant",
          notes,
        },
      });
      await loadGovernance();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to create proposal.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <ParallaxHero
        badge="TIDECLOAK QUORUM-ENFORCED AUTHORIZATION (QEA)"
        title="Cross-Organization Trust & Quorum Governance"
        subtitle="No single administrator can unilaterally grant cross-organization clinical consultation privileges. Role changes require cryptographic quorum approval via TideCloak IGA."
        variant="indigo"
        rightContent={
          data && (
            <div className="bg-slate-900/90 border border-indigo-400/30 rounded-xl px-4 py-3 text-xs space-y-1">
              <div className="flex items-center gap-2 font-bold text-indigo-300">
                <Server className="w-4 h-4" />
                <span>
                  TideCloak IGA:{" "}
                  {data.tide_connection.live_reachable
                    ? "ONLINE (localhost:8080)"
                    : "LOCAL SYNC"}
                </span>
              </div>
              <div className="text-slate-300">
                Quorum Formula:{" "}
                <code className="text-rose-300 font-mono">
                  {data.quorum_policy.formula}
                </code>{" "}
                ({data.quorum_policy.required_approvals} of{" "}
                {data.quorum_policy.active_admin_count} admins)
              </div>
            </div>
          )
        }
      />

      {loading || !data ? (
        <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">
          Syncing TideCloak `/iga/change-requests` & quorum policy...
        </div>
      ) : (
        <>
          <ParallaxCard className="bg-white rounded-xl border border-slate-200 p-5 shadow-xs">
            <div className="text-xs font-bold uppercase text-slate-500 flex items-center justify-between">
              <span>Quorum Threshold</span>
              <Scale className="w-4 h-4 text-indigo-600" />
            </div>
            <div className="text-2xl font-bold text-indigo-900 mt-1.5">
              {data.quorum_policy.required_approvals} /{" "}
              {data.quorum_policy.active_admin_count} Admin Approvals
            </div>
            <code className="text-xs text-slate-600">
              max(1, floor(0.7 × {data.quorum_policy.active_admin_count})) ={" "}
              {data.quorum_policy.required_approvals}
            </code>
          </ParallaxCard>

          {/* Pending & Historical QEA Change Requests */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-700">
                TideCloak IGA / QEA Role Change Requests
              </h2>
            </div>

            <div className="divide-y divide-slate-200">
              {data.governance_links.map((item) => (
                <div
                  key={item.id}
                  className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1.5 max-w-3xl">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        <span>{item.last_observed_status}</span>
                      </span>
                      <span className="font-mono text-xs font-bold text-slate-700">
                        Change Request #{item.tide_change_request_id}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono">
                        {item.requested_action} → {item.role_name}
                      </span>
                    </div>

                    <div className="text-sm font-bold text-slate-900">
                      {item.target_user_name} —{" "}
                      <span className="font-normal text-slate-600">
                        {item.target_user_title} ({item.target_organization_name}
                        )
                      </span>
                    </div>
                  </div>

                  <div className="shrink-0 bg-slate-50 border border-slate-200 rounded-xl p-3.5 text-xs space-y-1.5 min-w-[230px]">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">
                        Observed Signatures:
                      </span>
                      <span className="font-bold text-amber-800">
                        {item.approvals_observed} / {item.threshold_observed}{" "}
                        required
                      </span>
                    </div>
                    <div className="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-500"
                        style={{
                          width: `${Math.min(
                            100,
                            (item.approvals_observed /
                              Math.max(1, item.threshold_observed)) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </>
      )}
    </div>
  );
}
