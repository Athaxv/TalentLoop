"use client";

import React, { useCallback, useEffect, useState } from "react";
import ThemeToggle from "@/components/ThemeToggle";

type TabId =
  | "overview"
  | "jobs"
  | "applications"
  | "founders"
  | "outreach"
  | "profile"
  | "agents"
  | "settings";

interface DashboardPayload {
  ok: boolean;
  authenticated?: boolean;
  switchState: {
    serverUrl: string;
    roomId: string;
    agentsOnline: string[];
    transcript: Array<{
      seq: number;
      messageId: string;
      sender: string;
      senderName: string;
      body: string;
      threadId: string | null;
      timestamp: number;
    }>;
  };
  slackState: {
    liveConfigured: boolean;
    outbox: Array<{
      id: string;
      channel: string;
      agentId: string;
      agentDisplayName: string;
      text: string;
      slackMessageTs: string;
      timestamp: string;
    }>;
  };
  gmailOAuthStatus: {
    clientConfigured: boolean;
    userConnected: boolean;
    gmailEmail: string | null;
  };
  overviewMetrics: {
    jobsDiscovered: number;
    jobsShortlisted: number;
    applicationsSubmittedVerified: number;
    applicationsPendingApproval: number;
    foundersResearched: number;
    verifiedFounderEmails: number;
    emailsDrafted: number;
    emailsPendingApproval: number;
    emailsSentVerified: number;
    repliesReceived: number;
    pendingApprovalsCount: number;
  };
  candidateBundle: {
    user: {
      id: string;
      slackUserId: string;
      slackUsername: string | null;
      roleSelection: string;
      onboardingStage: string;
      onboardingCompleted: boolean;
      email: string | null;
      fullName: string | null;
    } | null;
    profile: {
      id: string;
      fullName: string;
      email: string;
      phone: string | null;
      location: string | null;
      headline: string | null;
      summary: string | null;
      experienceLevel: string;
      yearsOfExperience: number | null;
      preferredRoles: string[];
      preferredLocations: string[];
      preferredJobTypes: string[];
      workModePreference: string;
      minSalaryText: string | null;
      portfolioUrl: string | null;
      githubUrl: string | null;
      linkedinUrl: string | null;
    } | null;
    skills: Array<{ id: string; name: string; category: string }>;
    experiences: Array<{
      id: string;
      company: string;
      role: string;
      startDate: string | null;
      endDate: string | null;
      description: string;
    }>;
    educations: Array<{
      id: string;
      institution: string;
      degree: string;
      startYear: string | null;
      endYear: string | null;
    }>;
    projects: Array<{
      id: string;
      name: string;
      description: string;
      techStack: string[];
      repoUrl: string | null;
    }>;
    resumes: Array<{
      id: string;
      filename: string;
      mimeType: string;
      fileSize: number;
      createdAt: string;
    }>;
  };
  crawlJobProfilePreview: Record<string, unknown> | null;
  jobs: Array<{
    id: string;
    companyName: string;
    title: string;
    location: string;
    workMode: string;
    employmentType: string;
    salaryText: string | null;
    experienceRequirements: string | null;
    requiredSkills: string[];
    description: string;
    postedAt: string | null;
    applicationUrl: string;
    sourceUrl: string;
    platform: string;
    isVerifiedCurrent: boolean;
    matchScore: number | null;
    eligibleByCrawlJobScreen: boolean;
    screeningReason: string | null;
    matchedSkills: string[];
    matchStatus: string;
  }>;
  applications: Array<{
    id: string;
    jobId: string;
    jobTitle: string;
    companyName: string;
    jobLocation: string;
    applicationUrl: string;
    employmentType: string;
    agentId: string;
    platform: string;
    status: string;
    verifiedSubmission: boolean;
    crawlJobResultCode: string | null;
    skipOrFailureReason: string | null;
    approvalId: string | null;
    submittedAt: string | null;
    updatedAt: string;
  }>;
  founderContacts: Array<{
    id: string;
    companyName: string;
    companyWebsite: string | null;
    founderName: string;
    role: string;
    fundingStage: string | null;
    fundingAmount: string | null;
    ycBatch: string | null;
    fundingOrHiringEvidence: string;
    evidenceSourceUrl: string;
    sourceDate: string | null;
    publicEmail: string | null;
    emailVerifiedPublic: boolean;
    emailSourceUrl: string | null;
    linkedinUrl: string | null;
    relevanceToCandidate: string;
    confidenceScore: number;
    status: string;
  }>;
  emailDrafts: Array<{
    id: string;
    approvalId: string | null;
    recipientEmail: string | null;
    recipientName: string;
    companyName: string;
    subject: string;
    bodyText: string;
    gmailDraftId: string | null;
    whyCompanyExplanation: string;
    highlightedSkills: string[];
    highlightedProjects: string[];
    status: string;
    updatedAt: string;
  }>;
  emailMessages: Array<{
    id: string;
    draftId: string;
    recipientEmail: string;
    subject: string;
    gmailMessageId: string | null;
    gmailThreadId: string | null;
    status: string;
    sentAt: string | null;
    bouncedAt: string | null;
    repliedAt: string | null;
    optedOutAt: string | null;
    errorDetails: string | null;
  }>;
  agents: Array<{
    id: string;
    displayName: string;
    roleTitle: string;
    description: string;
    switchAgentId: string | null;
    switchConnectionId: string;
    switchGeneration: number;
    switchCursor: number;
    switchRoomId: string | null;
    status: string;
    currentTaskId: string | null;
    lastHeartbeatAt: string | null;
  }>;
  tasks: Array<{
    taskId: string;
    workflowId: string;
    requestingAgent: string;
    assignedAgent: string;
    taskType: string;
    status: string;
    retryCount: number;
    createdAt: string;
    updatedAt: string;
    errorText: string | null;
  }>;
  events: Array<{
    id: string;
    workflowId: string | null;
    taskId: string | null;
    agentId: string;
    eventType: string;
    switchSequence: number | null;
    summary: string;
    createdAt: string;
  }>;
  approvals: Array<{
    id: string;
    workflowId: string;
    taskId: string;
    actionType: string;
    requestedByAgent: string;
    targetAgent: string;
    title: string;
    summaryText: string;
    status: string;
    decidedBySlackUserId: string | null;
    decidedAt: string | null;
    createdAt: string;
  }>;
  workflows: Array<{
    id: string;
    title: string;
    naturalLanguageRequest: string;
    switchRoomId: string;
    status: string;
    createdAt: string;
  }>;
  devices: Array<{
    id: string;
    deviceName: string;
    tokenPrefix: string;
    status: "ONLINE" | "PAUSED" | "OFFLINE";
    crawlJobPath: string;
    profilePath: string;
    browserReady: boolean;
    lastHeartbeatAt: string | null;
  }>;
  notifications: Array<{
    id: string;
    level: string;
    title: string;
    message: string;
    createdAt: string;
  }>;
}

const NAV_ITEMS: Array<{ id: TabId; label: string; icon: string }> = [
  { id: "overview", label: "1. Overview", icon: "ph-squares-four" },
  { id: "jobs", label: "2. Discover Jobs", icon: "ph-magnifying-glass" },
  { id: "applications", label: "3. My Applications", icon: "ph-paper-plane-tilt" },
  { id: "founders", label: "4. Startup & Founder Research", icon: "ph-buildings" },
  { id: "outreach", label: "5. Email Outreach", icon: "ph-envelope-open" },
  { id: "profile", label: "6. My Profile", icon: "ph-user-circle" },
  { id: "agents", label: "7. Agent Team (Switch)", icon: "ph-robot" },
  { id: "settings", label: "8. Settings & Companion", icon: "ph-gear" },
];

export default function TalentLoopDashboard() {
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);

  // Auth Gate state
  const [authMode, setAuthMode] = useState<"login" | "register">("register");
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authSlackId, setAuthSlackId] = useState("");
  const [googleAuthToken, setGoogleAuthToken] = useState("");
  const [showGoogleTokenBox, setShowGoogleTokenBox] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Guided Onboarding state
  const [wizardResumeText, setWizardResumeText] = useState("");
  const [wizardRoles, setWizardRoles] = useState("");
  const [wizardLocations, setWizardLocations] = useState("");
  const [wizardJobTypes, setWizardJobTypes] = useState("both");
  const [wizardWorkMode, setWizardWorkMode] = useState("remote");
  const [wizardSalary, setWizardSalary] = useState("");

  // Slack Console & Profile state
  const [slackInput, setSlackInput] = useState("");
  const [resumeInput, setResumeInput] = useState("");
  const [showResumeBox, setShowResumeBox] = useState(false);
  const [profileEditField, setProfileEditField] = useState("roles");
  const [profileEditValue, setProfileEditValue] = useState("");
  const [gmailTokenInput, setGmailTokenInput] = useState("");
  const [bulkSubjectInput, setBulkSubjectInput] = useState("");
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingSubject, setEditingSubject] = useState("");
  const [editingBody, setEditingBody] = useState("");
  const [slackBotTokenInput, setSlackBotTokenInput] = useState("");
  const [slackAppTokenInput, setSlackAppTokenInput] = useState("");
  const [slackChannelIdInput, setSlackChannelIdInput] = useState("");

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await fetch("/api/talentloop/dashboard", { cache: "no-store" });
      const json = (await res.json()) as DashboardPayload;
      if (json.ok) {
        setData(json);
      }
    } catch {
      // ignore transient error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const err = params.get("auth_error") || params.get("gmail_error");
      if (err) {
        setAuthError(err);
      }
    }
    void fetchDashboard();
    const timer = setInterval(() => {
      void fetchDashboard();
    }, 3500);
    return () => clearInterval(timer);
  }, [fetchDashboard]);

  const showToast = (msg: string) => {
    setActionToast(msg);
    setTimeout(() => setActionToast(null), 5000);
  };

  const handleOneClickGoogleSignIn = async () => {
    setAuthError(null);
    setBusyAction("auth");
    try {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oneClick: true }),
      });
      const json = await res.json();
      if (!json.ok) {
        setAuthError(json.error || "Google authentication failed");
        return;
      }
      if (json.redirectUrl) {
        window.location.href = json.redirectUrl;
        return;
      }
      showToast(
        `Signed in with Google as ${json.user.email} (Gmail OAuth authorized!)`,
      );
      await fetchDashboard();
    } finally {
      setBusyAction(null);
    }
  };

  const handleLogout = async () => {
    setBusyAction("logout");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      await fetchDashboard();
    } finally {
      setBusyAction(null);
    }
  };

  const sendSlackMessageToMilo = async (
    customText?: string,
    customResume?: string,
  ) => {
    const textToSend = (customText ?? slackInput).trim();
    if (!textToSend && !customResume) return;
    setBusyAction("slack-send");
    try {
      const res = await fetch("/api/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: textToSend || "Uploaded resume",
          uploadedResumeText:
            customResume || (showResumeBox ? resumeInput : undefined),
        }),
      });
      const json = await res.json();
      if (json.ok) {
        if (!customText) setSlackInput("");
        if (showResumeBox) {
          setResumeInput("");
          setShowResumeBox(false);
        }
        showToast("Message processed by @milo in Switch room #talentloop-job-search");
        await fetchDashboard();
      } else {
        showToast(`Error: ${json.error}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const runWorkflowAction = async (
    step:
      | "reset_my_data"
      | "discover_jobs"
      | "research_founders"
      | "start_workflow"
      | "approve_applications"
      | "approve_emails"
      | "final_report",
  ) => {
    setBusyAction(step);
    try {
      const res = await fetch("/api/demo/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step }),
      });
      const json = await res.json();
      if (json.ok) {
        showToast(`Executed action: ${step}`);
        await fetchDashboard();
      } else {
        showToast(`Notice: ${json.error}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleApprovalDecision = async (
    approvalId: string,
    decision: "approve" | "reject",
  ) => {
    await sendSlackMessageToMilo(`${decision} ${approvalId}`);
  };

  const handleDeviceAction = async (
    action: "register" | "pause" | "resume" | "sync_profile",
    deviceId?: string,
  ) => {
    setBusyAction(`device-${action}`);
    try {
      const res = await fetch("/api/companion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, deviceId }),
      });
      const json = await res.json();
      if (json.ok) {
        showToast(`Companion action "${action}" succeeded`);
        await fetchDashboard();
      } else {
        showToast(`Companion error: ${json.error}`);
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleGoogleTokenSignIn = async () => {
    if (!googleAuthToken.trim()) return;
    setAuthError(null);
    setBusyAction("google-auth");
    try {
      const res = await fetch("/api/auth/google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: googleAuthToken.trim() }),
      });
      const json = await res.json();
      if (!json.ok) {
        setAuthError(json.error || "Google OAuth token verification failed");
        return;
      }
      setGoogleAuthToken("");
      showToast(`Signed in with Google as ${json.user.email} (Gmail OAuth connected!)`);
      await fetchDashboard();
    } finally {
      setBusyAction(null);
    }
  };

  const handleResumeFileUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
    target: "wizard" | "slack" = "wizard",
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusyAction("pdf-parse");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/resume/parse", {
        method: "POST",
        body: formData,
      });
      const json = await res.json();
      if (!json.ok) {
        showToast(json.error || "Failed to parse resume file");
        return;
      }
      if (target === "slack") {
        setResumeInput(json.extractedText);
      } else {
        setWizardResumeText(json.extractedText);
      }
      showToast(
        `Extracted ${json.pageCount} page(s) & ${json.parsed?.skills?.length ?? 0} skills from ${file.name}`,
      );
    } finally {
      setBusyAction(null);
      e.target.value = "";
    }
  };

  // ---------------------------------------------------------------------------
  // 1. UNAUTHENTICATED GATE: Require User Sign Up / Sign In
  // ---------------------------------------------------------------------------
  if (!loading && data && data.authenticated === false) {
    return (
      <div
        id="main"
        className="min-h-screen bg-ink-950 text-fg flex flex-col justify-between p-6"
      >
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between py-2">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-ember font-mono text-lg font-bold text-white">
              TL
            </div>
            <div>
              <h1 className="text-lg font-bold">TalentLoop</h1>
              <p className="text-xs text-fg/60">
                Switch-Powered Multi-Agent Job Search Platform
              </p>
            </div>
          </div>
          <ThemeToggle />
        </header>

        <div className="mx-auto my-auto grid w-full max-w-5xl grid-cols-1 lg:grid-cols-12 gap-8 items-center py-8">
          <div className="lg:col-span-6 space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full border border-line bg-ink-900 px-3 py-1 font-mono text-xs text-ember">
              ● 6 Switch Agents Ready in #talentloop-job-search
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">
              Your AI Job Search Team, Coordinated Over Switch.
            </h2>
            <p className="text-sm text-fg/70 leading-relaxed">
              Sign in or create an account to onboard with{" "}
              <strong>@milo (Talent Manager)</strong>, discover live opportunities with{" "}
              <strong>@scout</strong>, automate local browser applications with{" "}
              <strong>@wally</strong> (Wellfound) &amp; <strong>@inky</strong>{" "}
              (Internshala), research funded founders with <strong>@clover</strong>, and
              send approved Gmail outreach with <strong>@pip</strong>.
            </p>
            <div className="grid grid-cols-2 gap-3 pt-2 text-xs">
              <div className="rounded-xl border border-line bg-ink-900 p-3">
                <div className="font-bold text-ember">@milo · @scout</div>
                <div className="text-fg/65 mt-0.5">
                  Onboarding, workflow planning &amp; live opportunity ranking.
                </div>
              </div>
              <div className="rounded-xl border border-line bg-ink-900 p-3">
                <div className="font-bold text-ember">@wally · @inky</div>
                <div className="text-fg/65 mt-0.5">
                  Local Playwright crawlJob browser execution with human approval.
                </div>
              </div>
              <div className="rounded-xl border border-line bg-ink-900 p-3">
                <div className="font-bold text-ember">@clover · @pip</div>
                <div className="text-fg/65 mt-0.5">
                  Live YC founder discovery &amp; OAuth2 Gmail cold outreach.
                </div>
              </div>
              <div className="rounded-xl border border-line bg-ink-900 p-3">
                <div className="font-bold text-ember">Strict Security</div>
                <div className="text-fg/65 mt-0.5">
                  Authenticated sessions, zero fake sends, and human approval gates.
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="rounded-2xl border border-line bg-ink-900 p-8 sm:p-10 shadow-xl space-y-6 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white p-3 shadow-md">
                <svg className="h-7 w-7" viewBox="0 0 24 24">
                  <path
                    fill="#EA4335"
                    d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.3 14.8c-.2-.8-.4-1.6-.4-2.5s.2-1.7.4-2.5L1.6 7C.6 9 0 11.2 0 12.3s.6 3.3 1.6 5.3l3.7-2.8z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5L1.6 16c1.9 3.9 5.8 7 10.4 7z"
                  />
                </svg>
              </div>

              <div className="space-y-1.5">
                <h3 className="text-xl font-bold">Continue with Google</h3>
                <p className="text-xs text-fg/65 max-w-sm mx-auto leading-relaxed">
                  One-click Google OAuth 2.0 sign-in for TalentLoop, your Switch agent room, and @pip Gmail outreach.
                </p>
              </div>

              {authError && (
                <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300 text-left">
                  {authError}
                </div>
              )}

              <button
                type="button"
                onClick={handleOneClickGoogleSignIn}
                disabled={busyAction !== null}
                className="w-full flex items-center justify-center gap-3 rounded-xl bg-white py-3.5 px-5 text-sm font-bold text-neutral-900 shadow-lg hover:bg-neutral-100 active:scale-[0.99] transition disabled:opacity-50 cursor-pointer"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24">
                  <path
                    fill="#EA4335"
                    d="M12 5c1.6 0 3 .6 4.1 1.7l3.1-3.1C17.3 1.8 14.8 1 12 1 7.4 1 3.5 3.6 1.6 7.4l3.7 2.8C6.2 7.2 8.9 5 12 5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5c-.3 1.5-1.1 2.8-2.4 3.6l3.7 2.9c2.2-2 3.7-5 3.7-8.7z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.3 14.8c-.2-.8-.4-1.6-.4-2.5s.2-1.7.4-2.5L1.6 7C.6 9 0 11.2 0 12.3s.6 3.3 1.6 5.3l3.7-2.8z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 23c3.2 0 6-1.1 8-3l-3.7-2.9c-1.1.7-2.5 1.2-4.3 1.2-3.1 0-5.8-2.1-6.7-5L1.6 16c1.9 3.9 5.8 7 10.4 7z"
                  />
                </svg>
                <span>
                  {busyAction === "auth"
                    ? "Signing in with Google..."
                    : "Sign in with Google"}
                </span>
              </button>

              {/* Authorized Scopes Preview */}
              <div className="rounded-xl border border-line bg-ink-950 p-3.5 space-y-2 font-mono text-[11px] text-fg/75 text-left">
                <div className="text-[10px] uppercase text-fg/50">
                  Authorized Google OAuth 2.0 Scopes:
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded bg-ink-800 px-2 py-0.5 text-emerald-400">
                    ✓ openid &amp; profile
                  </span>
                  <span className="rounded bg-ink-800 px-2 py-0.5 text-emerald-400">
                    ✓ gmail.compose (@pip drafts)
                  </span>
                  <span className="rounded bg-ink-800 px-2 py-0.5 text-emerald-400">
                    ✓ gmail.send (approved outreach)
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="mx-auto w-full max-w-6xl border-t border-line pt-4 text-center text-xs text-fg/50">
          TalentLoop · Powered by Switch Agent Protocol &amp; crawlJob Local Browser Automation
        </footer>
      </div>
    );
  }

  const currentUser = data?.candidateBundle?.user;
  const isOnboarded = Boolean(currentUser?.onboardingCompleted);
  const onboardingStage = currentUser?.onboardingStage ?? "WELCOME";

  const metrics = data?.overviewMetrics ?? {
    jobsDiscovered: 0,
    jobsShortlisted: 0,
    applicationsSubmittedVerified: 0,
    applicationsPendingApproval: 0,
    foundersResearched: 0,
    verifiedFounderEmails: 0,
    emailsDrafted: 0,
    emailsPendingApproval: 0,
    emailsSentVerified: 0,
    repliesReceived: 0,
    pendingApprovalsCount: 0,
  };

  return (
    <div id="main" className="min-h-screen bg-ink-950 text-fg">
      {/* Top Header Bar */}
      <header className="sticky top-0 z-40 border-b border-line bg-ink-900/90 backdrop-blur-md px-6 py-3.5">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-ember font-mono text-lg font-bold text-white shadow-sm">
              TL
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight">TalentLoop</h1>
                <span className="rounded-full border border-line bg-ink-800 px-2.5 py-0.5 font-mono text-xs text-fg/80">
                  Switch Multi-Agent Platform
                </span>
              </div>
              <p className="text-xs text-fg/60">
                Room:{" "}
                <code className="font-mono text-fg/90">
                  {data?.switchState?.roomId ??
                    "!room-talentloop-job-search:talentloop.local"}
                </code>{" "}
                · {data?.switchState?.agentsOnline?.length ?? 6}/6 Switch Agents Online
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {currentUser && (
              <div className="flex items-center gap-2 rounded-full border border-line bg-ink-800 px-3 py-1 text-xs">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                <span className="font-semibold">{currentUser.fullName}</span>
                <span className="font-mono text-[11px] text-fg/55">
                  ({currentUser.slackUserId})
                </span>
              </div>
            )}

            {metrics.pendingApprovalsCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 border border-amber-500/40 px-3 py-1 text-xs font-semibold text-amber-300">
                <i className="ph-fill ph-warning-circle" />
                {metrics.pendingApprovalsCount} Approval(s) Pending
              </span>
            )}

            {isOnboarded && (
              <button
                onClick={() => runWorkflowAction("start_workflow")}
                disabled={busyAction !== null}
                className="inline-flex items-center gap-2 rounded-full bg-ember px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50 cursor-pointer"
              >
                <i className="ph-fill ph-play" />
                {busyAction === "start_workflow"
                  ? "Running Switch Agents (@scout + @clover + @pip)..."
                  : "Run Job Search & Outreach Workflow"}
              </button>
            )}

            <button
              onClick={() => runWorkflowAction("reset_my_data")}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-800 px-3 py-1.5 text-xs font-semibold text-fg/80 transition hover:bg-ink-700 disabled:opacity-50 cursor-pointer"
            >
              <i className="ph ph-trash" />
              Clear My Workflow Data
            </button>

            <button
              onClick={handleLogout}
              disabled={busyAction !== null}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-ink-800 px-3 py-1.5 text-xs font-semibold text-fg/80 transition hover:bg-ink-700 cursor-pointer"
            >
              Sign Out
            </button>

            <ThemeToggle />
          </div>
        </div>
      </header>

      {actionToast && (
        <div className="fixed bottom-5 right-5 z-50 rounded-xl border border-line bg-ink-800 px-4 py-3 text-xs font-medium shadow-xl">
          <span className="text-emerald-400 font-semibold">✓ </span>
          {actionToast}
        </div>
      )}

      {/* Main Layout Grid */}
      <div className="mx-auto grid max-w-[1600px] grid-cols-1 lg:grid-cols-12 gap-6 px-6 py-6">
        {/* Left Navigation Sidebar (8 Pages) */}
        <aside className="lg:col-span-3 xl:col-span-2 space-y-4">
          <nav className="rounded-2xl border border-line bg-ink-900 p-2.5 space-y-1">
            <div className="px-3 py-2 text-[11px] font-mono uppercase tracking-wider text-fg/50">
              Dashboard Pages
            </div>
            {NAV_ITEMS.map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs font-medium transition cursor-pointer ${
                    active
                      ? "bg-btn text-btnfg font-semibold shadow-sm"
                      : "text-fg/75 hover:bg-hover hover:text-fg"
                  }`}
                >
                  <i className={`ph ${item.icon} text-base`} />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Specialist Agent Actions */}
          <div className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5">
            <div className="text-xs font-semibold flex items-center gap-1.5">
              <i className="ph-fill ph-lightning text-ember" />
              Delegate to Switch Agents
            </div>
            <p className="text-[11px] text-fg/60 leading-relaxed">
              {isOnboarded
                ? "Delegate tasks to your specialist agents via @milo:"
                : "Complete onboarding with @milo first to unlock specialist agents."}
            </p>
            <div className="grid grid-cols-1 gap-1.5">
              <button
                onClick={() => runWorkflowAction("discover_jobs")}
                disabled={!isOnboarded || busyAction !== null}
                className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-left text-xs hover:bg-ink-700 disabled:opacity-40 cursor-pointer"
              >
                1. Discover Live Jobs (@scout)
              </button>
              <button
                onClick={() => runWorkflowAction("research_founders")}
                disabled={!isOnboarded || busyAction !== null}
                className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-left text-xs hover:bg-ink-700 disabled:opacity-40 cursor-pointer"
              >
                2. Research Founders &amp; Draft Emails (@clover + @pip)
              </button>
              <button
                onClick={() => runWorkflowAction("approve_applications")}
                disabled={!isOnboarded || busyAction !== null}
                className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-left text-xs hover:bg-ink-700 disabled:opacity-40 cursor-pointer"
              >
                3. Approve &amp; Run Browser Applications (@wally + @inky)
              </button>
              <button
                onClick={() => runWorkflowAction("approve_emails")}
                disabled={!isOnboarded || busyAction !== null}
                className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-left text-xs hover:bg-ink-700 disabled:opacity-40 cursor-pointer"
              >
                4. Approve &amp; Send Gmail Outreach (@pip)
              </button>
              <button
                onClick={() => runWorkflowAction("final_report")}
                disabled={!isOnboarded || busyAction !== null}
                className="rounded-lg border border-line bg-ink-800 px-3 py-2 text-left text-xs hover:bg-ink-700 disabled:opacity-40 cursor-pointer"
              >
                5. Generate Consolidated Report (@milo)
              </button>
            </div>
          </div>
        </aside>

        {/* Center Main Content Area */}
        <main className="lg:col-span-6 xl:col-span-7 space-y-6">
          {loading && !data ? (
            <div className="rounded-2xl border border-line bg-ink-900 p-12 text-center text-sm text-fg/60">
              Connecting to Switch Server and loading your session...
            </div>
          ) : (
            <>
              {/* LIVE GOOGLE OAUTH 2.0 UPGRADE BANNER (Shown if current session predates .env Google OAuth credentials) */}
              {data && !data.gmailOAuthStatus?.userConnected && (
                <div className="rounded-2xl border-2 border-amber-500/60 bg-ink-900 p-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5 text-xs">
                    <div className="font-bold text-amber-300 flex items-center gap-1.5">
                      <i className="ph-fill ph-google-logo text-base" />
                      Connect Your Live Google Account (OAuth 2.0 Ready)
                    </div>
                    <p className="text-fg/75">
                      Your Google Cloud OAuth credentials are now active in <code className="font-mono">.env</code>! Click to sign in with Google so @pip creates drafts and sends emails directly from your real Gmail account.
                    </p>
                  </div>
                  <a
                    href="/api/auth/google"
                    className="rounded-xl bg-white px-4 py-2 text-xs font-bold text-neutral-900 shadow hover:bg-neutral-100 shrink-0"
                  >
                    Authorize with Google OAuth 2.0 →
                  </a>
                </div>
              )}

              {/* GUIDED ONBOARDING WIZARD (Shown when authenticated user has not finished onboarding) */}
              {!isOnboarded && (
                <div className="rounded-2xl border-2 border-ember/60 bg-ink-900 p-6 space-y-4 shadow-lg">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                    <div>
                      <span className="rounded-full bg-ember/20 px-2.5 py-0.5 font-mono text-[11px] font-bold text-ember">
                        Onboarding Required · Stage: {onboardingStage}
                      </span>
                      <h2 className="text-lg font-bold mt-1">
                        Complete Your Onboarding with @milo
                      </h2>
                    </div>
                    <span className="text-xs text-fg/60">
                      Synchronized with #talentloop-job-search
                    </span>
                  </div>

                  {(onboardingStage === "WELCOME" ||
                    onboardingStage === "ROLE_SELECTION" ||
                    onboardingStage === "HIRING_WAITLIST") && (
                    <div className="space-y-3 text-xs">
                      <p className="text-fg/80">
                        <strong>@milo:</strong> &ldquo;Before we start, what brings you
                        here?&rdquo;
                      </p>
                      <div className="flex flex-wrap gap-3">
                        <button
                          onClick={() => sendSlackMessageToMilo("1")}
                          disabled={busyAction !== null}
                          className="rounded-xl bg-ember px-4 py-2.5 font-bold text-white hover:opacity-90 cursor-pointer"
                        >
                          1. I&apos;m looking for a job (Job Seeker)
                        </button>
                        <button
                          onClick={() => sendSlackMessageToMilo("2")}
                          disabled={busyAction !== null}
                          className="rounded-xl border border-line bg-ink-800 px-4 py-2.5 font-semibold text-fg/80 hover:bg-ink-700 cursor-pointer"
                        >
                          2. I&apos;m hiring candidates
                        </button>
                      </div>
                    </div>
                  )}

                  {onboardingStage === "COLLECT_RESUME" && (
                    <div className="space-y-3 text-xs">
                      <p className="text-fg/80">
                        <strong>Step 1 of 3 — Upload or Paste Your Resume:</strong>{" "}
                        Provide your factual resume text (Name, Email, Phone, Location,
                        Skills, Experience, Education, Projects, and GitHub/LinkedIn
                        links). @milo will extract only factual information without
                        inventing anything.
                      </p>
                      <div className="flex items-center gap-3">
                        <label className="rounded-lg border border-line bg-ink-800 px-3.5 py-2 font-semibold hover:bg-ink-700 cursor-pointer inline-flex items-center gap-2">
                          <i className="ph-fill ph-file-pdf text-ember text-base" />
                          <span>
                            {busyAction === "pdf-parse"
                              ? "Extracting PDF Text..."
                              : "Upload Resume File (.pdf, .txt, .md, .json)"}
                          </span>
                          <input
                            type="file"
                            accept=".pdf,application/pdf,.txt,.md,.json"
                            onChange={(e) => handleResumeFileUpload(e, "wizard")}
                            className="hidden"
                          />
                        </label>
                      </div>
                      <textarea
                        rows={7}
                        value={wizardResumeText}
                        onChange={(e) => setWizardResumeText(e.target.value)}
                        placeholder={`Example:\n${currentUser?.fullName || "Your Name"}\nLocation: Bangalore, India\nEmail: ${currentUser?.email || "you@example.com"} | Phone: +91 9876543210\nGitHub: https://github.com/your-username | LinkedIn: https://www.linkedin.com/in/your-profile\n\nSkills: TypeScript, React, Next.js, Node.js, PostgreSQL, Python, Docker\n\nExperience\nSoftware Engineer Intern at CompanyName (2025)\n- Built backend APIs and services\n\nEducation\nB.Tech in Computer Science — Your University, 2023 - 2027\n\nProjects\nProjectName — Description of what you built`}
                        className="w-full rounded-xl border border-line bg-ink-950 p-3 text-xs font-mono"
                      />
                      <button
                        onClick={() => {
                          if (wizardResumeText.trim().length < 20) {
                            showToast("Please paste or upload your resume text first.");
                            return;
                          }
                          void sendSlackMessageToMilo(
                            "Uploaded my resume",
                            wizardResumeText.trim(),
                          );
                        }}
                        disabled={busyAction !== null}
                        className="rounded-xl bg-ember px-4 py-2.5 font-bold text-white hover:opacity-90 cursor-pointer"
                      >
                        Parse Resume with @milo →
                      </button>
                    </div>
                  )}

                  {onboardingStage === "COLLECT_PREFERENCES" && (
                    <div className="space-y-3 text-xs">
                      <p className="text-fg/80">
                        <strong>Step 2 of 3 — Set Your Job Search Preferences:</strong>
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-fg/70 mb-1 font-semibold">
                            Preferred Roles (comma-separated) *
                          </label>
                          <input
                            type="text"
                            value={wizardRoles}
                            onChange={(e) => setWizardRoles(e.target.value)}
                            placeholder="Full Stack Developer, Software Engineer, Backend Intern"
                            className="w-full rounded-xl border border-line bg-ink-800 px-3 py-2"
                          />
                        </div>
                        <div>
                          <label className="block text-fg/70 mb-1 font-semibold">
                            Preferred Locations (comma-separated) *
                          </label>
                          <input
                            type="text"
                            value={wizardLocations}
                            onChange={(e) => setWizardLocations(e.target.value)}
                            placeholder="Bangalore, Remote, India"
                            className="w-full rounded-xl border border-line bg-ink-800 px-3 py-2"
                          />
                        </div>
                        <div>
                          <label className="block text-fg/70 mb-1 font-semibold">
                            Job Types
                          </label>
                          <select
                            value={wizardJobTypes}
                            onChange={(e) => setWizardJobTypes(e.target.value)}
                            className="w-full rounded-xl border border-line bg-ink-800 px-3 py-2"
                          >
                            <option value="both">Both (Internships &amp; Full-Time)</option>
                            <option value="internship">Internships Only</option>
                            <option value="full-time">Full-Time Only</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-fg/70 mb-1 font-semibold">
                            Work Mode Preference
                          </label>
                          <select
                            value={wizardWorkMode}
                            onChange={(e) => setWizardWorkMode(e.target.value)}
                            className="w-full rounded-xl border border-line bg-ink-800 px-3 py-2"
                          >
                            <option value="remote">Remote</option>
                            <option value="hybrid">Hybrid</option>
                            <option value="onsite">On-site</option>
                            <option value="any">Any</option>
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block text-fg/70 mb-1 font-semibold">
                            Minimum Salary or Stipend (optional)
                          </label>
                          <input
                            type="text"
                            value={wizardSalary}
                            onChange={(e) => setWizardSalary(e.target.value)}
                            placeholder="e.g. INR 40,000/month or INR 12 LPA"
                            className="w-full rounded-xl border border-line bg-ink-800 px-3 py-2"
                          />
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (!wizardRoles.trim()) {
                            showToast("Please enter at least one target role.");
                            return;
                          }
                          const prefMsg = `Roles: ${wizardRoles.trim()} | Locations: ${wizardLocations.trim() || "Remote, India"} | Types: ${wizardJobTypes} | Work mode: ${wizardWorkMode}${wizardSalary.trim() ? ` | Min salary: ${wizardSalary.trim()}` : ""}`;
                          void sendSlackMessageToMilo(prefMsg);
                        }}
                        disabled={busyAction !== null}
                        className="rounded-xl bg-ember px-4 py-2.5 font-bold text-white hover:opacity-90 cursor-pointer"
                      >
                        Save Preferences &amp; Review Profile →
                      </button>
                    </div>
                  )}

                  {onboardingStage === "REVIEW_PROFILE" &&
                    data?.candidateBundle?.profile && (
                      <div className="space-y-3 text-xs">
                        <p className="text-fg/80">
                          <strong>Step 3 of 3 — Review &amp; Confirm Extracted Profile:</strong>
                        </p>
                        <div className="rounded-xl border border-line bg-ink-950 p-3.5 space-y-1.5">
                          <div>
                            <strong>Name:</strong>{" "}
                            {data.candidateBundle.profile.fullName} ·{" "}
                            <strong>Email:</strong> {data.candidateBundle.profile.email}
                          </div>
                          <div>
                            <strong>Target Roles:</strong>{" "}
                            {data.candidateBundle.profile.preferredRoles.join(", ")}
                          </div>
                          <div>
                            <strong>Locations / Mode:</strong>{" "}
                            {data.candidateBundle.profile.preferredLocations.join(", ")} (
                            {data.candidateBundle.profile.workModePreference})
                          </div>
                          <div>
                            <strong>Skills:</strong>{" "}
                            {data.candidateBundle.skills.map((s) => s.name).join(", ") ||
                              "None listed"}
                          </div>
                        </div>
                        <button
                          onClick={() => sendSlackMessageToMilo("confirm")}
                          disabled={busyAction !== null}
                          className="rounded-xl bg-emerald-600 px-5 py-2.5 font-bold text-white hover:bg-emerald-500 cursor-pointer"
                        >
                          ✓ Confirm Profile &amp; Sync to crawlJob
                        </button>
                      </div>
                    )}
                </div>
              )}

              {/* PAGE 1: OVERVIEW */}
              {activeTab === "overview" && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-xl font-bold">1. Overview</h2>
                    <p className="text-xs text-fg/60">
                      Real-time metrics for{" "}
                      <strong>{currentUser?.fullName || "your account"}</strong> calculated
                      strictly from persisted SQLite task, application, and outreach
                      records.
                    </p>
                  </div>

                  {/* Primary KPI Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                    <MetricCard
                      label="Jobs Discovered (@scout)"
                      value={metrics.jobsDiscovered}
                      sub={`${metrics.jobsShortlisted} shortlisted via crawlJob filter`}
                    />
                    <MetricCard
                      label="Verified Applications (@wally & @inky)"
                      value={metrics.applicationsSubmittedVerified}
                      sub="Confirmed in local Playwright browser"
                    />
                    <MetricCard
                      label="Applications Pending Approval"
                      value={metrics.applicationsPendingApproval}
                      sub="Awaiting your approval in Slack/UI"
                    />
                    <MetricCard
                      label="Emails Drafted (@pip)"
                      value={metrics.emailsDrafted}
                      sub={`${metrics.foundersResearched} founders researched by @clover`}
                    />
                    <MetricCard
                      label="Emails Sent (Verified Gmail ID)"
                      value={metrics.emailsSentVerified}
                      sub="Requires approval + Gmail OAuth2"
                    />
                    <MetricCard
                      label="Replies Received"
                      value={metrics.repliesReceived}
                      sub="Tracked distinct from sent/delivered"
                    />
                  </div>

                  {/* Pending Human Approvals Banner */}
                  {data &&
                    data.approvals.filter((a) => a.status === "PENDING").length > 0 && (
                      <div className="rounded-2xl border border-amber-500/40 bg-ink-900 p-5 space-y-3">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-bold text-amber-300 flex items-center gap-2">
                            <i className="ph-fill ph-shield-warning text-lg" />
                            Human Approval Gate — Action Required Before Execution
                          </h3>
                          <button
                            onClick={() => sendSlackMessageToMilo("approve all")}
                            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                          >
                            Approve All Pending (
                            {
                              data.approvals.filter((a) => a.status === "PENDING")
                                .length
                            }
                            )
                          </button>
                        </div>
                        <div className="space-y-2.5">
                          {data.approvals
                            .filter((a) => a.status === "PENDING")
                            .map((apr) => (
                              <div
                                key={apr.id}
                                className="rounded-xl border border-line bg-ink-800 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                              >
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-mono text-xs font-bold text-amber-300">
                                      {apr.id}
                                    </span>
                                    <span className="rounded bg-ink-700 px-2 py-0.5 text-[11px] font-mono">
                                      @{apr.targetAgent} · {apr.actionType}
                                    </span>
                                  </div>
                                  <div className="text-xs font-semibold">{apr.title}</div>
                                  <pre className="text-[11px] text-fg/70 whitespace-pre-wrap font-sans">
                                    {apr.summaryText}
                                  </pre>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <button
                                    onClick={() =>
                                      handleApprovalDecision(apr.id, "approve")
                                    }
                                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                                  >
                                    Approve
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleApprovalDecision(apr.id, "reject")
                                    }
                                    className="rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-xs font-semibold text-fg/80 hover:bg-ink-600 cursor-pointer"
                                  >
                                    Reject
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    )}

                  {/* Recent Agent Activity Stream */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-bold">Recent Switch Agent Activity</h3>
                      <span className="font-mono text-xs text-fg/50">
                        {data?.events.length ?? 0} logged events
                      </span>
                    </div>
                    <div className="max-h-[380px] overflow-y-auto space-y-2 pr-1">
                      {data?.events.length === 0 ? (
                        <p className="text-xs text-fg/50 py-6 text-center">
                          No agent events yet. Complete onboarding with @milo to start your
                          first workflow.
                        </p>
                      ) : (
                        data?.events.slice(0, 25).map((evt) => (
                          <div
                            key={evt.id}
                            className="rounded-xl border border-line bg-ink-800 px-3.5 py-2.5 text-xs flex items-start justify-between gap-3"
                          >
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className="rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[11px] font-semibold">
                                  @{evt.agentId}
                                </span>
                                <span className="font-mono text-[11px] text-fg/60">
                                  {evt.eventType}
                                </span>
                                {evt.switchSequence !== null && (
                                  <span className="font-mono text-[10px] text-fg/40">
                                    seq #{evt.switchSequence}
                                  </span>
                                )}
                              </div>
                              <p className="text-fg/90">{evt.summary}</p>
                            </div>
                            <span className="font-mono text-[10px] text-fg/45 shrink-0">
                              {new Date(evt.createdAt).toLocaleTimeString()}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* PAGE 2: DISCOVER JOBS */}
              {activeTab === "jobs" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-bold">2. Discover Jobs (@scout)</h2>
                      <p className="text-xs text-fg/60">
                        Live opportunities discovered for your profile, deduplicated, and
                        screened with crawlJob rules.
                      </p>
                    </div>
                    <span className="rounded-full border border-line bg-ink-800 px-3 py-1 font-mono text-xs">
                      {data?.jobs.length ?? 0} matched listings
                    </span>
                  </div>

                  {data?.jobs.length === 0 ? (
                    <div className="rounded-2xl border border-line bg-ink-900 p-10 text-center text-xs text-fg/60">
                      No jobs discovered for your profile yet. Click &ldquo;1. Discover
                      Live Jobs (@scout)&rdquo; on the left sidebar after onboarding.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data?.jobs.map((job) => (
                        <div
                          key={job.id}
                          className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm font-bold">{job.title}</h3>
                                <span className="rounded bg-ink-800 border border-line px-2 py-0.5 font-mono text-[11px] uppercase">
                                  {job.platform}
                                </span>
                                <span className="rounded bg-ink-800 px-2 py-0.5 text-[11px] text-fg/75">
                                  {job.employmentType} · {job.workMode}
                                </span>
                              </div>
                              <div className="text-xs text-fg/80 font-medium mt-0.5">
                                {job.companyName} · {job.location}
                                {job.salaryText ? ` · ${job.salaryText}` : ""}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {job.matchScore !== null && (
                                <span
                                  className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-bold ${
                                    job.eligibleByCrawlJobScreen && job.matchScore >= 70
                                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                      : job.eligibleByCrawlJobScreen
                                        ? "bg-blue-500/20 text-blue-300 border border-blue-500/30"
                                        : "bg-red-500/20 text-red-300 border border-red-500/30"
                                  }`}
                                >
                                  Match: {job.matchScore}%
                                </span>
                              )}
                              <a
                                href={job.applicationUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded-lg bg-btn px-3 py-1 text-xs font-semibold text-btnfg hover:opacity-90"
                              >
                                Direct Posting ↗
                              </a>
                            </div>
                          </div>

                          <p className="text-xs text-fg/75 line-clamp-2">
                            {job.description}
                          </p>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-line text-[11px]">
                            <div className="flex flex-wrap gap-1.5">
                              {job.requiredSkills.map((sk) => (
                                <span
                                  key={sk}
                                  className="rounded bg-ink-800 px-2 py-0.5 font-mono text-[10px]"
                                >
                                  {sk}
                                </span>
                              ))}
                            </div>
                            <span className="text-fg/60 font-mono">
                              crawlJob screen:{" "}
                              {job.eligibleByCrawlJobScreen ? (
                                <span className="text-emerald-400">ELIGIBLE</span>
                              ) : (
                                <span className="text-amber-300">
                                  SKIPPED ({job.screeningReason})
                                </span>
                              )}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* PAGE 3: MY APPLICATIONS */}
              {activeTab === "applications" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-bold">
                        3. My Applications (@wally &amp; @inky)
                      </h2>
                      <p className="text-xs text-fg/60">
                        Only verified submissions in your local Playwright browser count
                        as APPLIED.
                      </p>
                    </div>
                    <span className="rounded-full border border-line bg-ink-800 px-3 py-1 font-mono text-xs">
                      {metrics.applicationsSubmittedVerified} verified /{" "}
                      {data?.applications.length ?? 0} total
                    </span>
                  </div>

                  {data?.applications.length === 0 ? (
                    <div className="rounded-2xl border border-line bg-ink-900 p-10 text-center text-xs text-fg/60">
                      No application records yet. Shortlist jobs with @scout and approve
                      the batch for @wally and @inky.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data?.applications.map((app) => (
                        <div
                          key={app.id}
                          className="rounded-2xl border border-line bg-ink-900 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                        >
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs font-semibold rounded bg-ink-800 px-2 py-0.5">
                                @{app.agentId} ({app.platform})
                              </span>
                              <span className="text-sm font-bold">{app.jobTitle}</span>
                              <span className="text-xs text-fg/70">
                                at {app.companyName}
                              </span>
                            </div>
                            <div className="text-xs text-fg/65">
                              {app.skipOrFailureReason ?? "Awaiting approval / execution"}
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-fg/50">
                              <a
                                href={app.applicationUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline hover:text-fg"
                              >
                                {app.applicationUrl}
                              </a>
                              {app.approvalId && <span>Approval: {app.approvalId}</span>}
                              {app.crawlJobResultCode && (
                                <span>crawlJob result: {app.crawlJobResultCode}</span>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <span
                              className={`rounded-full px-3 py-1 font-mono text-xs font-bold ${
                                app.status === "APPLIED" && app.verifiedSubmission
                                  ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                  : app.status === "PENDING_APPROVAL"
                                    ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                    : "bg-ink-800 text-fg/80 border border-line"
                              }`}
                            >
                              {app.status}
                              {app.verifiedSubmission ? " ✓ VERIFIED" : ""}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* PAGE 4: STARTUP & FOUNDER RESEARCH */}
              {activeTab === "founders" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-bold">
                        4. Startup &amp; Founder Research (@clover)
                      </h2>
                      <p className="text-xs text-fg/60">
                        Live YC startups and founders with source citations, confidence
                        scores, and verified public business emails.
                      </p>
                    </div>
                    <span className="rounded-full border border-line bg-ink-800 px-3 py-1 font-mono text-xs">
                      {metrics.verifiedFounderEmails} verified emails /{" "}
                      {data?.founderContacts.length ?? 0} founders
                    </span>
                  </div>

                  {data?.founderContacts.length === 0 ? (
                    <div className="rounded-2xl border border-line bg-ink-900 p-10 text-center text-xs text-fg/60">
                      No founder contacts researched yet. Click &ldquo;2. Research
                      Founders &amp; Draft Emails (@clover + @pip)&rdquo; on the sidebar.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data?.founderContacts.map((fc) => (
                        <div
                          key={fc.id}
                          className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="text-sm font-bold">{fc.founderName}</h3>
                                <span className="text-xs text-fg/75">
                                  {fc.role} at <strong>{fc.companyName}</strong>
                                </span>
                                {fc.fundingAmount && (
                                  <span className="rounded bg-ink-800 border border-line px-2 py-0.5 font-mono text-[11px]">
                                    {fc.fundingAmount}
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-fg/80 mt-1">
                                <strong>Evidence:</strong> {fc.fundingOrHiringEvidence}
                              </p>
                            </div>
                            <span className="rounded-full bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-0.5 font-mono text-xs font-bold text-emerald-300">
                              Confidence: {fc.confidenceScore}%
                            </span>
                          </div>

                          <p className="text-xs text-fg/70">
                            <strong>Relevance to Candidate:</strong>{" "}
                            {fc.relevanceToCandidate}
                          </p>

                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-line text-[11px] font-mono">
                            <div>
                              {fc.emailVerifiedPublic && fc.publicEmail ? (
                                <span className="text-emerald-400">
                                  ✓ Public Business Email: {fc.publicEmail} (Source:{" "}
                                  <a
                                    href={fc.emailSourceUrl ?? "#"}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline"
                                  >
                                    {fc.emailSourceUrl}
                                  </a>
                                  )
                                </span>
                              ) : (
                                <span className="text-amber-300">
                                  ⚠ Public business email unavailable (not guessed per
                                  policy)
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3">
                              <a
                                href={fc.evidenceSourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="underline text-fg/70 hover:text-fg"
                              >
                                Evidence Source ({fc.sourceDate ?? "current"}) ↗
                              </a>
                              {fc.linkedinUrl && (
                                <a
                                  href={fc.linkedinUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="underline text-fg/70 hover:text-fg"
                                >
                                  LinkedIn ↗
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* PAGE 5: EMAIL OUTREACH */}
              {activeTab === "outreach" && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-xl font-bold">5. Email Outreach (@pip)</h2>
                      <p className="text-xs text-fg/60">
                        Pattern-interrupt, anti-AI-slop founder cold emails grounded in
                        your real resume. Customize any subject line or body before
                        approving.
                      </p>
                    </div>
                    <span className="rounded-full border border-line bg-ink-800 px-3 py-1 font-mono text-xs">
                      {metrics.emailsSentVerified} sent / {metrics.emailsDrafted} drafted
                    </span>
                  </div>

                  {/* Custom Subject Pattern Bar */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5 text-xs">
                    <div className="font-bold flex items-center justify-between">
                      <span>Custom Subject Line Pattern (Apply to All Pending Drafts)</span>
                      <span className="font-mono text-[10px] text-fg/55">
                        Placeholders: {"{name}"}, {"{company}"}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={bulkSubjectInput}
                        onChange={(e) => setBulkSubjectInput(e.target.value)}
                        placeholder="e.g. Legal notice: {company}'s backend is missing me  OR  unsolicited engineering tape for {name}"
                        className="flex-1 min-w-[260px] rounded-xl border border-line bg-ink-800 px-3 py-2 text-xs"
                      />
                      <button
                        onClick={async () => {
                          if (!bulkSubjectInput.trim()) return;
                          const res = await fetch("/api/outreach/draft", {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              bulkSubjectTemplate: bulkSubjectInput.trim(),
                            }),
                          });
                          const json = await res.json();
                          if (json.ok) {
                            showToast(
                              `Updated subject lines on ${json.updatedCount} pending draft(s)`,
                            );
                            await fetchDashboard();
                          }
                        }}
                        className="rounded-xl bg-btn px-3.5 py-2 font-semibold text-btnfg cursor-pointer"
                      >
                        Apply Subject to All
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-0.5 text-[11px]">
                      {[
                        "Legal notice: {company}'s engineering backlog is missing me",
                        "unsolicited engineering tape for {name} ({company})",
                        "don't open this unless {company} needs a cracked engineer",
                        "{name} — 45s pitch on {company}",
                      ].map((preset) => (
                        <button
                          key={preset}
                          onClick={() => setBulkSubjectInput(preset)}
                          className="rounded border border-line bg-ink-800 px-2 py-0.5 font-mono text-[10px] text-fg/75 hover:bg-ink-700 cursor-pointer"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  </div>

                  {!data?.gmailOAuthStatus?.userConnected && (
                    <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <strong>Gmail OAuth 2.0 Not Authenticated:</strong> @pip will stage
                        drafts for your review, but will block sending until you authorize
                        your Gmail account.
                      </span>
                      <a
                        href="/api/auth/google"
                        className="rounded-lg bg-white px-3 py-1 font-bold text-neutral-900"
                      >
                        Authorize Google OAuth2 →
                      </a>
                    </div>
                  )}

                  {data?.emailDrafts.length === 0 ? (
                    <div className="rounded-2xl border border-line bg-ink-900 p-10 text-center text-xs text-fg/60">
                      No email drafts created yet. Run @clover &amp; @pip after onboarding.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {data?.emailDrafts.map((draft) => {
                        const sentRecord = data.emailMessages.find(
                          (m) => m.draftId === draft.id,
                        );
                        const isEditing = editingDraftId === draft.id;
                        return (
                          <div
                            key={draft.id}
                            className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="flex-1">
                                <div className="text-xs font-mono text-fg/60">
                                  To: <strong>{draft.recipientName}</strong> &lt;
                                  {draft.recipientEmail}&gt; · {draft.companyName}
                                </div>
                                {isEditing ? (
                                  <input
                                    type="text"
                                    value={editingSubject}
                                    onChange={(e) => setEditingSubject(e.target.value)}
                                    className="mt-1 w-full rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs font-bold"
                                  />
                                ) : (
                                  <h3 className="text-sm font-bold mt-0.5">
                                    Subject: {draft.subject}
                                  </h3>
                                )}
                              </div>

                              <div className="flex items-center gap-2">
                                <span
                                  className={`rounded-full px-2.5 py-0.5 font-mono text-xs font-bold ${
                                    draft.status === "SENT"
                                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                      : draft.status === "PENDING_APPROVAL"
                                        ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                                        : "bg-ink-800 text-fg/70 border border-line"
                                  }`}
                                >
                                  {draft.status}
                                </span>
                                {draft.status === "PENDING_APPROVAL" && (
                                  <>
                                    {isEditing ? (
                                      <button
                                        onClick={async () => {
                                          await fetch("/api/outreach/draft", {
                                            method: "PATCH",
                                            headers: {
                                              "Content-Type": "application/json",
                                            },
                                            body: JSON.stringify({
                                              draftId: draft.id,
                                              subject: editingSubject,
                                              bodyText: editingBody,
                                            }),
                                          });
                                          setEditingDraftId(null);
                                          showToast("Saved custom subject & body");
                                          await fetchDashboard();
                                        }}
                                        className="rounded-lg bg-btn px-2.5 py-1 text-xs font-semibold text-btnfg cursor-pointer"
                                      >
                                        Save Changes
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => {
                                          setEditingDraftId(draft.id);
                                          setEditingSubject(draft.subject);
                                          setEditingBody(draft.bodyText);
                                        }}
                                        className="rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-xs hover:bg-ink-700 cursor-pointer"
                                      >
                                        Edit Subject/Body
                                      </button>
                                    )}
                                    {draft.approvalId && (
                                      <button
                                        onClick={() =>
                                          handleApprovalDecision(
                                            draft.approvalId!,
                                            "approve",
                                          )
                                        }
                                        className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                                      >
                                        Approve &amp; Send
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>

                            {isEditing ? (
                              <textarea
                                rows={8}
                                value={editingBody}
                                onChange={(e) => setEditingBody(e.target.value)}
                                className="w-full rounded-xl border border-line bg-ink-950 p-3 text-xs font-sans"
                              />
                            ) : (
                              <pre className="rounded-xl border border-line bg-ink-950 p-3 text-xs text-fg/85 whitespace-pre-wrap font-sans leading-relaxed">
                                {draft.bodyText}
                              </pre>
                            )}

                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-fg/55">
                              <span>
                                Gmail Draft ID:{" "}
                                {draft.gmailDraftId ??
                                  "Staged locally (connect Gmail OAuth to sync draft)"}
                              </span>
                              {sentRecord?.gmailMessageId && (
                                <span className="text-emerald-400">
                                  ✓ Sent Gmail Message ID: {sentRecord.gmailMessageId} (
                                  {sentRecord.sentAt
                                    ? new Date(sentRecord.sentAt).toLocaleTimeString()
                                    : ""}
                                  )
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* PAGE 6: MY PROFILE */}
              {activeTab === "profile" && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xl font-bold">6. My Profile &amp; Resume</h2>
                    <p className="text-xs text-fg/60">
                      Structured candidate profile parsed from your resume and synced to
                      local <code className="font-mono">.crawljob/profile.json</code>.
                    </p>
                  </div>

                  {!data?.candidateBundle?.profile ? (
                    <div className="rounded-2xl border border-line bg-ink-900 p-8 text-center space-y-3">
                      <p className="text-xs text-fg/65">
                        Complete the Guided Onboarding Wizard above (or in the
                        #talentloop-job-search Slack panel) to populate your profile.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                          <div>
                            <h3 className="text-base font-bold">
                              {data.candidateBundle.profile.fullName}
                            </h3>
                            <p className="text-xs text-fg/70">
                              {data.candidateBundle.profile.email} ·{" "}
                              {data.candidateBundle.profile.phone ?? "No phone"} ·{" "}
                              {data.candidateBundle.profile.location ?? "Remote"}
                            </p>
                          </div>
                          <span className="rounded-full bg-emerald-500/20 border border-emerald-500/30 px-3 py-1 font-mono text-xs text-emerald-300">
                            Onboarding:{" "}
                            {data.candidateBundle.user?.onboardingCompleted
                              ? "COMPLETED ✓"
                              : data.candidateBundle.user?.onboardingStage}
                          </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                          <div>
                            <div className="text-fg/50 font-mono uppercase text-[10px]">
                              Preferred Roles
                            </div>
                            <div className="font-semibold mt-0.5">
                              {data.candidateBundle.profile.preferredRoles.join(", ")}
                            </div>
                          </div>
                          <div>
                            <div className="text-fg/50 font-mono uppercase text-[10px]">
                              Locations &amp; Work Mode
                            </div>
                            <div className="font-semibold mt-0.5">
                              {data.candidateBundle.profile.preferredLocations.join(", ")}{" "}
                              ({data.candidateBundle.profile.workModePreference})
                            </div>
                          </div>
                          <div>
                            <div className="text-fg/50 font-mono uppercase text-[10px]">
                              Job Types &amp; Experience Level
                            </div>
                            <div className="font-semibold mt-0.5">
                              {data.candidateBundle.profile.preferredJobTypes.join(", ")}{" "}
                              · {data.candidateBundle.profile.experienceLevel}
                            </div>
                          </div>
                          <div>
                            <div className="text-fg/50 font-mono uppercase text-[10px]">
                              Minimum Salary / Stipend
                            </div>
                            <div className="font-semibold mt-0.5">
                              {data.candidateBundle.profile.minSalaryText ??
                                "Not specified"}
                            </div>
                          </div>
                        </div>

                        <div>
                          <div className="text-fg/50 font-mono uppercase text-[10px] mb-1.5">
                            Extracted Skills ({data.candidateBundle.skills.length})
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {data.candidateBundle.skills.map((s) => (
                              <span
                                key={s.id}
                                className="rounded-lg border border-line bg-ink-800 px-2.5 py-1 font-mono text-xs"
                              >
                                {s.name}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="pt-3 border-t border-line flex flex-wrap items-center gap-2">
                          <select
                            value={profileEditField}
                            onChange={(e) => setProfileEditField(e.target.value)}
                            className="rounded-lg border border-line bg-ink-800 px-2.5 py-1.5 text-xs"
                          >
                            <option value="roles">Preferred Roles</option>
                            <option value="skills">Skills</option>
                            <option value="locations">Preferred Locations</option>
                            <option value="salary">Minimum Salary/Stipend</option>
                            <option value="work mode">
                              Work Mode (remote/hybrid/onsite)
                            </option>
                          </select>
                          <input
                            type="text"
                            value={profileEditValue}
                            onChange={(e) => setProfileEditValue(e.target.value)}
                            placeholder="Enter new comma-separated value..."
                            className="flex-1 min-w-[200px] rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs"
                          />
                          <button
                            onClick={() => {
                              if (!profileEditValue.trim()) return;
                              void sendSlackMessageToMilo(
                                `edit ${profileEditField}: ${profileEditValue.trim()}`,
                              );
                              setProfileEditValue("");
                            }}
                            className="rounded-lg bg-btn px-3 py-1.5 text-xs font-semibold text-btnfg cursor-pointer"
                          >
                            Update Profile &amp; Sync crawlJob
                          </button>
                        </div>
                      </div>

                      {/* Synced .crawljob/profile.json Preview */}
                      <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-2">
                        <div className="flex items-center justify-between">
                          <h3 className="text-xs font-mono uppercase tracking-wider text-fg/70">
                            Synced crawlJob Profile JSON (.crawljob/profile.json)
                          </h3>
                          <button
                            onClick={() => handleDeviceAction("sync_profile")}
                            className="rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-xs hover:bg-ink-700 cursor-pointer"
                          >
                            Re-Sync to Disk
                          </button>
                        </div>
                        <pre className="rounded-xl bg-ink-950 p-3.5 font-mono text-[11px] overflow-x-auto text-fg/85">
                          {JSON.stringify(data.crawlJobProfilePreview, null, 2)}
                        </pre>
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* PAGE 7: AGENT TEAM */}
              {activeTab === "agents" && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xl font-bold">
                      7. Agent Team &amp; Switch Coordination
                    </h2>
                    <p className="text-xs text-fg/60">
                      All 6 specialized agents connected over Switch WebSocket protocol in
                      room <code className="font-mono">{data?.switchState?.roomId}</code>.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                    {data?.agents.map((ag) => {
                      const recentTasks = data.tasks
                        .filter(
                          (t) =>
                            t.assignedAgent === ag.id || t.requestingAgent === ag.id,
                        )
                        .slice(0, 2);
                      return (
                        <div
                          key={ag.id}
                          className="rounded-2xl border border-line bg-ink-900 p-4 space-y-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-xs font-bold text-ember">
                                  @{ag.id}
                                </span>
                                <h3 className="text-sm font-bold">{ag.displayName}</h3>
                              </div>
                              <div className="text-[11px] text-fg/65">{ag.roleTitle}</div>
                            </div>
                            <span
                              className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ${
                                ag.status === "BUSY"
                                  ? "bg-amber-500/20 text-amber-300"
                                  : "bg-emerald-500/20 text-emerald-300"
                              }`}
                            >
                              ● {ag.status}
                            </span>
                          </div>

                          <p className="text-xs text-fg/75">{ag.description}</p>

                          <div className="rounded-xl bg-ink-950 p-2.5 font-mono text-[10px] text-fg/60 space-y-0.5">
                            <div>Switch ID: {ag.switchAgentId ?? "Pending"}</div>
                            <div>
                              Connection: {ag.switchConnectionId.slice(0, 18)}... · Gen #
                              {ag.switchGeneration} · Cursor #{ag.switchCursor}
                            </div>
                          </div>

                          {recentTasks.length > 0 && (
                            <div className="space-y-1 pt-1">
                              <div className="text-[10px] font-mono uppercase text-fg/50">
                                Recent Switch Tasks
                              </div>
                              {recentTasks.map((t) => (
                                <div
                                  key={t.taskId}
                                  className="flex items-center justify-between rounded bg-ink-800 px-2.5 py-1 text-[11px] font-mono"
                                >
                                  <span>
                                    {t.taskId} ({t.taskType})
                                  </span>
                                  <span className="text-emerald-400">{t.status}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {/* Live Switch Room Log */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-3">
                    <h3 className="text-sm font-bold">
                      Switch Room Append-Only Log ({data?.switchState?.roomId})
                    </h3>
                    <div className="max-h-[360px] overflow-y-auto space-y-2 font-mono text-xs">
                      {data?.switchState?.transcript.map((m) => (
                        <div
                          key={m.messageId}
                          className="rounded-lg border border-line bg-ink-950 p-2.5 space-y-1"
                        >
                          <div className="flex items-center justify-between text-[10px] text-fg/50">
                            <span>
                              seq #{m.seq} · {m.senderName} ({m.sender})
                            </span>
                            <span>{new Date(m.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className="text-fg/90 whitespace-pre-wrap font-sans text-xs">
                            {m.body.replace(
                              /```switch-task-json[\s\S]*?```/g,
                              "[Structured Switch Task Envelope]",
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* PAGE 8: SETTINGS & LOCAL COMPANION */}
              {activeTab === "settings" && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xl font-bold">
                      8. Settings &amp; Local Execution Companion
                    </h2>
                    <p className="text-xs text-fg/60">
                      Manage Switch Server connection, Local Browser Companion devices for
                      crawlJob, and Gmail OAuth2 authorization.
                    </p>
                  </div>

                  {/* Switch Infrastructure Status */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-2 text-xs">
                    <h3 className="text-sm font-bold">Switch Coordination Server</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 font-mono">
                      <div className="rounded-xl bg-ink-800 p-3">
                        <div className="text-fg/50 text-[10px]">SWITCH BRIDGE URL</div>
                        <div className="font-semibold mt-0.5">
                          {data?.switchState?.serverUrl}
                        </div>
                      </div>
                      <div className="rounded-xl bg-ink-800 p-3">
                        <div className="text-fg/50 text-[10px]">DEDICATED SWITCH ROOM</div>
                        <div className="font-semibold mt-0.5">
                          {data?.switchState?.roomId}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Slack Socket Mode Connection */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold">
                          Slack Workspace Connection (Socket Mode — No ngrok Required)
                        </h3>
                        <p className="text-xs text-fg/60">
                          Connect your Slack workspace using the manifest in{" "}
                          <code className="font-mono">switch/slack-manifest.json</code>{" "}
                          so all 6 agents talk in your real{" "}
                          <code className="font-mono">#talentloop-job-search</code>{" "}
                          Slack channel.
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 font-mono text-xs font-bold ${
                          data?.slackState?.liveConfigured
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        }`}
                      >
                        {data?.slackState?.liveConfigured
                          ? "✓ Slack Connected"
                          : "Local Console Mode (Add Tokens for Live Slack)"}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
                      <input
                        type="password"
                        value={slackBotTokenInput}
                        onChange={(e) => setSlackBotTokenInput(e.target.value)}
                        placeholder="Bot Token (xoxb-...)"
                        className="rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs font-mono"
                      />
                      <input
                        type="password"
                        value={slackAppTokenInput}
                        onChange={(e) => setSlackAppTokenInput(e.target.value)}
                        placeholder="App-Level Token (xapp-...)"
                        className="rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs font-mono"
                      />
                      <input
                        type="text"
                        value={slackChannelIdInput}
                        onChange={(e) => setSlackChannelIdInput(e.target.value)}
                        placeholder="Channel ID (e.g. C07XYZ123)"
                        className="rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs font-mono"
                      />
                    </div>

                    <button
                      onClick={async () => {
                        const res = await fetch("/api/slack/connect", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            botToken: slackBotTokenInput,
                            appToken: slackAppTokenInput,
                            channelId: slackChannelIdInput,
                          }),
                        });
                        const json = await res.json();
                        if (json.ok) {
                          setSlackBotTokenInput("");
                          setSlackAppTokenInput("");
                          showToast("Connected to Slack via Socket Mode!");
                          await fetchDashboard();
                        } else {
                          showToast(`Slack error: ${json.error}`);
                        }
                      }}
                      className="rounded-lg bg-ember px-4 py-1.5 text-xs font-semibold text-white cursor-pointer"
                    >
                      Save &amp; Connect Slack Socket Mode
                    </button>
                  </div>

                  {/* Gmail OAuth2 Integration (@pip) */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-bold">
                          Gmail OAuth 2.0 Authentication (@pip)
                        </h3>
                        <p className="text-xs text-fg/60">
                          @pip cannot send any email without both (1) your explicit
                          Slack/UI approval AND (2) an authenticated Google OAuth2 token.
                        </p>
                      </div>
                      <span
                        className={`rounded-full px-3 py-1 font-mono text-xs font-bold ${
                          data?.gmailOAuthStatus?.userConnected
                            ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                            : "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                        }`}
                      >
                        {data?.gmailOAuthStatus?.userConnected
                          ? `✓ Authenticated (${data.gmailOAuthStatus.gmailEmail})`
                          : "⚠ Not Authenticated (Send Blocked)"}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <a
                        href="/api/auth/gmail"
                        className="rounded-lg bg-btn px-3 py-1.5 text-xs font-semibold text-btnfg hover:opacity-90"
                      >
                        Sign in with Google OAuth 2.0 ↗
                      </a>
                      <input
                        type="password"
                        value={gmailTokenInput}
                        onChange={(e) => setGmailTokenInput(e.target.value)}
                        placeholder="Or paste Google OAuth2 Access Token (ya29...) to verify against Gmail API"
                        className="flex-1 min-w-[260px] rounded-lg border border-line bg-ink-800 px-3 py-1.5 text-xs font-mono"
                      />
                      <button
                        onClick={async () => {
                          if (!gmailTokenInput.trim()) return;
                          const res = await fetch("/api/auth/gmail", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "connect_token",
                              accessToken: gmailTokenInput.trim(),
                            }),
                          });
                          const json = await res.json();
                          if (json.ok) {
                            setGmailTokenInput("");
                            showToast(`Verified Gmail OAuth account: ${json.gmailEmail}`);
                            await fetchDashboard();
                          } else {
                            showToast(json.error);
                          }
                        }}
                        className="rounded-lg bg-ember px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
                      >
                        Verify &amp; Connect Token
                      </button>
                    </div>
                  </div>

                  {/* Local Browser Companion Devices */}
                  <div className="rounded-2xl border border-line bg-ink-900 p-5 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-bold">
                          Local Playwright Companion (crawlJob Runner)
                        </h3>
                        <p className="text-xs text-fg/60">
                          Owns your local{" "}
                          <code className="font-mono">.crawljob/browser-profile-*</code>{" "}
                          session and executes Wellfound (@wally) and Internshala (@inky)
                          in your real browser.
                        </p>
                      </div>
                      <button
                        onClick={() => handleDeviceAction("register")}
                        className="rounded-lg bg-btn px-3 py-1.5 text-xs font-semibold text-btnfg cursor-pointer"
                      >
                        + Register Local Companion
                      </button>
                    </div>

                    {data?.devices.length === 0 ? (
                      <p className="text-xs text-fg/50 py-4">
                        No companion devices registered yet. Complete onboarding and click
                        &ldquo;+ Register Local Companion&rdquo;.
                      </p>
                    ) : (
                      <div className="space-y-2.5">
                        {data?.devices.map((dev) => (
                          <div
                            key={dev.id}
                            className="rounded-xl border border-line bg-ink-800 p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                          >
                            <div className="space-y-1">
                              <div className="font-bold flex items-center gap-2">
                                {dev.deviceName}
                                <span
                                  className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                                    dev.status === "ONLINE"
                                      ? "bg-emerald-500/20 text-emerald-300"
                                      : "bg-amber-500/20 text-amber-300"
                                  }`}
                                >
                                  {dev.status}
                                </span>
                              </div>
                              <div className="font-mono text-[11px] text-fg/65">
                                crawlJob Repo: {dev.crawlJobPath}
                              </div>
                              <div className="font-mono text-[11px] text-fg/65">
                                Synced Profile: {dev.profilePath}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {dev.status === "ONLINE" ? (
                                <button
                                  onClick={() => handleDeviceAction("pause", dev.id)}
                                  className="rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-xs font-semibold hover:bg-ink-600 cursor-pointer"
                                >
                                  Pause Automation
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleDeviceAction("resume", dev.id)}
                                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 cursor-pointer"
                                >
                                  Resume Automation
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </main>

        {/* Right Column: Live Slack #talentloop-job-search Channel Console */}
        <aside className="lg:col-span-3 xl:col-span-3">
          <div className="sticky top-20 rounded-2xl border border-line bg-ink-900 flex flex-col h-[calc(100vh-7rem)]">
            <div className="border-b border-line px-4 py-3 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-bold">
                  <span className="text-ember">#</span>
                  <span>talentloop-job-search</span>
                </div>
                <p className="text-[11px] text-fg/55">
                  Slack ↔ Switch Bridge · Talk to @milo
                </p>
              </div>
              <button
                onClick={() => setShowResumeBox((v) => !v)}
                className="rounded-lg border border-line bg-ink-800 px-2.5 py-1 text-[11px] hover:bg-ink-700 cursor-pointer"
              >
                {showResumeBox ? "Hide Resume Upload" : "📎 Paste/Upload Resume"}
              </button>
            </div>

            {/* Slack Transcript Stream */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-2.5 text-xs">
              {data?.slackState?.outbox.length === 0 ? (
                <div className="text-center text-fg/50 py-10 space-y-2">
                  <p>Say &ldquo;hi @milo&rdquo; below to start Slack onboarding!</p>
                  <button
                    onClick={() => sendSlackMessageToMilo("hi @milo")}
                    className="rounded-lg bg-btn px-3 py-1.5 text-xs font-semibold text-btnfg cursor-pointer"
                  >
                    Send &ldquo;hi @milo&rdquo;
                  </button>
                </div>
              ) : (
                data?.slackState?.outbox.map((msg) => (
                  <div
                    key={msg.id}
                    className="rounded-xl border border-line bg-ink-800 p-3 space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-ember text-[11px]">
                        {msg.agentDisplayName}
                      </span>
                      <span className="font-mono text-[10px] text-fg/45">
                        {new Date(msg.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="text-fg/90 whitespace-pre-wrap leading-relaxed text-[11px]">
                      {msg.text}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Optional Resume Paste / PDF Upload Drawer */}
            {showResumeBox && (
              <div className="border-t border-line bg-ink-950 p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-[11px] font-semibold text-fg/75">
                    Upload PDF or Paste Resume:
                  </label>
                  <label className="rounded border border-line bg-ink-800 px-2 py-1 text-[10px] font-semibold hover:bg-ink-700 cursor-pointer inline-flex items-center gap-1">
                    <i className="ph-fill ph-file-pdf text-ember" />
                    <span>
                      {busyAction === "pdf-parse"
                        ? "Parsing PDF..."
                        : "Choose .PDF / .TXT"}
                    </span>
                    <input
                      type="file"
                      accept=".pdf,application/pdf,.txt,.md,.json"
                      onChange={(e) => handleResumeFileUpload(e, "slack")}
                      className="hidden"
                    />
                  </label>
                </div>
                <textarea
                  rows={4}
                  value={resumeInput}
                  onChange={(e) => setResumeInput(e.target.value)}
                  placeholder="Upload a .pdf file above or paste full resume text (Name, Email, Skills, Experience, Projects, Links)..."
                  className="w-full rounded-lg border border-line bg-ink-900 p-2 text-xs"
                />
              </div>
            )}

            {/* Message Input Bar */}
            <div className="border-t border-line p-3 space-y-2">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={slackInput}
                  onChange={(e) => setSlackInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendSlackMessageToMilo();
                    }
                  }}
                  placeholder="Message @milo (e.g. '1', 'confirm', 'approve all', 'report')..."
                  className="flex-1 rounded-xl border border-line bg-ink-800 px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-ember"
                />
                <button
                  onClick={() => void sendSlackMessageToMilo()}
                  disabled={busyAction !== null}
                  className="rounded-xl bg-ember px-3.5 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 cursor-pointer"
                >
                  Send
                </button>
              </div>
              <div className="flex flex-wrap gap-1 text-[10px]">
                {[
                  "@scout find jobs",
                  "@inky apply",
                  "@wally apply",
                  "@clover research founders",
                  "@pip send emails",
                  "approve all",
                  "report",
                ].map((quick) => (
                  <button
                    key={quick}
                    onClick={() => void sendSlackMessageToMilo(quick)}
                    className="rounded border border-line bg-ink-800 px-2 py-0.5 font-mono text-fg/70 hover:bg-ink-700 cursor-pointer"
                  >
                    {quick}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MetricCard(props: { label: string; value: number; sub: string }) {
  return (
    <div className="rounded-2xl border border-line bg-ink-900 p-4 space-y-1">
      <div className="text-[11px] font-medium text-fg/65">{props.label}</div>
      <div className="text-2xl font-bold font-mono">{props.value}</div>
      <div className="text-[10px] text-fg/50">{props.sub}</div>
    </div>
  );
}
