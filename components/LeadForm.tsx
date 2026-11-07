"use client";

import { useState, type FormEvent } from "react";

const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";
const field =
  "w-full rounded-lg bg-ink-950 border border-line py-2 px-3 text-base placeholder:text-fg/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 transition-all";

export default function LeadForm() {
  const [status, setStatus] = useState<"idle" | "sending" | "sent">("idle");
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});

  function onSubmit(ev: FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    const form = ev.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const email = String(data.get("email") ?? "").trim();

    const next: typeof errors = {};
    if (name.length < 2) next.name = "Please tell us your name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      next.email = "That email does not look right. Check it and try again.";
    setErrors(next);
    if (next.name || next.email) return;

    setStatus("sending");
    setTimeout(() => {
      setStatus("sent");
    }, 1400);
  }

  if (status === "sent") {
    return (
      <div
        role="status"
        className={`reveal is-in mt-10 max-w-xl mx-auto rounded-2xl border border-line bg-ink-800 p-6 text-left`}
      >
        <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-ink-950">
          <i className="ph ph-check text-2xl" aria-hidden="true" />
        </span>
        <h3 className="text-center text-2xl font-semibold">Request received</h3>
        <p className="mt-2 text-center text-base text-fg/70">
          We will reply within one business day with two call slots.
        </p>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      className="reveal is-in mt-10 max-w-xl mx-auto space-y-4 rounded-2xl border border-line bg-ink-800 p-6 text-left"
    >
      <div>
        <label htmlFor="name" className="mb-1 block text-sm font-semibold">
          Your name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          autoComplete="name"
          placeholder="Jordan Reyes"
          aria-invalid={!!errors.name}
          className={`${field} ${errors.name ? "border-red-400" : ""}`}
        />
        <p className={`mt-1 text-sm text-red-400 ${errors.name ? "" : "hidden"}`}>
          {errors.name ?? "Please tell us your name."}
        </p>
      </div>

      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-semibold">
          Work email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          placeholder="you@company.com"
          aria-invalid={!!errors.email}
          className={`${field} ${errors.email ? "border-red-400" : ""}`}
        />
        <p className={`mt-1 text-sm text-red-400 ${errors.email ? "" : "hidden"}`}>
          {errors.email ?? "That email does not look right. Check it and try again."}
        </p>
      </div>

      <div>
        <label htmlFor="site" className="mb-1 block text-sm font-semibold">
          Current website, optional
        </label>
        <input
          id="site"
          name="site"
          type="text"
          inputMode="url"
          placeholder="company.com"
          className={field}
        />
      </div>

      <button
        type="submit"
        disabled={status === "sending"}
        className={`w-full inline-flex items-center justify-center rounded-full bg-btn py-2 px-3 text-base font-semibold text-btnfg transition-all hover:scale-[1.02] active:scale-[0.98] disabled:cursor-wait disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`}
      >
        {status === "sending" ? "Sending your request" : "Book your free growth call"}
      </button>
      <p className="text-center text-xs text-fg/40">
        We reply within one business day. No spam, ever.
      </p>
    </form>
  );
}
