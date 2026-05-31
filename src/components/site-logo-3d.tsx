"use client";

/**
 * 3D version of <SiteLogo> for the masthead.
 *
 * The same C-mark + corner triangles, painted onto a sphere whose skin
 * is sampled from `--color-surface`, so the ball blends into the header
 * background. Interactive:
 *
 *  - Idle (desktop): the sphere softly tracks the mouse cursor.
 *  - Click-and-drag: rotates with the pointer.
 *  - Flick & release: spins freely with momentum (averaged over the
 *    last 80ms of motion). Emissive glows in brand accent while spinning
 *    fast and fades back as the spin decays.
 *
 * Mobile / accessibility:
 *  - Lower DPR on coarse pointers (huge battery win on phones).
 *  - `frameloop="demand"` everywhere: zero GPU when idle, the loop
 *    self-invalidates while there is something to animate.
 *  - Skips the mouse-tracking on touch devices (no cursor concept).
 *  - Respects `prefers-reduced-motion`: drag/flick still works, but
 *    auto-tracking and idle motion are disabled.
 *  - Regenerates the texture when the `.dark` class toggles on <html>.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

// ── Tuning ───────────────────────────────────────────────────────────
const T = {
  cameraZ: 2.4,
  fov: 38,
  meshScale: 0.82,
  texSize: 1024,
  inner: 0.7, // logo packed in the centre 70% of the texture

  // Pointer → rotation
  dragSensitivity: 0.015,
  flickMultiplier: 35, // px/ms → rad/s
  flickAvgWindowMs: 80, // release-velocity averaging window
  sampleBufferMs: 120, // rolling sample retention

  // Idle look-at-mouse
  mouseEaseRate: 12,
  trackRangeX: 0.65,
  trackRangeY: 0.5,

  // Free-spin physics
  spinDampingPerSec: 0.55, // ~1.3s half-life
  spinStopThreshold: 0.005,

  // Emissive glow ("charge up" when spinning fast)
  spinSpeedMax: 16, // rad/s at which the brand colour peaks
  emissiveLight: 0.4,
  emissiveDark: 0.3,
  emissiveBoostMax: 0.7,

  // Mouse-following specular pin
  trackLightDist: 3.0,
  trackLightZ: 2.4,
  trackLightIntensity: 0.85,

  // Demand-mode invalidation
  postActivityMs: 400, // keep rendering this long after the last input

  // Static fill
  ambientIntensity: 0.75,
  keyIntensity: 0.45,
};

// ── Texture: paint the 2D brand mark onto a square canvas ───────────
function buildLogoTexture(bg: string, ink: string): THREE.CanvasTexture {
  const SZ = T.texSize;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SZ;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SZ, SZ);

  // Centre the composition in the inner 70% so the whole mark sits on
  // the visible front face of the sphere instead of crossing the UV seam.
  ctx.save();
  ctx.translate(SZ * 0.5, SZ * 0.5);
  ctx.scale((SZ * T.inner) / 100, (SZ * T.inner) / 100);
  ctx.translate(-50, -50);

  // C-ring (matches the geometry in src/components/site-logo.tsx).
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(45, 50, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(45, 50, 22, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(45, 38, 55, 24);

  // Grey corner triangles (always #A0A0A0 — matches the brand SVG).
  ctx.fillStyle = "#A0A0A0";
  ctx.beginPath();
  ctx.moveTo(65, 0);
  ctx.lineTo(100, 0);
  ctx.lineTo(100, 35);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(65, 100);
  ctx.lineTo(100, 100);
  ctx.lineTo(100, 65);
  ctx.closePath();
  ctx.fill();

  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}

// ── Theme reading ────────────────────────────────────────────────────
function readThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("dark");
  const cssVar = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    bg: cssVar("--color-surface", isDark ? "#15171c" : "#ffffff"),
    ink: cssVar("--color-ink", isDark ? "#f8fafc" : "#0f172a"),
    brand: cssVar("--color-accent", isDark ? "#fb923c" : "#ea580c"),
    isDark,
  };
}

// ── Interactive sphere ───────────────────────────────────────────────
type VelSample = { vx: number; vy: number; t: number };

function LogoSphere({
  texture,
  brandColor,
  isDark,
  reducedMotion,
  isTouch,
}: {
  texture: THREE.Texture;
  brandColor: string;
  isDark: boolean;
  reducedMotion: boolean;
  isTouch: boolean;
}) {
  const invalidate = useThree((s) => s.invalidate);

  const pivot = useRef<THREE.Group>(null!);
  const matRef = useRef<THREE.MeshPhysicalMaterial>(null!);
  const trackLight = useRef<THREE.PointLight>(null!);

  const mouse = useRef(new THREE.Vector2(0, 0));
  const angularVel = useRef(new THREE.Vector2(0, 0));
  const isDragging = useRef(false);
  const last = useRef({ x: 0, y: 0, t: 0 });
  const lastActivity = useRef(0);
  const samples = useRef<VelSample[]>([]);

  // Pre-allocated colour objects — lerping every frame; allocating new
  // THREE.Color instances on every tick would thrash the GC.
  const baseEmissive = useMemo(() => new THREE.Color("#ffffff"), []);
  const brandEmissive = useMemo(
    () => new THREE.Color(brandColor),
    [brandColor],
  );
  const scratchEmissive = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!isTouch) {
        mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
        lastActivity.current = performance.now();
        invalidate();
      }

      if (!isDragging.current) return;
      const now = performance.now();
      const dt = Math.max(now - last.current.t, 1);
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      pivot.current.rotation.y += dx * T.dragSensitivity;
      pivot.current.rotation.x += dy * T.dragSensitivity;
      samples.current.push({ vx: dx / dt, vy: dy / dt, t: now });
      const cutoff = now - T.sampleBufferMs;
      while (samples.current.length && samples.current[0].t < cutoff) {
        samples.current.shift();
      }
      last.current = { x: e.clientX, y: e.clientY, t: now };
      lastActivity.current = now;
      invalidate();
    };

    const onUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      // Average the last ~80ms of motion → robust flick velocity that
      // ignores the tiny stutter when fingers lift off the trackpad.
      const now = performance.now();
      const recent = samples.current.filter(
        (s) => now - s.t < T.flickAvgWindowMs,
      );
      samples.current = [];
      if (recent.length === 0) return;
      let avgVx = 0;
      let avgVy = 0;
      for (const s of recent) {
        avgVx += s.vx;
        avgVy += s.vy;
      }
      avgVx /= recent.length;
      avgVy /= recent.length;
      angularVel.current.x = avgVy * T.flickMultiplier;
      angularVel.current.y = avgVx * T.flickMultiplier;
      lastActivity.current = now;
      invalidate();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [invalidate, isTouch]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.05);
    const v = angularVel.current;

    if (!isDragging.current && !reducedMotion) {
      if (v.lengthSq() > T.spinStopThreshold) {
        // Free spin with exponential damping.
        pivot.current.rotation.x += v.x * d;
        pivot.current.rotation.y += v.y * d;
        v.multiplyScalar(Math.exp(-T.spinDampingPerSec * d));
      } else if (!isTouch) {
        // Look-at-mouse idle (desktop only).
        const tx = -mouse.current.y * T.trackRangeY;
        const ty = mouse.current.x * T.trackRangeX;
        const k = 1 - Math.exp(-T.mouseEaseRate * d);
        pivot.current.rotation.x += (tx - pivot.current.rotation.x) * k;
        pivot.current.rotation.y += (ty - pivot.current.rotation.y) * k;
      }
    }

    // Spin-charge glow: emissive lerps from neutral white → brand colour
    // as angular velocity climbs; intensity peaks at spinSpeedMax rad/s.
    if (matRef.current) {
      const speed = Math.sqrt(v.x * v.x + v.y * v.y);
      const boost = Math.min(speed / T.spinSpeedMax, 1);
      scratchEmissive.copy(baseEmissive).lerp(brandEmissive, boost);
      matRef.current.emissive.copy(scratchEmissive);
      const baseI = isDark ? T.emissiveDark : T.emissiveLight;
      matRef.current.emissiveIntensity = baseI + boost * T.emissiveBoostMax;
    }

    // World-space tracking light — slides the specular highlight across
    // the sphere as the cursor moves (desktop only).
    if (trackLight.current && !isTouch) {
      trackLight.current.position.set(
        mouse.current.x * T.trackLightDist,
        mouse.current.y * T.trackLightDist,
        T.trackLightZ,
      );
    }

    // Self-invalidate to keep the render loop alive while there is
    // motion to animate. When everything settles, the loop pauses.
    const needsMoreFrames =
      isDragging.current ||
      v.lengthSq() > T.spinStopThreshold ||
      (!isTouch &&
        !reducedMotion &&
        performance.now() - lastActivity.current < T.postActivityMs);
    if (needsMoreFrames) state.invalidate();
  });

  return (
    <>
      <pointLight
        ref={trackLight}
        intensity={T.trackLightIntensity}
        distance={0}
      />
      <group ref={pivot}>
        <mesh
          scale={T.meshScale}
          rotation={[0, -Math.PI / 2, 0]}
          onPointerDown={(e) => {
            isDragging.current = true;
            last.current = {
              x: e.clientX,
              y: e.clientY,
              t: performance.now(),
            };
            samples.current = [];
            angularVel.current.set(0, 0);
            lastActivity.current = performance.now();
            invalidate();
          }}
        >
          <sphereGeometry args={[1, 128, 128]} />
          <meshPhysicalMaterial
            ref={matRef}
            map={texture}
            emissive="#ffffff"
            emissiveMap={texture}
            emissiveIntensity={isDark ? T.emissiveDark : T.emissiveLight}
            roughness={0.5}
            metalness={0}
            clearcoat={0.35}
            clearcoatRoughness={0.4}
            envMapIntensity={0}
          />
        </mesh>
      </group>
    </>
  );
}

// ── Public component ─────────────────────────────────────────────────
const swallowEvent = (e: React.SyntheticEvent) => {
  // Stop clicks reaching the parent <Link> wrapper so the sphere stays
  // playable without triggering navigation or showing a URL tooltip.
  e.preventDefault();
  e.stopPropagation();
};

export function SiteLogo3D({ size = 22 }: { size?: number }) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [brand, setBrand] = useState("#ea580c");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isTouch, setIsTouch] = useState(false);

  // Regenerate the texture whenever the .dark class toggles on <html>.
  useEffect(() => {
    const refresh = () => {
      const colors = readThemeColors();
      setIsDark(colors.isDark);
      setBrand(colors.brand);
      setTex((prev) => {
        prev?.dispose();
        return buildLogoTexture(colors.bg, colors.ink);
      });
    };
    refresh();
    const obs = new MutationObserver(refresh);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  // Media queries: reduced-motion and coarse-pointer (touch).
  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarse = window.matchMedia("(pointer: coarse)");
    const sync = () => {
      setReducedMotion(motion.matches);
      setIsTouch(coarse.matches);
    };
    sync();
    motion.addEventListener("change", sync);
    coarse.addEventListener("change", sync);
    return () => {
      motion.removeEventListener("change", sync);
      coarse.removeEventListener("change", sync);
    };
  }, []);

  // Adaptive DPR — a 22px element at dpr=6 on a retina phone is wasteful.
  const dpr: [number, number] = isTouch ? [1.5, 2] : [3, 6];

  return (
    <div
      style={{
        width: size,
        height: size,
        cursor: "grab",
        touchAction: "none",
      }}
      className="shrink-0 active:cursor-grabbing"
      aria-hidden
      onClick={swallowEvent}
      onMouseDown={swallowEvent}
      onPointerDown={swallowEvent}
    >
      <Canvas
        camera={{ position: [0, 0, T.cameraZ], fov: T.fov }}
        dpr={dpr}
        frameloop="demand"
        gl={{
          alpha: true,
          antialias: true,
          toneMapping: THREE.NoToneMapping,
        }}
        flat
      >
        <ambientLight intensity={T.ambientIntensity} />
        <directionalLight position={[2, 2.5, 3]} intensity={T.keyIntensity} />
        {tex && (
          <LogoSphere
            texture={tex}
            brandColor={brand}
            isDark={isDark}
            reducedMotion={reducedMotion}
            isTouch={isTouch}
          />
        )}
      </Canvas>
    </div>
  );
}
