"use client";

import React, { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, ContactShadows, useGLTF, Billboard } from "@react-three/drei";
import * as THREE from "three";
import { EffectComposer, DepthOfField } from "@react-three/postprocessing";
import Image from "next/image";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

// Prefer a relative path so it works when the app is mounted under a sub-path (e.g. "/sketch").
// If NEXT_PUBLIC_BASE_PATH is provided (e.g. "/sketch"), prefix with it; otherwise use a relative path.
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH;
const buildAssetUrl = (relativePath: string) => {
  const sanitizedRelative = relativePath.replace(/^\//, "");
  if (BASE_PATH && BASE_PATH !== "/") {
    const sanitizedBase = BASE_PATH.replace(/\/$/, "");
    return `${sanitizedBase}/${sanitizedRelative}`;
  }
  return sanitizedRelative;
};

// For public assets used in DOM (and next/image), always return an absolute path
// so it works regardless of current route depth and respects basePath when set.
const buildPublicUrl = (relativePath: string) => {
  const sanitizedRelative = relativePath.replace(/^\//, "");
  if (BASE_PATH && BASE_PATH !== "/") {
    const sanitizedBase = BASE_PATH.replace(/\/$/, "");
    return `${sanitizedBase}/${sanitizedRelative}`;
  }
  return `/${sanitizedRelative}`;
};

const MODEL_URL = buildAssetUrl("models/hotel.glb");

type BoundsInfo = {
  radius: number;
  center: THREE.Vector3;
};

type Marker = {
  id: string;
  name: string;
  center: THREE.Vector3;
  radius: number;
  description?: string;
  image?: string;
};

type SceneApi = {
  focusMarker: (marker: Marker) => void;
};

function computeObjectSphere(obj: THREE.Object3D): { center: THREE.Vector3; radius: number } | null {
  const box = new THREE.Box3().setFromObject(obj);
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return null;
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  return { center: sphere.center.clone(), radius: sphere.radius };
}

function HotelModel({ onBounds, onMarkers }: { onBounds: (b: BoundsInfo) => void; onMarkers: (m: Marker[]) => void }) {
  const groupRef = useRef<THREE.Group>(null);
  const gltf = useGLTF(MODEL_URL);

  // After the model loads, fit its bottom to y=0 and report bounds
  React.useLayoutEffect(() => {
    if (!groupRef.current) return;

    // Ensure world matrices are updated
    groupRef.current.updateWorldMatrix(true, true);

    // Compute overall model bounds from a cloned scene (unmodified)
    const temp = new THREE.Group();
    temp.add(gltf.scene.clone(true));
    const box = new THREE.Box3().setFromObject(temp);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const minY = box.min.y;

    // Position the model so its bottom sits on y=0
    groupRef.current.position.set(0, -minY, 0);

    // Now that offset is applied, update world matrices to compute correct per-group centers
    groupRef.current.updateWorldMatrix(true, true);

    // Heuristic: make markers for top-level named children, or groups with visible meshes
    const candidates: THREE.Object3D[] = gltf.scene.children.filter((c) => {
      return !!c.name && c.visible;
    });

    if (candidates.length === 0) {
      gltf.scene.traverse((o) => {
        if (o.name && o.visible && o instanceof THREE.Mesh) {
          candidates.push(o);
        }
      });
    }

    const markers: Marker[] = [];
    const usedNames = new Set<string>();
    for (const obj of candidates) {
      const sphereInfo = computeObjectSphere(obj);
      if (!sphereInfo) continue;
      const { center, radius } = sphereInfo;
      if (!isFinite(radius) || radius <= 0.02) continue;

      const safeName = obj.name?.trim() || "Group";
      if (usedNames.has(safeName)) continue;
      usedNames.add(safeName);

      markers.push({
        id: obj.uuid,
        name: safeName,
        center,
        radius,
        description: `Information about ${safeName}.`,
        image: buildPublicUrl("next.svg"),
      });
      if (markers.length >= 20) break;
    }

    // Apply override for Power Aisle marker: name and image
    const overrideName = "Power Aisle";
    const overrideImage = buildPublicUrl("markers/power-aisle.png");
    let target = markers.find((m) => m.name.toLowerCase() === overrideName.toLowerCase());
    if (!target && markers.length > 0) {
      target = markers[0];
    }
    if (target) {
      target.name = overrideName;
      target.image = overrideImage;
      if (!target.description) {
        target.description = "High-capacity aisle for main power distribution.";
      }
    }

    onBounds({ radius: sphere.radius, center: sphere.center.clone().setY(0) });
    onMarkers(markers);
  }, [gltf, onBounds, onMarkers]);

  return (
    <group ref={groupRef} castShadow receiveShadow>
      <primitive object={gltf.scene} castShadow receiveShadow />
    </group>
  );
}

useGLTF.preload(MODEL_URL);

function useFlyTo(controlsRef: React.RefObject<OrbitControlsImpl | null>) {
  const { camera } = useThree();
  const animRef = useRef<{
    startPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endPos: THREE.Vector3;
    endTarget: THREE.Vector3;
    t: number;
    d: number;
    onComplete?: () => void;
  } | null>(null);

  useFrame((_, delta) => {
    const a = animRef.current;
    if (!a) return;
    a.t = Math.min(a.t + delta, a.d);
    const k = a.t / a.d;
    const e = k * k * (3 - 2 * k);

    const pos = new THREE.Vector3().lerpVectors(a.startPos, a.endPos, e);
    const tgt = new THREE.Vector3().lerpVectors(a.startTarget, a.endTarget, e);

    camera.position.copy(pos);
    if (controlsRef.current) {
      controlsRef.current.target.copy(tgt);
      controlsRef.current.update();
    } else {
      camera.lookAt(tgt);
    }

    if (a.t >= a.d) {
      const cb = a.onComplete;
      animRef.current = null;
      if (cb) cb();
    }
  });

  const flyTo = (endTarget: THREE.Vector3, distance: number, duration = 1.2, onComplete?: () => void) => {
    const dir = new THREE.Vector3()
      .subVectors(camera.position, controlsRef.current?.target ?? new THREE.Vector3(0, 0, 0))
      .normalize();
    if (!isFinite(dir.length()) || dir.length() === 0) dir.set(1, 0.5, 1).normalize();

    const minD = controlsRef.current?.minDistance ?? 0;
    const endDistance = Math.max(distance, minD + 0.01);
    const endPos = new THREE.Vector3().copy(endTarget).addScaledVector(dir, endDistance);
    const startPos = camera.position.clone();
    const startTarget = controlsRef.current?.target?.clone() ?? new THREE.Vector3(0, 0, 0);

    animRef.current = {
      startPos,
      startTarget,
      endPos,
      endTarget: endTarget.clone(),
      t: 0,
      d: Math.max(0.2, duration),
      onComplete,
    };
  };

  return flyTo;
}

function Marker3D({ marker, onClick }: { marker: Marker; onClick: (m: Marker) => void }) {
  const color = "#ff5566";
  const hoverRef = useRef(false);
  const scaleRef = useRef(1);
  useFrame((_, delta) => {
    const target = hoverRef.current ? 1.3 : 1.0;
    scaleRef.current += (target - scaleRef.current) * Math.min(1, delta * 8);
  });

  return (
    <Billboard position={marker.center.toArray()} follow={true}>
      <mesh
        onPointerOver={() => (hoverRef.current = true)}
        onPointerOut={() => (hoverRef.current = false)}
        onClick={(e) => {
          e.stopPropagation();
          onClick(marker);
        }}
        scale={[0.08 * scaleRef.current, 0.08 * scaleRef.current, 0.08 * scaleRef.current]}
        castShadow
        receiveShadow
      >
        <sphereGeometry args={[1, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} />
      </mesh>
    </Billboard>
  );
}

function Scene({
  onMarkers,
  onSelect,
  onReady,
}: {
  onMarkers: (m: Marker[]) => void;
  onSelect: (id: string) => void;
  onReady: (api: SceneApi) => void;
}) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const [bounds, setBounds] = useState<BoundsInfo>({
    radius: 5,
    center: new THREE.Vector3(0, 0, 0),
  });
  const [markers, setMarkers] = useState<Marker[]>([]);
  const onBounds = useCallback((b: BoundsInfo) => setBounds(b), []);
  const flyTo = useFlyTo(controlsRef);

  const handleMarkers = useCallback(
    (m: Marker[]) => {
      setMarkers(m);
      onMarkers(m);
    },
    [onMarkers]
  );

  const focusMarker = useCallback(
    (m: Marker) => {
      onSelect(m.id);
      // Try to get closer, based on marker radius, but clamp to a tighter min
      const desired = Math.max(m.radius * 2.25, 0.8);
      const dist = Math.min(desired, bounds.radius * 0.9);
      flyTo(m.center, dist, 1.0);
    },
    [flyTo, bounds.radius, onSelect]
  );

  React.useEffect(() => {
    onReady({ focusMarker });
  }, [onReady, focusMarker]);

  return (
    <>
      {/* Scene background */}
      <color attach="background" args={["#171819"]} />
      {/* Distance fog to suggest infinite ground */}
      {(() => {
        const fogNear = Math.max(bounds.radius * 2, 10);
        const fogFar = Math.max(bounds.radius * 16, 160);
        return <fog attach="fog" args={["#171819", fogNear, fogFar]} />;
      })()}

      {/* Lights */}
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[10, 15, 10]}
        intensity={1.1}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />

      {/* Model */}
      <Suspense fallback={null}>
        <HotelModel onBounds={onBounds} onMarkers={handleMarkers} />
      </Suspense>

      {/* Markers */}
      {markers.map((m) => (
        <Marker3D key={m.id} marker={m} onClick={focusMarker} />
      ))}

      {/* Infinite-like ground plane directly under model */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[10000, 10000]} />
        <meshStandardMaterial color="#171819" />
      </mesh>

      <ContactShadows
        position={[0, 0.001, 0]}
        opacity={0.5}
        scale={bounds.radius * 6}
        blur={2.5}
        far={bounds.radius * 4}
      />

      {/* Postprocessing */}
      <EffectComposer>
        <DepthOfField focusDistance={0.02} focalLength={0.02} bokehScale={2} />
      </EffectComposer>

      {/* Controls with constraints */}
      <OrbitControls
        ref={controlsRef}
        enableDamping
        dampingFactor={0.1}
        enablePan={false}
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2 - 0.05}
        /* Allow closer zoom-in to let fly-to get near the marker */
        minDistance={Math.max(bounds.radius * 0.4, 0.5)}
        /* Limit max distance a bit for cohesion */
        maxDistance={bounds.radius * 1.1}
      />
    </>
  );
}

export default function Page() {
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const sceneApiRef = useRef<SceneApi | null>(null);

  const selected = useMemo(() => markers.find((m) => m.id === selectedId) || null, [markers, selectedId]);

  return (
    <main style={{ width: "100%", height: "100vh", backgroundColor: "#171819", position: "relative" }}>
      <Canvas
        shadows
        onCreated={({ camera }) => {
          camera.position.set(8, 6, 8);
          camera.lookAt(0, 0, 0);
        }}
        camera={{ fov: 50, near: 0.1, far: 1000 }}
        dpr={[1, 2]}
      >
        <Scene
          onMarkers={(m) => setMarkers(m)}
          onSelect={(id) => setSelectedId(id)}
          onReady={(api) => (sceneApiRef.current = api)}
        />
      </Canvas>

      {/* Fixed legend on the right side */}
      <div
        style={{
          position: "fixed",
          right: 16,
          top: 16,
          width: 260,
          maxHeight: "calc(100vh - 32px)",
          overflow: "auto",
          padding: 12,
          borderRadius: 10,
          background: "linear-gradient(180deg, rgba(20,20,22,0.15), rgba(10,10,12,0.15))",
          boxShadow: "0 8px 30px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
          backdropFilter: "blur(35px)",
          color: "white",
          border: "1px solid rgba(255,255,255,0.08)",
          pointerEvents: "auto",
          zIndex: 20,
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8, fontSize: 14, opacity: 0.95 }}>Points of Interest</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {markers.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 12 }}>No named groups found in model.</div>
          ) : (
            markers.map((m) => (
              <button
                key={m.id}
                onClick={() => sceneApiRef.current?.focusMarker(m)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: m.id === selectedId ? "rgba(20,110,245,0.35)" : "rgba(255,255,255,0.06)",
                  color: "white",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                {m.name}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Centered callout card, stacked layout with full-width image */}
      {selected && (
        <div
          style={{
            position: "fixed",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: 420,
            maxWidth: "calc(100vw - 32px)",
            padding: 16,
            borderRadius: 12,
            background: "linear-gradient(180deg, rgba(18,18,20,0.15), rgba(12,12,14,0.15))",
            boxShadow: "0 10px 40px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)",
            backdropFilter: "blur(35px)",
            color: "white",
            pointerEvents: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 10,
            border: "1px solid rgba(255,255,255,0.08)",
            zIndex: 30,
          }}
        >
          {selected.image && (
            <div style={{ position: "relative", width: "100%", height: 220 }}>
              <Image
                src={selected.image}
                alt={selected.name}
                fill
                sizes="100vw"
                style={{ objectFit: "cover", borderRadius: 10 }}
                unoptimized
              />
            </div>
          )}
          <div style={{ fontWeight: 700, fontSize: 18, lineHeight: 1.2 }}>{selected.name}</div>
          {selected.description && (
            <div style={{ fontSize: 13, opacity: 0.95, lineHeight: 1.6 }}>{selected.description}</div>
          )}
          <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
            <button
              onClick={() => sceneApiRef.current?.focusMarker(selected)}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.08)",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Re-center
            </button>
            <button
              onClick={() => setSelectedId(null)}
              style={{
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.15)",
                background: "rgba(255,255,255,0.08)",
                color: "white",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </main>
  );
}


