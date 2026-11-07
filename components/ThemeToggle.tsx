"use client";

import { useEffect, useState } from "react";

const fluid = "ease-[cubic-bezier(0.32,0.72,0,1)] duration-700";

export default function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.classList.contains("light"));
  }, []);

  function toggle() {
    const next = !light;
    const root = document.documentElement;
    root.classList.add("theme-switching");
    root.classList.toggle("light", next);
    try {
      localStorage.setItem("theme", next ? "light" : "dark");
    } catch {}
    window.setTimeout(() => root.classList.remove("theme-switching"), 700);
    setLight(next);
  }

  return (
    <button
      onClick={toggle}
      aria-label={light ? "Switch to dark mode" : "Switch to light mode"}
      className={`grid h-10 w-10 place-items-center rounded-full hover:bg-hover active:scale-95 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fg/50 ${fluid}`}
    >
      <i
        className={light ? "ph ph-moon text-xl" : "ph ph-sun text-xl"}
        aria-hidden="true"
      />
    </button>
  );
}
