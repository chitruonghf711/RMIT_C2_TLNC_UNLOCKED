"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTideCloak } from "@tidecloak/nextjs";
import {
  ShieldCheck,
  Stethoscope,
  Inbox,
  Scale,
  RotateCcw,
  UserCheck,
  Lock,
  AlertTriangle,
  LogIn,
  LogOut,
  Activity,
  Sparkles,
} from "lucide-react";
import type { UserRole } from "@/lib/types";

export interface ClientActor {
  userId: string;
  tideSubject: string;
  organizationId: string;
  organizationName: string;
  displayName: string;
  role: UserRole;
  title: string;
  email: string;
  tideRoles: string[];
  hasProtectedNetworkRole: boolean;
  authSource: "tidecloak_live" | "demo_dpop";
}

interface AppSessionContextValue {
  actor: ClientActor | null;
  personas: ClientActor[];
  loading: boolean;
  switchPersona: (userId: string) => Promise<void>;
  apiFetch: <T = unknown>(
    path: string,
    init?: RequestInit & { json?: unknown }
  ) => Promise<T>;
  resetDemoData: () => Promise<void>;
  refreshSession: () => Promise<void>;
  parallaxOffset: { x: number; y: number; scrollY: number };
}

const AppSessionContext = createContext<AppSessionContextValue | null>(null);

export function useAppSession(): AppSessionContextValue {
  const ctx = useContext(AppSessionContext);
  if (!ctx) {
    throw new Error("useAppSession must be used within AppShell");
  }
  return ctx;
}

/**
 * Interactive 3D Parallax Hero Banner with floating depth badges
 */
export function ParallaxHero({
  badge,
  title,
  subtitle,
  rightContent,
  variant = "navy",
}: {
  badge: string;
  title: string;
  subtitle: string;
  rightContent?: React.ReactNode;
  variant?: "navy" | "teal" | "indigo";
}) {
  const { parallaxOffset } = useAppSession();
  const bgGradient =
    variant === "teal"
      ? "from-[#1a1f2c] via-[#212738] to-[#1a1f2c] border-slate-700/60"
      : variant === "indigo"
        ? "from-slate-950 via-indigo-950 to-slate-900 border-indigo-800/60"
        : "from-[#0b1f33] via-[#0f2942] to-slate-900 border-slate-800/80";

  return (
    <div
      className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${bgGradient} text-white border shadow-xl p-6 mb-6 parallax-scene`}
    >
      {/* Parallax Depth Layer 1: Deep glowing orb */}
      <div
        className="pointer-events-none absolute -top-20 -right-16 w-80 h-80 rounded-full bg-rose-300/10 blur-3xl parallax-layer"
        style={{
          transform: `translate3d(${parallaxOffset.x * -35}px, ${
            parallaxOffset.y * -25 - parallaxOffset.scrollY * 0.12
          }px, 0)`,
        }}
      />
      {/* Parallax Depth Layer 2: Secondary cyan orb */}
      <div
        className="pointer-events-none absolute -bottom-24 left-1/4 w-72 h-72 rounded-full bg-slate-400/10 blur-3xl parallax-layer"
        style={{
          transform: `translate3d(${parallaxOffset.x * 28}px, ${
            parallaxOffset.y * 20 - parallaxOffset.scrollY * 0.08
          }px, 0)`,
        }}
      />
      {/* Parallax Depth Layer 3: Subtle medical grid */}
      <div
        className="pointer-events-none absolute inset-0 opacity-15 parallax-layer"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.45) 1px, transparent 0)",
          backgroundSize: "24px 24px",
          transform: `translate3d(${parallaxOffset.x * 12}px, ${
            parallaxOffset.y * 12
          }px, 0)`,
        }}
      />

      {/* Foreground Content Layer */}
      <div
        className="relative z-10 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 parallax-layer"
        style={{
          transform: `translate3d(${parallaxOffset.x * 6}px, ${
            parallaxOffset.y * 4
          }px, 12px)`,
        }}
      >
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-300/10 border border-rose-400/30 text-rose-200 text-xs font-semibold tracking-wide mb-2.5">
            <Sparkles className="w-3.5 h-3.5 text-rose-300" />
            <span>{badge}</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
            {title}
          </h1>
        </div>
        {rightContent && <div className="shrink-0">{rightContent}</div>}
      </div>
    </div>
  );
}

/**
 * Interactive 3D Tilt Card with subtle cursor parallax
 */
export function ParallaxCard({
  children,
  className = "",
  intensity = 4,
}: {
  children: React.ReactNode;
  className?: string;
  intensity?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, lift: 0 });

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({
      rx: -ny * intensity,
      ry: nx * intensity,
      lift: -2,
    });
  };

  const handleLeave = () => {
    setTilt({ rx: 0, ry: 0, lift: 0 });
  };

  return (
    <div
      ref={ref}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      className={`parallax-card ${className}`}
      style={{
        transform: `perspective(1000px) translateY(${tilt.lift}px) rotateX(${tilt.rx.toFixed(
          2
        )}deg) rotateY(${tilt.ry.toFixed(2)}deg)`,
      }}
    >
      {children}
    </div>
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function stringToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

async function computeJwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

interface ClientDpopKeyState {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jkt: string;
}

const ROLE_LABELS: Record<UserRole, string> = {
  referring_clinician: "Referring Clinician",
  consulting_specialist: "Consulting Specialist",
  coordinator: "Coordinator",
  network_admin: "QEA Governance Admin",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const tide = useTideCloak();

  const [actor, setActor] = useState<ClientActor | null>(null);
  const [personas, setPersonas] = useState<ClientActor[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [bannerNotice, setBannerNotice] = useState<string | null>(null);
  const [parallaxOffset, setParallaxOffset] = useState({
    x: 0,
    y: 0,
    scrollY: 0,
  });

  const dpopKeyRef = useRef<ClientDpopKeyState | null>(null);
  const accessTokenRef = useRef<string | null>(null);
  const currentUserIdRef = useRef<string>("USR-REF-01");

  // Global mouse & scroll parallax listener
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const nx = e.clientX / window.innerWidth - 0.5;
      const ny = e.clientY / window.innerHeight - 0.5;
      setParallaxOffset((prev) => ({ ...prev, x: nx, y: ny }));
    };
    const onScroll = () => {
      setParallaxOffset((prev) => ({ ...prev, scrollY: window.scrollY }));
    };
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const ensureDpopKey = useCallback(async (): Promise<ClientDpopKeyState> => {
    if (dpopKeyRef.current) {
      return dpopKeyRef.current;
    }
    const kp = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
    const jkt = await computeJwkThumbprint(publicJwk);
    const state: ClientDpopKeyState = {
      privateKey: kp.privateKey,
      publicJwk: {
        kty: publicJwk.kty,
        crv: publicJwk.crv,
        x: publicJwk.x,
        y: publicJwk.y,
      },
      jkt,
    };
    dpopKeyRef.current = state;
    return state;
  }, []);

  const signDpopProof = useCallback(
    async (method: string, fullUrl: string, accessToken: string) => {
      const keyState = await ensureDpopKey();
      const parsed = new URL(fullUrl);
      const htu = `${parsed.origin}${parsed.pathname}`;
      const ath = await sha256Base64Url(accessToken);

      const header = {
        alg: "ES256",
        typ: "dpop+jwt",
        jwk: keyState.publicJwk,
      };
      const payload = {
        htm: method.toUpperCase(),
        htu,
        iat: Math.floor(Date.now() / 1000),
        jti: crypto.randomUUID(),
        ath,
      };

      const signingInput = `${stringToBase64Url(
        JSON.stringify(header)
      )}.${stringToBase64Url(JSON.stringify(payload))}`;
      const sigBuffer = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyState.privateKey,
        new TextEncoder().encode(signingInput)
      );
      const sigB64 = base64UrlEncode(new Uint8Array(sigBuffer));
      return `${signingInput}.${sigB64}`;
    },
    [ensureDpopKey]
  );

  const mintPersonaSession = useCallback(
    async (userId: string) => {
      const keyState = await ensureDpopKey();
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          dpopJkt: keyState.jkt,
        }),
      });
      if (!res.ok) {
        throw new Error("Failed to initialize DPoP session.");
      }
      const data = await res.json();
      accessTokenRef.current = data.token;
      currentUserIdRef.current = data.actor.userId;
      localStorage.setItem("casebridge_persona_id", data.actor.userId);
      setActor(data.actor);
      if (Array.isArray(data.personas)) {
        setPersonas(data.personas);
      }
    },
    [ensureDpopKey]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        // Always default to Doctor (USR-REF-01) on initial entry
        const defaultDoctorId = "USR-REF-01";
        localStorage.setItem("casebridge_persona_id", defaultDoctorId);
        await mintPersonaSession(defaultDoctorId);
      } catch (err) {
        console.error(err);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [mintPersonaSession]);

  const apiFetch = useCallback(
    async <T = unknown,>(
      path: string,
      init?: RequestInit & { json?: unknown }
    ): Promise<T> => {
      if (!accessTokenRef.current) {
        await mintPersonaSession(currentUserIdRef.current);
      }
      const token = accessTokenRef.current!;
      const method = (init?.method || "GET").toUpperCase();
      const fullUrl = path.startsWith("http")
        ? path
        : `${window.location.origin}${path}`;
      const proof = await signDpopProof(method, fullUrl, token);

      const headers = new Headers(init?.headers || {});
      headers.set("Authorization", `DPoP ${token}`);
      headers.set("DPoP", proof);
      if (init?.json !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      const res = await fetch(path, {
        ...init,
        method,
        headers,
        body:
          init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(
          data.error || `HTTP Error ${res.status}`
        ) as Error & {
          status: number;
          code?: string;
          details?: unknown;
        };
        err.status = res.status;
        err.code = data.code;
        err.details = data.details;
        throw err;
      }
      return data as T;
    },
    [mintPersonaSession, signDpopProof]
  );

  const switchPersona = useCallback(
    async (userId: string) => {
      setLoading(true);
      try {
        await mintPersonaSession(userId);
        setBannerNotice(null);
      } finally {
        setLoading(false);
      }
    },
    [mintPersonaSession]
  );

  const refreshSession = useCallback(async () => {
    await mintPersonaSession(currentUserIdRef.current);
  }, [mintPersonaSession]);

  const resetDemoData = useCallback(async () => {
    setResetting(true);
    try {
      await apiFetch("/api/demo/reset", { method: "POST" });
      await mintPersonaSession(currentUserIdRef.current);
      setBannerNotice(
        "Demo dataset restored (Case A, Case B, Case C). Pending Tide QEA role requests remain strictly enforced."
      );
      router.refresh();
    } catch (err) {
      setBannerNotice(
        err instanceof Error ? err.message : "Failed to reset demo dataset."
      );
    } finally {
      setResetting(false);
    }
  }, [apiFetch, mintPersonaSession, router]);

  if (pathname?.startsWith("/auth/redirect")) {
    return <>{children}</>;
  }

  return (
    <AppSessionContext.Provider
      value={{
        actor,
        personas,
        loading,
        switchPersona,
        apiFetch,
        resetDemoData,
        refreshSession,
        parallaxOffset,
      }}
    >
      <div className="min-h-screen flex flex-col bg-[#f8f9fa] text-slate-900 relative overflow-hidden">
        {/* Global Ambient Parallax Background Orbs */}
        <div
          className="pointer-events-none fixed top-24 -left-24 w-96 h-96 rounded-full bg-rose-400/10 blur-3xl parallax-layer z-0"
          style={{
            transform: `translate3d(${parallaxOffset.x * -40}px, ${
              parallaxOffset.y * -30 - parallaxOffset.scrollY * 0.08
            }px, 0)`,
          }}
        />
        <div
          className="pointer-events-none fixed bottom-12 -right-24 w-[28rem] h-[28rem] rounded-full bg-sky-500/10 blur-3xl parallax-layer z-0"
          style={{
            transform: `translate3d(${parallaxOffset.x * 45}px, ${
              parallaxOffset.y * 35 - parallaxOffset.scrollY * 0.05
            }px, 0)`,
          }}
        />

        {/* Main Header */}
        <header className="bg-[#181d27]/95 backdrop-blur-md text-white shadow-md sticky top-0 z-30 border-b border-slate-800/80">
          <div className="max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-6">
              <Link
                href="/workspace"
                className="flex items-center gap-2.5 group"
              >
                <div className="w-9 h-9 rounded-lg bg-rose-500 flex items-center justify-center text-slate-950 font-bold shadow-sm group-hover:bg-rose-400 transition">
                  <Stethoscope className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-bold text-base tracking-tight flex items-center gap-2">
                    <span>CaseBridge</span>
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-400/30">
                      Tide QEA + DPoP
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-300">
                    From Fragmented Records to the Right Specialist
                  </div>
                </div>
              </Link>

              <nav className="hidden lg:flex items-center gap-1 text-sm">
                {actor?.role === "referring_clinician" && (
                <Link
                  href="/workspace"
                  className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 transition ${
                    pathname === "/workspace" || pathname?.startsWith("/cases/")
                      ? "bg-white/15 text-white"
                      : "text-slate-300 hover:text-white hover:bg-white/5"
                  }`}
                >
                  <Activity className="w-4 h-4 text-rose-400" />
                  <span>Workspace</span>
                </Link>
                )}

                {actor?.role === "consulting_specialist" && (
                <Link
                  href="/specialist/inbox"
                  className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 transition ${
                    pathname?.startsWith("/specialist/inbox") ||
                    pathname?.startsWith("/consultations/")
                      ? "bg-white/15 text-white"
                      : "text-slate-300 hover:text-white hover:bg-white/5"
                  }`}
                >
                  <Inbox className="w-4 h-4 text-rose-400" />
                  <span>Specialist Inbox</span>
                </Link>
                )}

                <Link
                  href="/network/governance"
                  className={`px-3 py-1.5 rounded-md font-medium flex items-center gap-1.5 transition ${
                    pathname?.startsWith("/network")
                      ? "bg-white/15 text-white"
                      : "text-slate-300 hover:text-white hover:bg-white/5"
                  }`}
                >
                  <Scale className="w-4 h-4 text-rose-400" />
                  <span>Tide QEA Governance</span>
                </Link>
              </nav>
            </div>

            {/* Right Controls: Persona Switcher, Tide Login, Reset Demo */}
            <div className="flex flex-wrap items-center gap-2.5">
              {actor && (
                <div className="flex items-center gap-2 bg-slate-800/90 border border-slate-700 rounded-lg px-2.5 py-1.5">
                  <UserCheck className="w-4 h-4 text-rose-400 shrink-0" />
                  <div className="text-xs">
                    <label htmlFor="persona-select" className="sr-only">
                      Switch Demo Persona
                    </label>
                    <select
                      id="persona-select"
                      value={actor.userId}
                      onChange={async (e) => {
                        const id = e.target.value;
                        await switchPersona(id);
                        router.push(
                          id === "USR-SPEC-01" ? "/specialist/inbox" : "/workspace"
                        );
                      }}
                      className="bg-transparent text-white font-medium focus:outline-none cursor-pointer pr-2 text-xs"
                    >
                      {personas.map((p) => (
                        <option
                          key={p.userId}
                          value={p.userId}
                          className="bg-slate-900 text-white"
                        >
                          {p.displayName} — {ROLE_LABELS[p.role]} (
                          {p.organizationName})
                        </option>
                      ))}
                    </select>
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-300 mt-0.5">
                      <span>{actor.organizationName}</span>
                      <span>•</span>
                      {actor.hasProtectedNetworkRole ? (
                        <span className="text-emerald-300 font-medium flex items-center gap-0.5">
                          <ShieldCheck className="w-3 h-3" /> QEA
                          network_consultant
                        </span>
                      ) : actor.role === "consulting_specialist" ? (
                        <span className="text-amber-300 font-medium">
                          Pending QEA network_consultant
                        </span>
                      ) : (
                        <span className="text-sky-300">
                          {ROLE_LABELS[actor.role]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {tide.authenticated ? (
                <button
                  type="button"
                  onClick={() => tide.logout()}
                  className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-medium flex items-center gap-1.5 transition cursor-pointer"
                  title="Log out of TideCloak OIDC"
                >
                  <LogOut className="w-3.5 h-3.5 text-rose-400" />
                  <span className="hidden sm:inline">Tide Logout</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => tide.login()}
                  className="px-2.5 py-1.5 rounded-lg bg-rose-500 hover:bg-rose-500 text-white text-xs font-medium flex items-center gap-1.5 transition cursor-pointer shadow-sm"
                  title="Authenticate via live TideCloak Enclave (localhost:8080)"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">TideCloak Login</span>
                </button>
              )}

              <button
                type="button"
                onClick={resetDemoData}
                disabled={resetting}
                className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
                title="Reset Case A, Case B, Case C demo state"
              >
                <RotateCcw
                  className={`w-3.5 h-3.5 ${resetting ? "animate-spin" : ""}`}
                />
                <span>Reset Demo</span>
              </button>
            </div>
          </div>
        </header>

        {bannerNotice && (
          <div className="relative z-20 bg-rose-50 border-b border-rose-200 px-4 py-2 text-xs text-rose-900 flex items-center justify-between max-w-7xl mx-auto w-full mt-2 rounded-lg">
            <span>{bannerNotice}</span>
            <button
              type="button"
              onClick={() => setBannerNotice(null)}
              className="text-rose-600 font-medium font-semibold hover:underline ml-4"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Main Content */}
        <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 py-6">
          {loading && !actor ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-600 shadow-sm">
              Initializing WebCrypto ES256 DPoP session & verifying TideCloak
              JWKS...
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </AppSessionContext.Provider>
  );
}
