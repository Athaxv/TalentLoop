import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms that apply when you work with Design.",
};

const h2 = "mt-8 text-2xl font-semibold text-fg";
const p = "mt-3 text-base text-fg/70";

export default function TermsPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 pt-40 pb-24">
      <h1 className="text-4xl font-bold md:text-5xl">
        Terms of <em className="font-serif italic font-normal">service</em>
      </h1>
      <p className="mt-2 text-sm text-fg/50">Last updated: 12 October 2026</p>

      <article className="mt-6 text-base text-fg/70">
        <h2 className={h2}>Ownership</h2>
        <p className={p}>
          Your domain, hosting account, site content, and every automation
          account are registered in your name from day one. If you leave,
          everything comes with you.
        </p>

        <h2 className={h2}>Monthly plans</h2>
        <p className={p}>
          Plans bill monthly in advance and can be cancelled any time with 30
          days notice. There are no lock in contracts and no cancellation fees.
        </p>

        <h2 className={h2}>Revisions</h2>
        <p className={p}>
          Unlimited revisions are included while we build. After launch, content
          updates are part of your monthly plan, within reason. We will tell you
          flat out when a request needs a separate quote.
        </p>

        <h2 className={h2}>Results</h2>
        <p className={p}>
          We set written position and lead targets together. If a metric we
          agreed on clearly fails to move after six months of work, discuss it
          with us and we will mutually agree whether to keep working, pause, or
          part ways with any unused fee refunded.
        </p>

        <h2 className={h2}>Payments</h2>
        <p className={p}>
          Invoices are due within 14 days. Work pauses on accounts more than 21
          days overdue, never more, and we email you before that happens.
        </p>
      </article>
    </main>
  );
}
