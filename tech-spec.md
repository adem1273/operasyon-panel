# VIPFlow — Technical Specification

## Component Inventory

### Layout

| Component | Source | Notes |
|-----------|--------|-------|
| `LenisProvider` | Custom wrapper | Global smooth scroll provider, initialized once at app root |
| `Navigation` | Custom | Fixed top bar with glassmorphism, links to sections |
| `Footer` | Custom | 4-column grid layout, newsletter input with cyan focus ring |

### Sections

| Section | Core Effects Used | Description |
|---------|-------------------|-------------|
| `HeroSection` | `city-constellation` | Full-viewport sticky hero with 3D city background and glass dashboard overlay |
| `FeatureTicker` | None | Auto-scrolling marquee of feature highlights |
| `OperationalWave` | `live-data-wave` | 300vh scroll section with particle wave background and sliding feature cards |
| `CoreEngine` | `cipher-grid-text` | 150vh section with kinetic typography grid resolving into feature words |
| `GlobalConnectivity` | None | Split layout with animated CSS radar map and floating metric cards |

### Reusable Components

| Component | Source | Usage |
|-----------|--------|-------|
| `GlassCard` | Custom | Glassmorphism card wrapper used across hero, operational wave, and global sections |
| `GlassButton` | Custom | CTA button with Electric Orange glow and hover scale |
| `MetricCard` | Custom | Small data display card for uptime/latenancy stats |

## Animation Implementation

| Animation | Library | Implementation Approach | Complexity |
|-----------|---------|------------------------|------------|
| **City Constellation** (3D city + flowing lines) | Three.js + @react-three/fiber + @react-three/drei | Custom ShaderMaterial with onBeforeCompile dash-offset shader, BufferGeometry for particles and lines, useFrame for camera orbit and time uniform | **🔒 High** |
| **Live Data Wave** (2000 instanced cubes) | Three.js + @react-three/fiber | InstancedMesh with custom vertex/fragment shaders via onBeforeCompile, uniforms driven by clock time and Lenis velocity | **🔒 High** |
| **Cipher Grid Text** (kinetic typography) | GSAP ScrollTrigger | Vanilla JS grid generation with scroll-scrubbed text resolution, DOM-based with absolute positioning | **🔒 High** |
| **Lenis Smooth Scroll** | Lenis | Global provider wrapping the app, velocity exposed for wave shader | Medium |
| **Feature Ticker** | CSS animation | translateX keyframe animation for seamless infinite scroll | Low |
| **Section Card Slide-in** | GSAP ScrollTrigger | Operational wave feature cards enter from left/right on scroll | Medium |
| **Global Radar** | CSS animation | Rotating concentric circles with pulse animation, pure CSS | Low |
| **Button Hover** | CSS transitions | Scale + box-shadow transition on hover | Low |
| **Card Hover Lift** | CSS transitions | translateY + border opacity transition | Low |

## State & Logic Plan

### Lenis ↔ WebGL Bridge
Lenis is initialized at the app root. Its velocity value must be exposed via a React context or ref so the `live-data-wave` shader can read `lenis.velocity` each frame to drive the horizontal distortion. This is the only cross-system data flow.

### Dual WebGL Context Strategy
Two separate `<Canvas>` components from @react-three/fiber will exist:
1. **Hero Canvas**: `position: fixed`, `z-index: -1`, full viewport. Must pause rendering when not visible to save GPU.
2. **Wave Canvas**: `position: absolute` inside the Operational Wave wrapper, sized to the 300vh section.

### Visibility-based Pause for Hero Canvas
The hero canvas should use a visibility observer or ScrollTrigger to detect when it leaves the viewport. When off-screen, stop the render loop (set `frameloop="demand"` or skip `useFrame` updates) to avoid GPU waste on an invisible scene.

### ScrollTrigger Scrub Setup
GSAP ScrollTrigger instances for the Operational Wave cards and the Cipher Grid Text must be created in `useEffect` hooks with proper cleanup. The Lenis scroll instance must be connected to GSAP's ticker via `ScrollTrigger.scrollerProxy` or `ScrollTrigger.update` calls on Lenis scroll events.

## Dependencies

- `three` — Core 3D engine for both WebGL effects
- `@react-three/fiber` — React renderer for Three.js
- `@react-three/drei` — Utilities for 3D scenes
- `lenis` — Smooth scroll with velocity tracking
- `gsap` — Animation engine with ScrollTrigger plugin
- `current-device` — Device detection for capability-based fallbacks
