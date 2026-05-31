"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import * as THREE from "three";
import { Suspense, useEffect, useRef } from "react";

function LogoSphere() {
  const pivot = useRef<THREE.Group>(null!);
  const tex = useTexture("/logo.png");

  const mouse = useRef(new THREE.Vector2(0, 0));
  const angularVel = useRef(new THREE.Vector2(0, 0));
  const isDragging = useRef(false);
  const last = useRef({ x: 0, y: 0, t: 0 });

  useEffect(() => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
  }, [tex]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
      if (!isDragging.current) return;
      const dx = e.clientX - last.current.x;
      const dy = e.clientY - last.current.y;
      pivot.current.rotation.y += dx * 0.006;
      pivot.current.rotation.x += dy * 0.006;
      last.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const onUp = (e: PointerEvent) => {
      if (!isDragging.current) return;
      isDragging.current = false;
      const dt = Math.max(performance.now() - last.current.t, 12);
      angularVel.current.x = ((e.clientY - last.current.y) / dt) * 0.18;
      angularVel.current.y = ((e.clientX - last.current.x) / dt) * 0.18;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useFrame(() => {
    if (isDragging.current) return;
    const v = angularVel.current;
    if (v.lengthSq() > 0.00002) {
      pivot.current.rotation.x += v.x;
      pivot.current.rotation.y += v.y;
      v.multiplyScalar(0.975);
    } else {
      const tx = -mouse.current.y * 0.4;
      const ty = mouse.current.x * 0.55;
      pivot.current.rotation.x += (tx - pivot.current.rotation.x) * 0.07;
      pivot.current.rotation.y += (ty - pivot.current.rotation.y) * 0.07;
    }
  });

  return (
    <group ref={pivot}>
      <mesh
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
        <sphereGeometry args={[1, 192, 192]} />
        <meshPhysicalMaterial
          map={tex}
          roughness={0.32}
          metalness={0.04}
          clearcoat={0.7}
          clearcoatRoughness={0.18}
          sheen={0.2}
          sheenColor="#fff2dc"
        />
      </mesh>
    </group>
  );
}

export function HeroLogo3D({ size = 360 }: { size?: number }) {
  return (
    <div
      className="mx-auto w-full"
      style={{ maxWidth: size, aspectRatio: "1 / 1" }}
      aria-hidden
    >
      <Canvas
        camera={{ position: [0, 0, 4.2], fov: 38 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
      >
        <ambientLight intensity={0.35} />
        <directionalLight position={[2.5, 3, 4]} intensity={1.4} />
        <directionalLight
          position={[-3, -1, -2.5]}
          intensity={0.7}
          color="#6f8cff"
        />
        <directionalLight
          position={[-1, 2, 1]}
          intensity={0.25}
          color="#ffd9a8"
        />
        <Suspense fallback={null}>
          <LogoSphere />
        </Suspense>
      </Canvas>
    </div>
  );
}
