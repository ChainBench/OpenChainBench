import { ThreeCanvas } from "@remotion/three";
import { useMemo } from "react";
import * as THREE from "three";
import { C } from "../theme";

/**
 * The masthead's 3D mark, rebuilt for film.
 *
 * The geometry and the texture painting are lifted from the site's
 * src/components/site-logo-3d.tsx, so this is the same object the reader sees
 * in the header: a C-ring with two grey corner triangles, painted onto a
 * sphere in brand colours.
 *
 * What is deliberately different: the site's version is a physics toy driven
 * by pointer velocity and requestAnimationFrame. None of that can exist here.
 * Every value below is a pure function of the frame the caller passes in, or
 * the same second of film would render differently on two machines.
 */

const TEX = 1024;
const INNER = 0.7; // the mark occupies the middle 70% so it never crosses the UV seam

function buildLogoTexture(bg: string, ink: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = TEX;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, TEX, TEX);

  ctx.save();
  ctx.translate(TEX * 0.5, TEX * 0.5);
  ctx.scale((TEX * INNER) / 100, (TEX * INNER) / 100);
  ctx.translate(-50, -50);

  // C-ring
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(45, 50, 45, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.ellipse(45, 50, 22, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(45, 38, 55, 24);

  // The two corner triangles are #A0A0A0 in the brand SVG, in every theme.
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

  // A sphere's u spans the whole 360 degrees, so mapping the square straight
  // on smears the mark around the entire ball: the C's bar became a black
  // stripe round the equator. Sampling the texture over a window wider than
  // the surface shrinks the image into a face-sized patch, and clamping means
  // everything outside that patch takes the texture's edge pixel, which is the
  // background colour, so the rest of the ball stays plain.
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const REPEAT_U = 2.1;
  const REPEAT_V = 1.5;
  tex.repeat.set(REPEAT_U, REPEAT_V);
  tex.offset.set(0.5 * (1 - REPEAT_U), 0.5 * (1 - REPEAT_V));

  tex.needsUpdate = true;
  return tex;
}

export function LogoSphere({
  size,
  rotationY,
  rotationX = 0,
  scale = 1,
  /** 0 to 1. Drives the accent emissive, so a spin can visibly charge up. */
  glow = 0,
  surface = C.surface,
  ink = C.ink,
}: {
  size: number;
  rotationY: number;
  rotationX?: number;
  scale?: number;
  glow?: number;
  surface?: string;
  /** Colour of the mark itself. The wipe flips this to read in negative. */
  ink?: string;
}) {
  const texture = useMemo(() => buildLogoTexture(surface, ink), [surface, ink]);
  const emissive = useMemo(() => {
    const base = new THREE.Color("#ffffff");
    const accent = new THREE.Color(C.accent);
    return base.clone().lerp(accent, Math.max(0, Math.min(1, glow)));
  }, [glow]);

  return (
    <ThreeCanvas
      width={size}
      height={size}
      style={{ background: "transparent" }}
      camera={{ fov: 38, position: [0, 0, 2.4] }}
      gl={{ antialias: true, alpha: true }}
    >
      {/* A dark ball on a dark ground has no silhouette, which is why the
          first cut read as a flat sticker rather than a sphere. Three lights
          fix that and none of them is decoration:

          the ambient is dropped so the surface can actually fall off into
          shadow, a key light models the near side, and two rim lights sit
          BEHIND the ball so its edge catches light the background does not.
          The rim is what draws the circle in the viewer's eye. */}
      <ambientLight intensity={0.32} />
      <directionalLight position={[2.2, 2.4, 3]} intensity={0.85} />
      <pointLight position={[-2.6, 1.4, -2.2]} intensity={2.6} color={C.accent} distance={9} />
      <pointLight position={[2.4, -1.6, -2.4]} intensity={1.9} color="#9fc4ff" distance={9} />
      <pointLight
        position={[1.6, 1.2, 2.4]}
        intensity={0.5 + glow * 1.8}
        color={C.accent}
      />
      {/* SphereGeometry's u=0.5 lands on the +X side of the ball, not the
          camera side, so the mark sat on the right edge at rotationY=0 and a
          half turn only moved it to the left edge. A quarter turn back brings
          it to the front, which is what every caller means by 0. Each of these
          three positions was checked against a rendered frame. */}
      <group rotation={[rotationX, rotationY - Math.PI / 2 + 0.17, 0]} scale={scale * 0.82}>
        <mesh>
          <sphereGeometry args={[1, 192, 192]} />
          <meshPhysicalMaterial
            map={texture}
            roughness={0.3}
            metalness={0.12}
            clearcoat={0.7}
            clearcoatRoughness={0.25}
            emissive={emissive}
            emissiveIntensity={0.3 + glow * 0.7}
            emissiveMap={texture}
          />
        </mesh>
      </group>
    </ThreeCanvas>
  );
}
