# 03. Art Style

## Decided
- **Direction:** Ultrakill-like: retro lo-fi (PS1 era), saturated reds/oranges/neon against dark grimy environments, chunky effects.
- **No hand modeling.** Visuals come from shaders, color and game feel, not detailed assets.

## Why it fits a browser game
Low-res textures, fog and flat shading are cheap on integrated GPUs, and fog doubles as draw-distance control. 32 low-poly players are trivial for WebGL.

## No-modeling pipeline (in priority order)
1. **Code-generated primitives (foundation).**
   - Levels: boxes, cylinders and ramps in JSON, like Quake brushes.
   - Textures: generated on a canvas at about 64x64 (noise, bricks, panels, grime), sampled with nearest-neighbor filtering.
   - Enemies: assembled from primitives and animated in code (bob, spin, squash and stretch). Favor floating eyes, orbs, turrets and armored cubes over walking humanoids.
2. **CC0 asset packs** for props and weapons (Kenney, Quaternius, Poly Pizza, itch.io PS1 packs), loaded as glTF. The global shader unifies mismatched assets.
3. **AI text/image-to-3D** (Meshy, Tripo, Rodin) for occasional hero assets. Downscaled textures plus PS1 shader hide the mess. Rigging and animation is the hidden cost; Mixamo for humanoids.
4. **2D billboard sprite enemies** (Doom approach) as the cheapest route to enemy variety, at some cost to the Ultrakill look.
5. **Level editor:** a tiny in-browser block editor (vibe-coded) or TrenchBroom.

## The global look (shader checklist)
- Low internal render resolution (about 427x240), nearest-neighbor upscale
- Vertex snapping / wobble
- Affine-ish texture warping (optional)
- Heavy distance fog
- Limited palette with strong team colors

## Where the Ultrakill feel actually comes from (all code)
- Fast, slidey movement with dash and slide
- Hitstop, screenshake, chunky particles
- Blood and gore effects
- Style meter and punchy HUD

## Rules
- **Readability beats beauty.** Enemies and teams must be identifiable instantly: silhouette, contrast, team colors.
- Constraints create cohesion: one palette, one global shader.
- Target integrated GPUs and laptops: few draw calls, little overdraw, no heavy real-time lighting.

## Other styles considered (for reference)
Flat-shaded low-poly (Krunker), boomer-shooter sprites (Doom, Ion Fury), cel-shaded outlines (Borderlands), neon minimalist (Superhot), 1-bit dither (Obra Dinn). Retro lo-fi chosen.
