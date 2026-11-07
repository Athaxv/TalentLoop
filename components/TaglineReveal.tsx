"use client";

import { useEffect, useRef } from "react";

/** B11 tagline reveal: words activate one at a time as they cross a trigger line. */
export default function TaglineReveal({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const words = text.split(/\s+/);
    el.setAttribute("aria-label", words.join(" "));
    el.innerHTML = words
      .map((w) => `<span class="tw-word" aria-hidden="true">${w}</span>`)
      .join(" ");
    const spans = el.querySelectorAll<HTMLElement>(".tw-word");
    const wio = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("is-lit");
            wio.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -35% 0px", threshold: 1 }
    );
    spans.forEach((w) => wio.observe(w));
    return () => wio.disconnect();
  }, [text]);

  return (
    <h2
      ref={ref}
      className="mx-auto max-w-[680px] text-4xl leading-tight font-bold font-serif italic md:text-5xl"
    >
      {text}
    </h2>
  );
}
