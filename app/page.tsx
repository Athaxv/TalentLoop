import type { Metadata } from "next";
import TalentLoopDashboard from "@/components/talentloop/TalentLoopDashboard";

export const metadata: Metadata = {
  title: "TalentLoop — Switch-Powered Multi-Agent Job Search Platform",
  description:
    "AI-powered job search, Wellfound & Internshala application automation, startup founder intelligence, and Gmail outreach coordinated over Switch and Slack.",
};

export default function HomePage() {
  return <TalentLoopDashboard />;
}
