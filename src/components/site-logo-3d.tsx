"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useEffect, useRef, useState } from "react";

/**
 * 3D version of <SiteLogo>. Renders the same C-mark on a sphere whose
 * skin color is sampled from `--color-surface`, so the ball blends into
 * the header background. Look-at-mouse + click-and-flick interaction.
 */

function buildLogoTexture(bg: string, ink: string, accent: string) {
  const SZ = 1024;
  const c = document.createElement("canvas");
  c.width = c.height = SZ;
  const ctx = c.getContext("2d")!;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SZ, SZ);

  // Pack the whole composition into the centre 70% of the texture so the
  // corner triangles do NOT cross the sphere's UV seam — that way the full
  // logo sits on the front face when the sphere faces the camera.
  const inner = 0.7;
  ctx.save();
  ctx.translate(SZ * 0.5, SZ * 0.5);
  ctx.scale((SZ * inner) / 100, (SZ * inner) / 100);
  ctx.translate(-50, -50);

  // Ink C-ring: solid disk, then carve the interior with bg-coloured shapes
  // (no compositing tricks needed since bg is opaque).
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(45, 50, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(45, 50, 22, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(45, 38, 55, 24);

  // Grey corner triangles.
  ctx.fillStyle = accent;
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

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.needsUpdate = true;
  return tex;
}

function readThemeColors() {
  const style = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("dark");
  const get = (v: string, fb: string) => style.getPropertyValue(v).trim() || fb;
  return {
    bg: get("--color-surface", isDark ? "#15171c" : "#ffffff"),
    ink: get("--color-ink", isDark ? "#f8fafc" : "#0f172a"),
    accent: "#A0A0A0",
    isDark,
  };
}

function LogoSphere({ texture }: { texture: THREE.Texture }) {
  const pivot = useRef<THREE.Group>(null!);
  const mouse = useRef(new THREE.Vector2(0, 0));
  const angularVel = useRef(new THREE.Vector2(0, 0));
  const isDragging = useRef(false);
  const last = useRef({ x: 0, y: 0, t: 0 });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
      if (!isDragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      pivot.current.rotation.y += dx * 0.015;
      pivot.current.rotation.x += dy * 0.015;
      last.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const dt = Math.max(performance.now() - last.current.t, 12);
      // rad/sec (frame-rate independent); useFrame scales by dt below
      angularVel.current.x = ((e.clientY - last.current.y) / dt) * 18;
      angularVel.current.y = ((e.clientX - last.current.x) / dt) * 18;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useFrame((_, dt) => {
    if (isDragging.current) return;
    // clamp dt to avoid jumps after a tab-switch / long frame
    const d = Math.min(dt, 0.05);
    const v = angularVel.current;
    if (v.lengthSq() > 0.02) {
      // free spin: integrate angular velocity, damp exponentially (~1.2s halflife)
      pivot.current.rotation.x += v.x * d;
      pivot.current.rotation.y += v.y * d;
      const damp = Math.exp(-1.6 * d);
      v.multiplyScalar(damp);
    } else {
      // look-at-mouse: framerate-independent exponential ease (~12 = snappy)
      const tx = -mouse.current.y * 0.5;
      const ty = mouse.current.x * 0.65;
      const k = 1 - Math.exp(-12 * d);
      pivot.current.rotation.x += (tx - pivot.current.rotation.x) * k;
      pivot.current.rotation.y += (ty - pivot.current.rotation.y) * k;
    }
  });

  return (
    <group ref={pivot}>
      <mesh
        scale={0.82}
        rotation={[0, -Math.PI / 2, 0]}
        onPointerDown={(e) => {
          isDragging.current = true;
          last.current = {
            x: e.clientX,
            y: e.clientY,
            t: performance.now(),
          };
          angularVel.current.set(0, 0);
        }}
      >
        <sphereGeometry args={[1, 128, 128]} />
        {/* Brilliant white pearl: emissiveMap = same texture, so the white
            (page) parts of the texture self-illuminate at 40% — even the
            shadow side reads as bright white, matching the page. The dark
            C-mark on the texture has emissive ≈ 0 so it stays dark.
            Clearcoat + low roughness give the shiny pearl highlight you
            felt before. */}
        <meshPhysicalMaterial
          map={texture}
          emissive="#ffffff"
          emissiveMap={texture}
          emissiveIntensity={0.4}
          roughness={0.42}
          metalness={0.0}
          clearcoat={0.75}
          clearcoatRoughness={0.22}
          sheen={0.0}
          envMapIntensity={0}
        />
      </mesh>
    </group>
  );
}

export function SiteLogo3D({ size = 22 }: { size?: number }) {
  const [tex, setTex] = useState<THREE.Texture | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const refresh = () => {
      const { bg, ink, accent, isDark } = readThemeColors();
      setIsDark(isDark);
      setTex((prev) => {
        prev?.dispose();
        return buildLogoTexture(bg, ink, accent);
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

  return (
    <div
      style={{
        width: size,
        height: size,
        filter: "drop-shadow(0 0.5px 1px rgba(15,23,42,0.08))",
      }}
      className="shrink-0"
      aria-hidden
    >
      <Canvas
        camera={{ position: [0, 0, 2.4], fov: 38 }}
        // High raw DPR supersamples the framebuffer so the sphere edge
        // is smooth at 22px — equivalent to a CSS-scale wrapper but
        // without disturbing the surrounding flex layout.
        dpr={[3, 6]}
        gl={{
          alpha: true,
          antialias: true,
          toneMapping: THREE.NoToneMapping,
        }}
        flat
      >
        {/* Highlight-pin lighting. The back-left rim fill is theme-conditional:
            on dark mode it sculpts the silhouette nicely, on light mode it
            ghosted as a stray bright zone bottom-left, so we drop it there. */}
        <ambientLight intensity={0.65} />
        <directionalLight position={[2.5, 3, 4]} intensity={1.0} />
        <pointLight position={[1.2, 1.6, 2.2]} intensity={0.7} />
        {isDark && (
          <directionalLight position={[-2, -1.5, -2]} intensity={0.3} />
        )}
        {tex && <LogoSphere texture={tex} />}
      </Canvas>
    </div>
  );
}
