"use client";

import React, { Suspense, useCallback, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls, ContactShadows, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { EffectComposer, DepthOfField } from "@react-three/postprocessing";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const MODEL_URL = `${BASE_PATH}/models/hotel.glb`;

type BoundsInfo = {
  radius: number;
  center: THREE.Vector3;
};

function HotelModel({ onBounds }: { onBounds: (b: BoundsInfo) => void }) {
  const groupRef = useRef<THREE.Group>(null);
  const gltf = useGLTF(MODEL_URL);

  // After the model loads, fit its bottom to y=0 and report bounds
  React.useLayoutEffect(() => {
    if (!groupRef.current) return;
    const temp = new THREE.Group();
    temp.add(gltf.scene.clone(true));
    // Compute bounds
    const box = new THREE.Box3().setFromObject(temp);
    const size = new THREE.Vector3();
    box.getSize(size);
    const sphere = new THREE.Sphere();
    box.getBoundingSphere(sphere);
    const minY = box.min.y;
    // Position the original scene flush with ground (y=0)
    groupRef.current.position.set(0, -minY, 0);
    onBounds({ radius: sphere.radius, center: sphere.center.clone().setY(0) });
  }, [gltf, onBounds]);

  return (
    <group ref={groupRef} castShadow receiveShadow>
      <primitive object={gltf.scene} castShadow receiveShadow />
    </group>
  );
}

useGLTF.preload(MODEL_URL);

function Scene() {
  const [bounds, setBounds] = useState<BoundsInfo>({
    radius: 5,
    center: new THREE.Vector3(0, 0, 0),
  });

  const onBounds = useCallback((b: BoundsInfo) => setBounds(b), []);

  return (
    <>
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
        <HotelModel onBounds={onBounds} />
      </Suspense>

      {/* Ground receiving shadows */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[bounds.radius * 10, bounds.radius * 10]} />
        <meshStandardMaterial color="#e6e6e6" />
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
        enableDamping
        dampingFactor={0.1}
        enablePan={false}
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={bounds.radius * 1.2}
        maxDistance={bounds.radius * 5}
      />
    </>
  );
}

export default function Page() {
  return (
    <main style={{ width: "100%", height: "100vh" }}>
      <Canvas
        shadows
        onCreated={({ camera }) => {
          camera.position.set(8, 6, 8);
          camera.lookAt(0, 0, 0);
        }}
        camera={{ fov: 50, near: 0.1, far: 1000 }}
        dpr={[1, 2]}
      >
        <Scene />
      </Canvas>
    </main>
  );
}


