"use client";

import { useEffect, useState } from "react";

export default function CookieNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem("cookie-choice")) {
      const t = setTimeout(() => setShow(true), 1500);
      return () => clearTimeout(t);
    }
  }, []);

  function choose(value: "accept" | "decline") {
    localStorage.setItem("cookie-choice", value);
    setShow(false);
  }

  const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";

  return (
    <div
      role="dialog"
      aria-label="Cookie notice"
      className={`fixed bottom-4 left-4 z-50 max-w-xs rounded-2xl border border-line bg-ink-800 p-4 backdrop-blur-xl transition-opacity ${fluid} ${
        show ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <p className="text-sm text-fg/70">
        We use a single analytics cookie to see which pages help. Nothing is sold
        or shared.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => choose("accept")}
          className={`rounded-full bg-btn py-2 px-3 text-sm font-semibold text-btnfg active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`}
        >
          Accept
        </button>
        <button
          onClick={() => choose("decline")}
          className={`rounded-full border border-line py-2 px-3 text-sm font-semibold hover:bg-hover active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`}
        >
          No thanks
        </button>
      </div>
    </div>
  );
}
