"use client";

import { useEffect } from "react";
import { iso, pathOf, translateAlong, type Projection, type Vec2, type Vec3 } from "./iso-kit-lite";

// Truth numbers shared with the generated art (see _iso-train/build.mjs):
//   phi = odo / WHEEL_R   — wheels roll without slipping
//   one exhaust puff per quarter turn of the drivers
//   the controller brakes with b = v^2 / (2 * BRAKE) so the train stops at the signal
const P: Projection = {
  origin: [374.21207786115406, 182.83774424681633],
  scale: 1.047648473564403,
  azimuth: 40,
  elevation: 30,
};
const WHEEL_R = 11;
const CRANK = 4.5;
const AXZ = 41.5;
const DRIVERS = [68, 30];
const SPAWN = -390; // front line of the train when it enters from the left
const EXIT = 406; // rear line when it leaves to the right
const CRUISE = 46,
  VMAX = 70,
  ACCEL = 42,
  BRAKE = 96,
  DWELL = 8.5,
  QUIET = 4.5,
  BEAT = Math.PI / 2;
const PHI0 = 0.9;

type Mode = "arrive" | "dwell" | "drive" | "run" | "quiet";
type Wisp = { x: number; t: number; big: boolean };

// Ellipse templates (unit rings in the horizontal / vertical xz planes).
function ringTemplate(plane: "h" | "v"): string {
  const o = iso([0, 0, 0], P);
  const pts: Vec2[] = [];
  const N = 36;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const p: Vec3 = plane === "h" ? [Math.cos(t), Math.sin(t), 0] : [Math.cos(t), 0, Math.sin(t)];
    const s = iso(p, P);
    pts.push([s[0] - o[0], s[1] - o[1]]);
  }
  return pathOf(pts, true);
}
const H_RING = ringTemplate("h");
const V_RING_SHAPE = ringTemplate("v");

// Renders nothing: binds the loop to the server-rendered figure in the footer.
export default function NightFreightLive() {
  useEffect(() => {
    const stage = document.querySelector<HTMLElement>(".nf-stage");
    const svg = stage?.querySelector<SVGSVGElement>("svg");
    const readout = document.querySelector<HTMLElement>("[data-readout]");
    if (!stage || !svg || !readout) return;

    const train = svg.querySelector<SVGGElement>('[data-part="train"]');
    const rod = svg.querySelector<SVGGElement>('[data-part="rod"]');
    const pins = svg.querySelector<SVGGElement>('[data-part="pins"]');
    const smoke = svg.querySelector<SVGGElement>('[data-part="smoke"]');
    const spokePaths = DRIVERS.map((ax) =>
      svg.querySelector<SVGPathElement>(`[data-part="spokes-${ax}"]`),
    );
    if (!train || !rod || !pins || !smoke || spokePaths.some((p) => !p)) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");

    // boot pose: the hero shot — the freight is standing at the signal, centred,
    // and the exhaust column is already running. First travel begins after a beat.
    let x = 0,
      v = 0,
      odo = PHI0 * WHEEL_R,
      throttle = 0.62;
    let mode: Mode = "dwell",
      timer = 3.2,
      visible = false;
    let wisps: Wisp[] = [
      { x: 140, t: 0.9, big: false },
      { x: 140, t: 1.8, big: false },
      { x: 140, t: 2.5, big: false },
    ];
    let last = 0,
      frame = 0,
      lastBeat = Math.floor(odo / BEAT),
      idleWisp = 0.4;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const labelOf = (m: Mode) =>
      m === "arrive"
        ? "arriving"
        : m === "dwell"
          ? "standing at signal"
          : m === "drive"
            ? "under throttle"
            : m === "run"
              ? "departing"
              : "section clear";

    const fogNode = (wx: number, z: number, r: number, a: number) => {
      const o = iso([0, 13, 0], P);
      const p = iso([wx, 13, z], P);
      return (
        `<g opacity="${a.toFixed(2)}">` +
        `<g transform="translate(${(p[0] - o[0]).toFixed(1)} ${(p[1] - o[1]).toFixed(1)})scale(${r.toFixed(2)})">${H_RING}</g>` +
        `<g transform="translate(${(p[0] - o[0]).toFixed(1)} ${(p[1] - o[1] + 2.4).toFixed(1)})scale(${(r * 0.58).toFixed(2)})">${H_RING}</g>` +
        `</g>`
      );
    };

    const spawnPuff = (big: boolean) => {
      wisps.push({ x: x + 140, t: 0, big });
      if (wisps.length > 7) wisps.shift();
    };

    const drawSmoke = (dt: number) => {
      let html = "";
      for (const p of wisps) {
        p.t += dt;
        const life = p.big ? 2.6 : 2.2;
        if (p.t > life) continue;
        const grow = 1 - Math.exp(-p.t / 0.55);
        const z = 86 + (p.big ? 58 : 28) * grow;
        const r = (p.big ? 5 : 2.8) * (1 + grow * (p.big ? 1.5 : 0.9));
        const a = (p.big ? 0.85 : 0.4) * (1 - p.t / life);
        if (a > 0.03) html += fogNode(p.x, z, r, a);
      }
      wisps = wisps.filter((p) => p.t <= (p.big ? 2.6 : 2.2));
      if (smoke.innerHTML !== html) smoke.innerHTML = html;
    };

    const spokesD = (ax: number, phi: number) => {
      const HUB = 1.8,
        TIP = 9.1;
      let d = "";
      for (let i = 0; i < 6; i++) {
        const t = phi + (i * Math.PI) / 3;
        d += pathOf([
          iso([ax + HUB * Math.cos(t), 24, AXZ - HUB * Math.sin(t)], P),
          iso([ax + TIP * Math.cos(t), 24, AXZ - TIP * Math.sin(t)], P),
        ]);
      }
      return d;
    };

    const pinsD = (phi: number) => {
      let out = "";
      for (const ax of DRIVERS) {
        const p = iso([ax + CRANK * Math.cos(phi), 31, AXZ - CRANK * Math.sin(phi)], P);
        out +=
          `<g transform="translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})scale(2.05)">` +
          `<path class="iso-line" data-tone="hi" d="${V_RING_SHAPE}"/></g>` +
          `<circle class="iso-dot" data-tone="hi" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="0.75"/>`;
      }
      return out;
    };

    const draw = () => {
      const phi = odo / WHEEL_R;
      const dx = CRANK * Math.cos(phi);
      const dz = -CRANK * Math.sin(phi);
      train.setAttribute("transform", translateAlong(P, [x, 0, 0]));
      rod.setAttribute("transform", translateAlong(P, [dx, 0, dz]));
      spokePaths.forEach((el, i) => el?.setAttribute("d", spokesD(DRIVERS[i], phi)));
      pins.innerHTML = pinsD(phi);
      const text =
        labelOf(mode) +
        " · " +
        Math.round(v) +
        " px/s · wheels " +
        (v / WHEEL_R / (2 * Math.PI)).toFixed(2) +
        " Hz";
      if (readout.textContent !== text) readout.textContent = text;
      stage.setAttribute("aria-valuenow", String(Math.round(throttle * 100)));
      stage.setAttribute("aria-valuetext", text);
    };

    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      const target = throttle * VMAX;
      if (mode === "arrive") {
        if (x >= -(v * v) / (2 * BRAKE)) v = Math.max(0, v - BRAKE * dt);
        else v = Math.min(CRUISE, v + ACCEL * dt);
        x += v * dt;
        odo += v * dt;
        if (Math.abs(x) < 2 && v < 4) {
          x = 0;
          v = 0;
          mode = "dwell";
          timer = DWELL;
        }
      } else if (mode === "dwell") {
        v = 0;
        timer -= dt;
        if (timer <= 0) mode = "run";
        idleWisp -= dt;
        if (idleWisp <= 0) {
          idleWisp = 2.6;
          spawnPuff(false);
        }
      } else if (mode === "run") {
        v = Math.min(CRUISE, v + ACCEL * dt);
        x += v * dt;
        odo += v * dt;
        if (x > EXIT) {
          mode = "quiet";
          timer = QUIET;
        }
      } else if (mode === "drive") {
        if (v < target) v = Math.min(target, v + ACCEL * dt);
        else v = Math.max(target, v - BRAKE * dt);
        x += v * dt;
        odo += v * dt;
        if (x > EXIT) {
          mode = "quiet";
          timer = QUIET;
        }
      } else {
        // quiet
        v = 0;
        timer -= dt;
        if (timer <= 0) {
          mode = "arrive";
          x = SPAWN;
          v = 42;
          lastBeat = Math.floor(odo / BEAT);
        }
      }
      const beat = Math.floor(odo / BEAT);
      if (beat > lastBeat && v > 1) spawnPuff(true);
      if (beat !== lastBeat) lastBeat = beat;
      draw();
      drawSmoke(dt);
      frame = visible && !still.matches ? requestAnimationFrame(tick) : 0;
    };

    const run = () => {
      if (!frame && visible && !still.matches) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    const steer = (next: number) => {
      throttle = Math.max(0.06, Math.min(1, next));
      mode = "drive";
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (mode === "drive") {
          mode = "run";
          run();
        }
      }, 3600);
      run();
    };

    const onMove = (event: PointerEvent) => {
      const box = svg.getBoundingClientRect();
      steer(((event.clientX - box.left) / box.width - 0.12) / 0.76);
    };
    const onLeave = () => steer(throttle);
    const onKey = (event: KeyboardEvent) => {
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(1, throttle + 0.1);
      if (event.key === "ArrowLeft" || event.key === "ArrowDown")
        next = Math.max(0.06, throttle - 0.1);
      if (event.key === "Home") next = 0.3;
      if (event.key === "End") next = 1;
      if (next === null) return;
      event.preventDefault();
      steer(next);
    };

    const calmPose = () => {
      // reduced motion: one settled pose, everything frozen
      x = 0;
      v = 0;
      odo = PHI0 * WHEEL_R;
      throttle = 0;
      draw();
      readout.textContent = "still frame · standing at signal · 0 px/s";
    };

    const observer = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) run();
      },
      { rootMargin: "120px 0px" },
    );
    observer.observe(stage);

    const onStillChange = () => {
      if (still.matches) {
        cancelAnimationFrame(frame);
        frame = 0;
        calmPose();
      } else {
        run();
      }
    };
    still.addEventListener("change", onStillChange);

    if (still.matches) {
      calmPose();
    } else {
      stage.addEventListener("pointermove", onMove);
      stage.addEventListener("pointerleave", onLeave);
      stage.addEventListener("keydown", onKey);
      draw();
      drawSmoke(1 / 60);
    }

    return () => {
      observer.disconnect();
      still.removeEventListener("change", onStillChange);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerleave", onLeave);
      stage.removeEventListener("keydown", onKey);
      clearTimeout(idleTimer);
      cancelAnimationFrame(frame);
      frame = 0;
    };
  }, []);

  return null;
}
