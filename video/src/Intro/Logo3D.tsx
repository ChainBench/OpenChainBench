import { useCurrentFrame, useVideoConfig } from "remotion";
import { ThreeCanvas } from "@remotion/three";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { easeInOutCubic, easeOutCubic, remap } from "../lib/easing";

/**
 * 3-second intro: the OCB mark as a solid, machined object. v27 replaces
 * the textured sphere (the flat logo wrapped on a ball, stretched at the
 * edges and hidden for most of the turn) with the mark itself extruded:
 * the C ring in bright polished steel, the two corner markers in grey
 * brushed steel (on black, the site's black C would not show). Geometry is the site's SVG mark (src/components/site-
 * logo.tsx, viewBox 100): ring centred at (45, 50), r 45, cut by an
 * ellipse rx 22 ry 40 and the gap y 38..62; markers (65,0)(100,0)(100,35)
 * and their mirror.
 *
 * Timeline at 30 fps: 0-10 materialise, 6-72 one full turn on Y eased
 * in and out (ends face-on), a light sweeps across the steel at 40-70,
 * 78-90 fade out into the race.
 */

const TURN_START = 6;
const TURN_END = 72;

/** SVG (viewBox 100, y down) -> scene units (2 wide, y up, centred). */
const P = (x: number, y: number) => new THREE.Vector2((x - 50) / 50, (50 - y) / 50);

function ringShape(): THREE.Shape {
  const cx = (45 - 50) / 50;
  const R = 0.9, rx = 0.44, ry = 0.8, gap = 0.24;
  const a = Math.asin(gap / R);
  const b = Math.asin(gap / ry);
  const s = new THREE.Shape();
  s.moveTo(cx + R * Math.cos(a), R * Math.sin(a));
  s.absarc(cx, 0, R, a, 2 * Math.PI - a, false);
  s.lineTo(cx + rx * Math.cos(b), -ry * Math.sin(b));
  s.absellipse(cx, 0, rx, ry, 2 * Math.PI - b, b, true, 0);
  s.closePath();
  return s;
}

function triangle(pts: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  pts.forEach(([x, y], i) => (i ? s.lineTo(P(x, y).x, P(x, y).y) : s.moveTo(P(x, y).x, P(x, y).y)));
  s.closePath();
  return s;
}

const EXTRUDE: THREE.ExtrudeGeometryOptions = {
  depth: 0.22,
  bevelEnabled: true,
  bevelThickness: 0.035,
  bevelSize: 0.022,
  bevelSegments: 6,
  curveSegments: 128,
};

/**
 * A studio environment for the metal to reflect; built once per canvas.
 * Metalness stays at 0.6, not 1: the first frames render before this
 * effect runs, and a full metal with no environment renders black.
 */
const Studio: React.FC = () => {
  const { gl, scene } = useThree();
  useEffect(() => {
    const pm = new THREE.PMREMGenerator(gl);
    const env = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    return () => {
      env.dispose();
      pm.dispose();
    };
  }, [gl, scene]);
  return null;
};

export const Logo3D: React.FC<{ theme: "light" | "dark" }> = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const isPortrait = height > width;

  const turn = remap(frame, TURN_START, TURN_END, 0, 1, easeInOutCubic);
  const rotY = -Math.PI * 2 * (1 - turn);
  // A slight tilt that settles as the turn ends.
  const rotX = 0.22 * (1 - turn) + Math.sin(frame * 0.05) * 0.03;
  const entrance = remap(frame, 0, 10, 0, 1, easeOutCubic);
  const scale = remap(frame, 0, 14, 0.7, 1, easeOutCubic) * remap(frame, 72, 90, 1, 1.04);
  const exit = 1 - remap(frame, 78, 90, 0, 1, easeInOutCubic);
  const opacity = entrance * exit;
  // The sweep light travels left to right across the face.
  const sweep = remap(frame, 40, 72, -4, 4, easeInOutCubic);

  const [ring, markers] = useMemo(() => {
    const r = new THREE.ExtrudeGeometry(ringShape(), EXTRUDE);
    const m = new THREE.ExtrudeGeometry(
      [triangle([[65, 0], [100, 0], [100, 35]]), triangle([[65, 100], [100, 100], [100, 65]])],
      EXTRUDE,
    );
    // Centre on the extrusion depth so the turn pivots through the middle.
    r.translate(0, 0, -0.11);
    m.translate(0, 0, -0.11);
    return [r, m];
  }, []);

  return (
    <ThreeCanvas
      width={width}
      height={height}
      gl={{
        antialias: true,
        powerPreference: "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.25,
        outputColorSpace: THREE.SRGBColorSpace,
      }}
      camera={{
        fov: 38,
        // FOV is vertical: in portrait pull back by the aspect inverse so
        // the mark is sized against the width.
        position: [0, 0, isPortrait ? 4.6 * (height / width) : 4.6],
        near: 0.1,
        far: 100,
      }}
      style={{ background: "transparent" }}
    >
      <Studio />
      <ambientLight intensity={0.4} />
      <directionalLight position={[3, 4, 5]} intensity={2.4} color="#ffffff" />
      <directionalLight position={[-4, 2, 3]} intensity={1.1} color="#dfe6ff" />
      {/* Cool rim from behind, so the edges separate from the black. */}
      <directionalLight position={[-3, -1, -4]} intensity={1.6} color="#7f9cff" />
      <pointLight position={[sweep, 0.6, 2.2]} intensity={opacity * 14} distance={7} color="#ffffff" />

      <group position={[0.06, isPortrait ? 0.15 : 0.32, 0]} rotation={[rotX, rotY, 0]} scale={0.78 * scale}>
        <mesh geometry={ring}>
          <meshPhysicalMaterial
            color="#d4d8de"
            metalness={0.6}
            roughness={0.22}
            clearcoat={1}
            clearcoatRoughness={0.06}
            envMapIntensity={2.2}
            transparent
            opacity={opacity}
          />
        </mesh>
        <mesh geometry={markers}>
          <meshPhysicalMaterial
            color="#9aa0a9"
            metalness={0.55}
            roughness={0.32}
            envMapIntensity={1.8}
            transparent
            opacity={opacity}
          />
        </mesh>
      </group>
    </ThreeCanvas>
  );
};
