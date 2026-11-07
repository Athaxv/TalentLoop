import Link from "next/link";
import NightFreightLive from "./iso/NightFreightLive";
import { NIGHT_FREIGHT_SVG } from "./iso/night-freight-art";

const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";
const link =
  `rounded transition-all hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`;

export default function SiteFooter() {
  return (
    <footer className="border-t border-line">
      {/* Night freight — the site's promise as a machine: the systems keep
          working while you sleep. Server-rendered art, one client island. */}
      <section aria-label="Night freight, a live figure" className="px-6 pt-14">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-baseline justify-between gap-4 font-mono text-[11px] uppercase tracking-[0.1em] text-fg/40">
            <span>Fig 7 · Night freight</span>
            <span className="hidden sm:inline">Pointer or ←/→ sets the throttle</span>
          </div>
          <div
            className="nf-stage mt-3 cursor-ew-resize rounded-2xl border border-line bg-ink-800 px-3 py-2 outline-none transition-shadow duration-700 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:ring-2 focus-visible:ring-ember/60 sm:px-5"
            tabIndex={0}
            role="slider"
            aria-label="Night freight: pointer or arrow keys set the throttle"
            aria-valuemin={6}
            aria-valuemax={100}
            aria-valuenow={62}
          >
            <div dangerouslySetInnerHTML={{ __html: NIGHT_FREIGHT_SVG }} />
          </div>
          <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-baseline md:justify-between">
            <p className="max-w-xl text-sm leading-relaxed text-fg/50">
              The drivers roll without slip: one turn of a wheel advances the train by
              its own circumference, the coupling rod holds both cranks in phase, and
              each quarter turn fires one exhaust beat — the quiet clockwork that keeps
              working while you sleep.
            </p>
            <p
              data-readout
              className="shrink-0 font-mono text-xs tabular-nums text-fg/40"
            >
              standing at signal · 0 px/s · wheels 0.00 Hz
            </p>
          </div>
        </div>
      </section>
      <NightFreightLive />

      <div className="flex flex-col items-start justify-between gap-8 px-6 pb-12 pt-12 md:flex-row md:items-center mx-auto max-w-5xl">
        <div>
          <Link href="/" className="flex items-center gap-2" aria-label="Design, back to top">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-btn text-sm font-bold text-btnfg">D</span>
            <span className="text-base font-semibold">Design</span>
          </Link>
          <p className="mt-3 text-sm text-fg/50">
            Websites, SEO, marketing, and AI automation for growing businesses.
          </p>
          <address className="mt-3 text-sm text-fg/50 not-italic">
            <a href="mailto:hello@design.studio" className={link}>hello@design.studio</a>
            <br />
            <a href="tel:+13128471904" className={link}>+1 (312) 847-1904</a>
          </address>
        </div>
        <nav aria-label="Footer" className="flex flex-col items-start gap-2 text-sm text-fg/60 md:items-end">
          <Link href="/#services" className={link}>Services</Link>
          <Link href="/#process" className={link}>Process</Link>
          <Link href="/#faq" className={link}>FAQ</Link>
        </nav>
        <nav aria-label="Legal" className="flex flex-col items-start gap-2 text-sm text-fg/60 md:items-end">
          <Link href="/privacy" className={link}>Privacy policy</Link>
          <Link href="/terms" className={link}>Terms of service</Link>
        </nav>
      </div>
      <p className="mx-auto max-w-5xl px-6 pb-10 text-xs text-fg/40">
        © 2026 Design. All rights reserved.
      </p>
    </footer>
  );
}
