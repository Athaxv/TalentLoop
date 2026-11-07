"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Liquid amber flow: domain warped fbm in the brand palette.
 * Black #000000 base, #131209 amber wash, warm white highlights,
 * soft glow that follows the pointer, darker vignette at the edges
 * so it blends into the hero card border.
 */
const fragmentShader = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform float uTime;
uniform vec2 uRes;
uniform vec2 uMouse;
uniform float uMouseStrength;
uniform float uLight;
uniform float uPixelRatio;

/* Recursive Bayer matrix, ordered dithering */
float bayer2(vec2 a) {
  a = floor(a);
  return fract(dot(a, vec2(0.5, a.y * 0.75)));
}
float bayer4(vec2 a) {
  return bayer2(0.5 * a) * 0.25 + bayer2(a);
}
float bayer8(vec2 a) {
  return bayer4(0.5 * a) * 0.25 + bayer2(a);
}

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = m * p;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  float t = uTime * 0.12;

  vec2 p = uv * vec2(aspect, 1.0) * 1.4;

  float q = fbm(p + t);
  float r = fbm(p * 1.6 + q * 1.8 + t * 0.8 + vec2(5.2, 1.3));
  float s = fbm(p * 1.1 + r * 1.4 - t * 0.5 + vec2(1.7, 9.2));

  float silk = smoothstep(0.45, 0.85, r) * smoothstep(0.25, 0.7, s);
  float core = smoothstep(0.55, 1.05, fbm(p * 0.9 + vec2(t * 1.5, 0.0) + q));

  /* Dark theme: red-black base, oxblood wash, hot red silk */
  vec3 darkC = vec3(0.0);
  darkC += vec3(0.24, 0.035, 0.045) * (0.35 + r * 1.5);
  darkC += vec3(1.0, 0.45, 0.35) * silk * 0.32;
  darkC += vec3(1.0, 0.85, 0.80) * core * 0.12;

  /* Light theme: warm paper base, cool gray shading, amber silk */
  vec3 liteC = vec3(0.982, 0.979, 0.971);
  liteC -= vec3(0.16, 0.15, 0.11) * r * 0.9;
  liteC += vec3(0.97, 0.82, 0.68) * silk * 0.22;
  liteC += vec3(1.0, 0.97, 0.90) * core * 0.15;
  liteC -= vec3(0.30, 0.27, 0.18) * core * 0.08;

  vec3 col = mix(darkC, liteC, uLight);

  /* Pointer glow: warm light on dark, soft warm shadow on light */
  float md = length((uv - uMouse) * vec2(aspect, 1.0));
  vec3 glowDark = vec3(1.0, 0.55, 0.45) * exp(-md * 7.0) * 0.22 * uMouseStrength;
  vec3 glowLite = -vec3(0.30, 0.27, 0.18) * exp(-md * 7.0) * 0.14 * uMouseStrength;
  col += mix(glowDark, glowLite, uLight);

  /* Edge vignette, softer on light */
  vec2 d = uv - 0.5;
  d.x *= aspect;
  col *= 1.0 - smoothstep(0.35, 0.95, length(d)) * (0.85 - 0.45 * uLight);

  /* Ordered dithering into ~10 tone levels, halftone texture */
  float levels = 10.0;
  float dth = bayer8(gl_FragCoord.xy / uPixelRatio) - 0.5;
  col += dth / levels;
  col = clamp(floor(col * levels) / levels, 0.0, 1.0);

  gl_FragColor = vec4(col, 1.0);
}
`;

export default function HeroShader() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const hero = mount.parentElement;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const geometry = new THREE.PlaneGeometry(2, 2);

    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    const uniforms = {
      uTime: { value: 4.2 },
      uRes: { value: new THREE.Vector2(1, 1) },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uMouseStrength: { value: 0 },
      uLight: { value: document.documentElement.classList.contains("light") ? 1 : 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
    };

    /* Follow theme toggles live */
    const themeObserver = new MutationObserver(() => {
      uniforms.uLight.value = document.documentElement.classList.contains("light")
        ? 1
        : 0;
      if (reduceMotion) renderer.render(scene, camera);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms,
    });
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    function resize() {
      const w = mount!.clientWidth || 1;
      const h = mount!.clientHeight || 1;
      renderer.setSize(w, h, false);
      uniforms.uRes.value.set(w, h);
      if (reduceMotion) renderer.render(scene, camera);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount!);

    /* Pause when the hero is off screen or the tab is hidden. */
    let running = false;
    let raf = 0;
    let last = performance.now();

    function loop() {
      if (!running) return;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      uniforms.uTime.value += dt;
      const m = uniforms.uMouse.value;
      const target = mouseTarget;
      m.x += (target.x - m.x) * 0.06;
      m.y += (target.y - m.y) * 0.06;
      const s = uniforms.uMouseStrength;
      s.value += (strengthTarget - s.value) * 0.05;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(loop);
    }

    const io = new IntersectionObserver((entries) => {
      const visible = entries.some((e) => e.isIntersecting);
      const shouldRun = visible && !document.hidden && !reduceMotion;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    });
    io.observe(mount!);

    const onVisibility = () => {
      const shouldRun = !document.hidden && !reduceMotion && heroVisible;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(loop);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(raf);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    /* Pointer influence: light follows the cursor, gentle decay on leave. */
    let mouseTarget = { x: 0.5, y: 0.5 };
    let strengthTarget = 0;
    let heroVisible = true;
    const onPointerMove = (e: PointerEvent) => {
      if (!hero) return;
      const rect = mount!.getBoundingClientRect();
      mouseTarget = {
        x: (e.clientX - rect.left) / rect.width,
        y: 1 - (e.clientY - rect.top) / rect.height,
      };
      strengthTarget = 1;
      heroVisible = true;
    };
    const onPointerLeave = () => {
      strengthTarget = 0;
    };
    hero?.addEventListener("pointermove", onPointerMove);
    hero?.addEventListener("pointerleave", onPointerLeave);

    if (reduceMotion) renderer.render(scene, camera);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      hero?.removeEventListener("pointermove", onPointerMove);
      hero?.removeEventListener("pointerleave", onPointerLeave);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      mouseTarget = { x: 0.5, y: 0.5 };
    };
  }, []);

  return (
    <div
      ref={mountRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
    />
  );
}
