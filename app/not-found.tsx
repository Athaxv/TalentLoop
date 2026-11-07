import Link from "next/link";

const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";

export default function NotFound() {
  return (
    <main id="main" className="grid min-h-screen place-items-center px-6 text-center">
      <div className="max-w-[680px]">
        <span className="mx-auto mb-8 grid h-14 w-14 place-items-center rounded-full bg-btn text-xl font-bold text-btnfg">D</span>
        <h1 className="font-serif italic text-6xl md:text-7xl">404</h1>
        <p className="mt-4 text-lg text-fg/70">
          This page moved or never existed. The rest of the site is right where
          you left it.
        </p>
        <Link
          href="/"
          className={`mt-8 inline-flex items-center justify-center rounded-full bg-btn py-2 px-3 text-base font-semibold text-btnfg active:scale-[0.98] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`}
        >
          Back to the home page
        </Link>
      </div>
    </main>
  );
}
