import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How Design collects, uses, and protects information on this website.",
};

const h2 = "mt-8 text-2xl font-semibold text-fg";
const p = "mt-3 text-base text-fg/70";

export default function PrivacyPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-6 pt-40 pb-24">
      <h1 className="text-4xl font-bold md:text-5xl">
        Privacy <em className="font-serif italic font-normal">policy</em>
      </h1>
      <p className="mt-2 text-sm text-fg/50">Last updated: 12 October 2026</p>

      <article className="mt-6 text-base text-fg/70">
        <h2 className={h2}>What we collect</h2>
        <p className={p}>
          When you submit the booking form we store the name, email, and website
          you provide so we can reply. We use one analytics cookie to count page
          visits. No advertising trackers, nothing sold or shared.
        </p>

        <h2 className={h2}>How we use it</h2>
        <p className={p}>
          Contact details are used only to answer your enquiry and schedule your
          call. Analytics data is used only to see which pages are useful. Both
          live on systems we control, with access limited to the two founders.
        </p>

        <h2 className={h2}>Your choices</h2>
        <p className={p}>
          Ask us to delete or export anything we hold about you at any time.
          Write to{" "}
          <a href="mailto:hello@design.studio" className="rounded underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50">
            hello@design.studio
          </a>{" "}
          and we action it within five business days.
        </p>

        <h2 className={h2}>How long we keep data</h2>
        <p className={p}>
          Enquiries are kept for 24 months after our last contact, then deleted
          automatically. Analytics data is anonymised after 14 months.
        </p>
      </article>
    </main>
  );
}
