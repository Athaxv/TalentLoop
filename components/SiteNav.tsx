"use client";

import { useEffect, useRef, useState } from "react";
import ThemeToggle from "./ThemeToggle";

const links = [
  { href: "/#services", label: "Services" },
  { href: "/#process", label: "Process" },
  { href: "/#results", label: "Results" },
  { href: "/#faq", label: "FAQ" },
];

const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";

export default function SiteNav() {
  const [open, setOpen] = useState(false);
  const [compact, setCompact] = useState(false);
  const [hidden, setHidden] = useState(false);
  const burgerRef = useRef<HTMLSpanElement>(null);
  const yRef = useRef(0);

  /* Hamburger morph */
  useEffect(() => {
    const lines = burgerRef.current?.querySelectorAll<HTMLElement>(".burger-line");
    lines?.forEach((l, i) => {
      const closedTop = i === 0 ? "-4px" : "4px";
      l.style.top = open ? "-1px" : closedTop;
      l.style.transform = open ? `rotate(${i === 0 ? 45 : -45}deg)` : "rotate(0deg)";
    });
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  /* Collapse on scroll down, compact bar returns on scroll up (rAF-throttled) */
  useEffect(() => {
    let ticking = false;
    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const dy = y - yRef.current;
      if (y <= 80) {
        setCompact(false);
        setHidden(false);
      } else {
        setCompact(true);
        if (dy > 6) setHidden(true);
        else if (dy < -6) setHidden(false);
      }
      yRef.current = y;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      <nav
        aria-label="Main"
        className={`fixed inset-x-0 top-0 z-50 flex justify-between items-center px-6 md:px-36 transition-all ${fluid} ${
          compact ? "py-2 backdrop-blur-md" : "py-4"
        } ${hidden ? "-translate-y-[130%] pointer-events-none opacity-0" : "translate-y-0 opacity-100"}`}
      >
        <a
          href="/#top"
          aria-label="Design, home"
          className="flex items-center gap-2 active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 rounded-full"
        >
          <span className={`grid place-items-center rounded-full bg-btn font-bold text-btnfg transition-all ${fluid} ${compact ? "h-7 w-7 text-xs" : "h-8 w-8 text-sm"}`}>
            D
          </span>
          <span className={`font-bold transition-all ${fluid} ${compact ? "text-sm" : "text-base"}`}>
            Design
          </span>
        </a>

        <div className="flex items-center gap-2">
          <a
            href="/#contact"
            className={`hidden items-center rounded-full bg-btn font-semibold text-btnfg transition-all hover:scale-[1.03] active:scale-[0.98] sm:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid} ${
              compact ? "py-1.5 px-2.5 text-xs" : "py-2 px-3 text-sm"
            }`}
          >
            Book a call
          </a>

          <button
            id="burger"
            aria-expanded={open}
            aria-controls="menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
            className={`relative grid place-items-center rounded-full hover:bg-hover active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid} ${
              compact ? "h-9 w-9" : "h-10 w-10"
            }`}
          >
            <span className="relative block h-[2px] w-5 bg-transparent" ref={burgerRef}>
              <span className="burger-line" />
              <span className="burger-line" />
            </span>
          </button>

          <ThemeToggle />
        </div>
      </nav>

      {/* Fullscreen menu overlay */}
      <div
        id="menu"
        role="dialog"
        aria-modal="true"
        aria-label="Site menu"
        aria-hidden={!open}
        className={`fixed inset-0 z-60 flex items-center backdrop-blur-3xl bg-overlay transition-opacity ${fluid} ${
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <div className="w-full px-10">
          {links.map(({ href, label }, i) => (
            <a
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              style={{ transitionDelay: open ? `${0.1 + i * 0.05}s` : "0s" }}
              className={`block py-3 text-5xl font-bold transition-[transform,opacity] hover:text-fg/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid} ${
                open ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
              }`}
            >
              {label}
            </a>
          ))}
          <a
            href="/#contact"
            onClick={() => setOpen(false)}
            className="mt-6 inline-flex items-center rounded-full bg-btn py-2 px-3 text-base font-semibold text-btnfg"
          >
            Book a call
          </a>
        </div>
      </div>
    </>
  );
}
