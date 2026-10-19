import { useCurrentFrame, useVideoConfig, staticFile } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useMemo } from "react";
import * as THREE from "three";
import { easeInOutCubic, easeOutCubic, remap } from "../lib/easing";

/**
 * 3-second intro of the OCB sphere. Direct port of the interactive HTML
 * prototype at /Users/user/mobula/open_logo_3d/index.html, with two
 * adjustments for Remotion:
 *
 *  1. All rotation is computed from `useCurrentFrame()` (Remotion freezes
 *     the R3F render loop with frameloop="never", so `useFrame` won't run).
 *  2. Lighting / material match the prototype exactly so the brand keeps
 *     its signature look — warm key, cool rim, soft fill, clearcoat.
 *
 * Pre-render this composition once per theme and ffmpeg-concat in front of
 * every bench race. Re-rendering on every share would cost ~$0.005 each
 * for an animation that is identical bit-for-bit.
 */

const ROTATION_START_FRAME = 9;
const ROTATION_END_FRAME = 78;

export const Logo3D: React.FC<{ theme: "light" | "dark" }> = ({ theme }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Rotation timeline: full 360° on Y axis between frames 9 and 78 with
  // ease-in-out so the start and stop both feel intentional rather than
  // robotic. The slight X-axis oscillation (sin) keeps the sphere feeling
  // alive — the prototype gets this for free from cursor tracking, the
  // video has to fake it deterministically.
  const rotProgress = remap(
    frame,
    ROTATION_START_FRAME,
    ROTATION_END_FRAME,
    0,
    1,
    easeInOutCubic,
  );
  const rotY = rotProgress * Math.PI * 2;
  const rotX = Math.sin(frame * 0.06) * 0.18;

  // Subtle entrance scale + opacity so the sphere materialises rather than
  // popping in.
  const entrance = remap(frame, 0, 9, 0, 1, easeOutCubic);
  const scale = remap(frame, 0, 9, 0.82, 1, easeOutCubic);

  // Exit fade for the last 12 frames so the transition into the chart
  // race doesn't feel like a hard cut.
  const exit = 1 - remap(frame, 78, 90, 0, 1, easeInOutCubic);
  const opacity = entrance * exit;

  return (
    <ThreeCanvas
      width={width}
      height={height}
      gl={{
        antialias: true,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.05,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      camera={{
        fov: 38,
        // FOV is vertical: in portrait the sphere is framed against the
        // (tall) height and overflows the (narrow) width. Pull the camera
        // back by the aspect inverse so the sphere is sized against the
        // width instead (~70% of width in 9:16, same feel as 16:9).
        position: [0, 0, height > width ? 4.2 * (height / width) : 4.2],
        near: 0.1,
        far: 100,
      }}
      style={{ background: "transparent" }}
    >
      {/* Lighting calibration mirrors the prototype: warm key from front-
          right, cool rim from back-left, soft fill from front-left. The
          ambient base keeps the dark side of the sphere readable. */}
      <ambientLight intensity={0.35} />
      <directionalLight position={[2.5, 3, 4]} intensity={1.4} color="#ffffff" />
      <directionalLight position={[-3, -1, -2.5]} intensity={0.7} color="#6f8cff" />
      <directionalLight position={[-1, 2, 1]} intensity={0.25} color="#ffd9a8" />

      <group rotation={[rotX, rotY, 0]} scale={scale}>
        <Sphere theme={theme} opacity={opacity} />
      </group>
    </ThreeCanvas>
  );
};

/**
 * The textured sphere itself. Texture is fetched once via useMemo so the
 * TextureLoader doesn't re-fire on every frame (Remotion re-renders the
 * tree per frame; without memoisation we'd re-decode the PNG 90 times).
 *
 * The sphere's local Y rotation of -π/2 calibrates the texture so the
 * logo face points at the camera at frame 0; the parent group then drives
 * the full 360° turn on top of that.
 */
const Sphere: React.FC<{ theme: "light" | "dark"; opacity: number }> = ({
  theme,
  opacity,
}) => {
  const texture = useMemo(() => {
    const loader = new THREE.TextureLoader();
    const t = loader.load(staticFile("logo-texture.png"));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);

  return (
    <mesh rotation={[0, -Math.PI / 2, 0]}>
      <sphereGeometry args={[1, 192, 192]} />
      <meshPhysicalMaterial
        map={texture}
        roughness={theme === "light" ? 0.38 : 0.32}
        metalness={0.04}
        clearcoat={0.7}
        clearcoatRoughness={0.18}
        sheen={0.2}
        sheenColor={new THREE.Color(0xfff2dc)}
        transparent
        opacity={opacity}
      />
    </mesh>
  );
};
