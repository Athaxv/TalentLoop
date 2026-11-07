import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import SiteNav from "@/components/SiteNav";
import SiteFooter from "@/components/SiteFooter";
import CookieNotice from "@/components/CookieNotice";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "TalentLoop | Switch-Powered Multi-Agent Job Search Platform",
    template: "%s | TalentLoop",
  },
  description:
    "TalentLoop coordinates six specialized AI agents (@milo, @wally, @inky, @scout, @clover, @pip) across Switch and Slack to automate job discovery, applications, and founder outreach.",
  openGraph: {
    title: "TalentLoop | Switch Multi-Agent Job Search Platform",
    description:
      "Coordinate your AI job search team in Slack and Switch.",
    type: "website",
    images: [{ url: "/og.svg" }],
  },
  twitter: {
    card: "summary_large_image",
  },
};

const phosphorStyles = [
  { rel: "stylesheet", href: "https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" },
  { rel: "stylesheet", href: "https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css" },
];

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var t=localStorage.getItem('theme');if(t==='light')document.documentElement.classList.add('light')}catch(e){}",
          }}
        />
        {phosphorStyles.map((s) => (
          <link key={s.href} rel={s.rel} href={s.href} />
        ))}
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable} bg-ink-950 font-sans text-fg antialiased`}
      >
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-70 focus:rounded-full focus:bg-btn focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-btnfg"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
