# Art Style Guide

**Owner:** Luke (art, design, sound) · **Status:** direction chosen, palette and screen effect in progress · **Milestone:** M8 (Look, sound and feel)

This is the source of truth for how Arena looks. If a visual choice isn't covered here, add it here first, then build it.

## Direction: pixel "graphic realism"

Arena's look is **Marathon-style sci-fi rendered as pixel art**.

Marathon's art director describes its style as "Graphic Realism": a simplified, deconstructed design language with strong graphic statements and limited materials, combined with realistic proportions and scale, implied function, and a grounded world. Named influences include Mirror's Edge, Ghost in the Shell, Aeon Flux, Katsuhiro Otomo and The Designers Republic.

Why it suits us:
- It is built on **bold shapes and flat color**, not fine detail, so it survives low resolution.
- It needs **few materials**, which matches our "no hand modeling" rule (see `spec/brainstorm/03-art-style.md`).
- Graphic elements (stripes, numbers, symbols, light strips) can all be **generated in code**.

This replaces the earlier "Ultrakill red/orange on dark grime" direction from the brainstorm notes. The technical pipeline from those notes (low internal resolution, fog, code-generated textures, one global shader) still applies.

## Palette

Defined in `client/src/palette.ts`. **Every color in the game comes from this list.** The screen effect snaps every pixel to these colors, so anything else is impossible on screen anyway.

### Neutrals: the world (about 90% of the screen)

| Name | Hex | Use |
|---|---|---|
| INK | `#0b0b0d` | Deepest shadows, outlines |
| GRAPHITE | `#2a2c31` | Dark metal, floors in shadow |
| CONCRETE | `#7a7e86` | Mid-grey structures |
| HAZE | `#b9bcc2` | Sky and distance fog |
| BONE | `#e8e4d8` | Clean off-white walls |

### Accents: small areas only, one meaning each

| Name | Hex | Meaning | Examples |
|---|---|---|---|
| ACID | `#c6ff1a` | **Traversal: "you can go here"** | Jump pads, routes (climbable walls used it until climbing was removed) |
| HAZARD | `#ff4b1f` | **Danger** | Gunfire, tracers, hit sparks, low health, enemy markers |
| SIGNAL | `#2de2e6` | **Technology** | Light strips, screens, HUD |

### Team colors: characters only, never on world geometry

| Name | Hex | Meaning | Examples |
|---|---|---|---|
| COBALT | `#3170d8` | **The blue team** | The trooper's helmet stripe, shoulder edges, forearm and knee stripes |
| VIOLET | `#5b3a9e` | **The violet team** | The assassin's sash |

### Character trim

| Name | Hex | Use |
|---|---|---|
| BRASS | `#c9a227` | Gold trim on characters, thin lines only (it sits near ACID, so never large areas) |

## Rules

1. **Calm world, loud accents.** Accents stay small. If an accent covers a large area, it stops meaning anything.
2. **One meaning per accent.** Never use ACID for decoration or HAZARD for a friendly thing. Players learn the color language without a tutorial.
3. **Readability beats beauty.** Players and enemies must be identifiable instantly by silhouette and contrast.
4. **Team colors:** COBALT (blue) and VIOLET, added 2026-10-13 with the trooper and the assassin. Keep team colors off world geometry. Phase 1 is free-for-all, where HAZARD marks enemies: the trooper carries no HAZARD, so how an enemy reads in free-for-all (an outline, a HAZARD marker, a second team color) is still open.
5. **Target cheap laptops.** Few draw calls, little overdraw, no heavy real-time lighting.

## Screen effect

Implemented in `client/src/render.ts`, as a shader on the step that upscales the low-res frame to the window.

Per pixel it:
1. Converts the scene color from linear to sRGB (the palette's color space).
2. Adds an ordered-dither offset from a 4×4 Bayer pattern, aligned to the low-res pixel grid.
3. Snaps to the nearest palette color.

Controls:
- `?res=240` (URL): internal render height. 240 is the target retro look; default is 720.
- `?fx=on` (URL): enables the effect. **It is off by default.**
- `DITHER_STRENGTH` in `render.ts`: 0 gives flat color bands, higher values give noisier dithering. Currently `0.03` (was `0.12`, which showed as a visible mesh; `0` is fully flat).

## Current state of level rendering

`client/src/levelRender.ts`:
- Walls and floors: BONE, brightness varied slightly per box (`0.7 + shade * 0.4`) so boxes stay distinguishable.

`client/src/main.ts`:
- Background and fog: HAZE (fog from 100 m to 500 m: a light haze for depth, not a draw-distance limit. It was 30 m to 90 m while the map was 60 m across; on the 200 m map that hid everything past 90 m).
- Hemisphere light: BONE from above, GRAPHITE from below, intensity 1.2.
- Directional "sun": white, intensity 1.5.

Readability fixes from the screen-effect review (2026-10-12):
- Practice dummies (`dummyView.ts`): HAZARD body with a small HAZARD glow, INK head, BONE flash on hit. Their old orange snapped to grey and vanished.
- Gun (`fx.ts`): GRAPHITE and CONCRETE. Muzzle flash, tracers and impacts: HAZARD.
- Rule of thumb: any accent that must stay readable in shadow needs a little emissive, because lighting pushes it toward a neutral when snapped.

## Night, district signs and props (2026-10-13)

Tom: "FFA might be better if the map is night", and steps 3 and 4 of the plan for a map that looked plain.

- **Night** is a level's `sky: "night"` (the FFA map; the practice range stays day). `applySky` in `main.ts`: the sky and fog go to a colour between INK and GRAPHITE, the sky light and the "moon" are about half as strong as by day. It is moonlit, not dark: the world drops about one step down the palette and players stay easy to see. What stands out is everything unlit: the SIGNAL and ACID strips, the lamps, the far windows. There are stars.
  - Walkway tops had to become mid-grey for this: dark steel went black at night, and a player on it with it.
- **District signs:** the nine districts have compass codes (NW, N, NE, W, C, E, SW, S, SE). Each is painted 7 m tall on the perimeter wall behind its district, above the sector numbers, so you can find your bearings from anywhere by looking over the roofs; and on the ground of every avenue leading in, the letters' tops pointing into the district. INK, a 5x5 pixel font (three pixels is too narrow to tell N from W).
- **Props** are built from boxes in `client/src/levelDecor.ts` and are **not in the collision world**, so each kind is one nobody can walk into: lamp posts in the margin at every district corner (a SIGNAL head and a pale pool of light on the ground; the pole is 14 cm), a pair of pipes and a row of ventilation units round the inside of the perimeter wall, masts with a light on the wall, the towers and the cranes, a hook hanging under each crane beam, and beyond the wall a ring of dark towers with a few lit windows. Merged into one mesh per material.
- **Not done:** no real lights (the lamps' pools are painted discs); no glowing panels; nothing marks one district's buildings from its mirrored twin's except the signs.

## Surface details

Implemented in `client/src/surfaces.ts` (textures) and `client/src/levelRender.ts` (where they go).

- **Textures** are 64×64 canvases drawn in code, nearest-neighbor filtered. One tile = 2 m of world (`TILE_METRES`).
- **World-space UVs** (`applyWorldUvs`): textures tile by world position, so seams line up across boxes and nothing stretches.
- **Surface kinds** (2026-10-13): a level piece says what it is with `surface` in the level JSON, and is drawn with that kind's side and top texture (`SURFACES` in `client/src/surfaces.ts`). Until then every piece had the same wall panel and floor plate, and the FFA map looked plain though its layout was not. The kinds: `panel` (the perimeter, rooms, towers and wall-run walls: the two textures below), `concrete` (buildings: light, pour lines and tie holes; a dark gravel roof), `container` and `container-light` (corrugated steel with a stencil mark), `metal` (walkways: tread plate on top, a riveted girder at the side), `pillar` (an INK and BONE chequer band every 2 m), `crate` (planks), `barrier` (low walls: a BONE band), `stripe` (pit rims and kerbs: INK and BONE warning stripes), `ground` (studded paving; dark where it is cut away), `pit` (a dark floor), `ramp` (paving with ACID marks). Neutrals only, plus ACID on ramps.
  - Two things learned in the first look: solid CONCRETE walls go nearly black on their shadow side, so "concrete" is HAZE speckled with CONCRETE; and random specks on the ground read as static up close, so the paving is a regular stud pattern.
- **Wall panels** (box sides): BONE, INK seams on a 2 m grid, a HAZE split line, CONCRETE rivets and vent slats.
- **Floor plates** (box tops, ramps): HAZE, GRAPHITE seams, CONCRETE centre cross.
- **Painted numbers**: two-digit sector numbers (01, 02, …) in INK, from a 3×5 pixel font, on the inner face of tall long walls (height ≥ 6 m, length ≥ 20 m). For callouts.
- Warning stripes stay neutral or ACID: HAZARD stripes only where something is actually dangerous (rule 2).

Next for step 3: symbols (arrows, sector glyphs), INK/BONE stripes on ledges and step edges, a few panel variants so large walls don't look tiled.

## Characters

**Style: chunky armored heroes** (Luke's choice, 2026-10-12), in the spirit of classic action-game heroes like Mega Man: oversized round helmet, big boots and fists over a slim suit, flat two-tone colors, a visible face with big simple eyes. Take the *style*, never copy a specific character's design (copyrighted). The world stays Marathon "graphic realism"; the contrast between toy-like characters and a calm, grounded world helps characters read.

Modeled in **Blockbench** (see "Blockbench models" below) or built in code from boxes and low-poly cylinders, and animated in code (`client/src/character.ts`). The trooper is a Blockbench model; the assassin is still code-built.

- **Colors (trooper):** BONE armor with COBALT stripes (the team color), GRAPHITE suit and boots, a black INK visor, HAZE ear discs with SIGNAL lights. Flashes BONE when hit. (The first chunky trooper was HAZARD armor, the enemy color; Luke replaced it with this design.)
- **Fits the hitbox:** every part stays inside the 0.6 × 1.8 m box, and the whole head inside the head zone (1.5 to 1.8 m), so what you see is what you hit. The head can only be 0.3 m tall, so it looks big by being **wide** (0.38 m) instead. Never change the hitbox for looks; it's game logic in `sim/`.
- **Animations:** idle breathing and arm sway; walk cycle tied to distance moved (faces the walking direction); standing characters turn to face the player; hit flinch; fall backward on death; grow up from the floor on respawn.
- **Looks:** a character is a set of parts on shared joints (`CharacterLook` in `client/src/character.ts`), so every look has the same hitbox and animations. There are two, both Blockbench models: the **trooper** (white armor, blue team) and the **assassin** (dark, violet team), described under "Blockbench models". The game uses the trooper everywhere for now: there is no character select yet.
- **Looks:** a character is a set of parts on shared joints (`CharacterLook` in `client/src/character.ts`), so every look has the same hitbox and animations. There are two, both Blockbench models: the **trooper** (white armor, blue team) and the **assassin** (dark, violet team), described under "Blockbench models". The game uses the trooper everywhere for now: there is no character select yet.
- **Character viewer:** with the dev server running, open `http://localhost:5173/figure.html` (add `?res=240` for the retro look). 1 idle, 2 walk, 3 run, Space jump, C slide, H hit, K kill, B show hitbox (switches to the 1.0 m slide box while sliding), O orbit, arrows rotate and zoom. Dev only, not part of the game build.

## Blockbench models

Decided 2026-10-13 (Luke): characters are modeled in [Blockbench](https://www.blockbench.net/) as pixel-textured cubes; the **code keeps animating them** (walk/run blend, rifle IK, slide, death...). Blockbench animations are for later, for things code does badly (emotes, victory poses, special deaths).

**Files**
- Source: `art/blockbench/<look>.bbmodel` (open this in Blockbench to edit).
- Export: `client/src/models/<look>.glb` (what the game loads, via `client/src/characterModels.ts`).
- Check: `client/src/characterModels.test.ts` (bones on the joints, parts inside the hitbox).

**Rules for a character model**
1. Format **Generic Model**. **32 units = 1 metre** (so one Blockbench block, 16 units, is 0.5 m). The character faces **+Z** (south).
2. **One texture, 1 pixel per unit**, painted with **palette colors only** (exact hex values from the Palette table). HAZARD and COBALT pixels glow a little and SIGNAL pixels glow fully in game (worked out automatically from the texture), so use them only where the accent meanings allow.
3. **Whole-number cube sizes**, so pixels stay square.
4. **Bones (groups) named after the code joints**, pivots exactly here (units; `l` is the −X side, like `character.ts`):

   | Bone | Parent | Pivot |
   |---|---|---|
   | `body` | root | 0, 0, 0 |
   | `hip_l` / `hip_r` | body | ∓3.2, 29.44, 0 |
   | `upper` | body | 0, 29.44, 0 |
   | `head` | upper | 0, 45.44, 0 (parts hidden in first person) |
   | `shoulder_l` / `shoulder_r` | upper | ∓6.4, 44.16, 0 |
   | `elbow_l` / `elbow_r` | shoulder | ∓6.4, 35.2, 0 (the fist's middle must be 10.24 below, for the rifle grip) |

   Don't rotate bones in the rest pose; arms hang straight down.
5. **Inside the hitbox:** x and z within ±9.6, y from 0 to 57.6, the helmet between 48 and 57.6 (the head zone).
   **One exception, hats** (Luke, 2026-10-13): parts named `hat...` may reach ±13.4 sideways and 62.4 high (0.42 m and 1.95 m). Shots through a brim miss (it is decoration) and a tall hat can peek over cover.

**Editing workflow**
1. Open `art/blockbench/trooper.bbmodel`, edit, paint in the Paint tab, **File > Save**.
2. **File > Export > Export glTF Model**, with encoding **Binary**, **Scale 32**, textures embedded, armature off. Save over `client/src/models/trooper.glb`.
3. Run `pnpm --filter @arena/client test` (checks the rules above), then look at it in `/figure.html` (add `?res=240&fx=on` for the retro look).

**Trooper (Blockbench version):** follows Luke's second turnaround sheet (a white armored trooper, 2026-10-13), 37 cubes on a 128×128 texture. Round shapes are two crossed boxes (a wide-flat one and a narrow-tall one) plus a flat cap, so the corners read as cut off. A BONE dome helmet with a COBALT stripe from the front over the top to the back, a full-width INK visor slit with a CONCRETE glint, HAZE ear discs (INK ring, CONCRETE, SIGNAL light), one antenna on the left; a BONE chest with a CONCRETE centre seam and a small SIGNAL status light; BONE shoulder pads with COBALT outer edges; GRAPHITE suit, pants, gloves and boots; a CONCRETE belt with a HAZE buckle; BONE forearm plates and knee plates with COBALT stripes. BONE parts shade to HAZE at their lower edges. Limits from the hitbox: the head can't be as big as on the sheet (it must fit the 0.3 m head zone), so it is as wide as allowed instead. The first texture was generated by a script (exact palette colors, one UV net per cube); from now on, paint it in Blockbench.

**Assassin (Blockbench version):** follows Luke's turnaround sheet (2026-10-13), inspired by an aerial grappling-gear soldier and a wide-hatted swordswoman, without copying either. 36 cubes and 4 meshes (the two sheaths and their sheathed handles: see "The blade: katana") on a 256×256 texture. A big cone hat of stepped rings (GRAPHITE with INK radial seams, a BRASS rim), worn low over a dark mask with a SIGNAL V-shaped visor and a BRASS side strip; a BONE scarf wrapped high with a long tail down the back; layered GRAPHITE feather shoulders (INK feather lines); a GRAPHITE chest with INK plate seams over an INK suit; a VIOLET sash with two BRASS rings, tied at the back with two hanging ends; the grappling rig: a CONCRETE gas tank on each hip with a SIGNAL light and a strap, and a sheathed katana; GRAPHITE gauntlets, INK gloves; INK pants with strap bands; GRAPHITE boots with a BRASS top and L-shaped trim. Known issue: in the retro look the dark parts merge, so the shape reads but details get lost (a CONCRETE edge on the feathers would help).

## The rifle: Brick

`client/src/rifle.ts`. One model for both views (first-person viewmodel in `fx.ts`, third-person body in `character.ts`). Since 2026-10-14 it is a Blockbench model (`art/blockbench/rifle.bbmodel`, exported to `client/src/models/rifle.glb`): 51 mesh parts on a 128×128 texture. Before that it was built from boxes in code, and that older look is still the fallback when the model is not loaded (the unit tests). An assault rifle in the Apex R-301 / Flatline family: an open skeleton stock with a cheek pad, a two-tone receiver with a raked armour plate, a forward-raked magazine, an angular handguard with slanted vents over a slotted lower guard and an angled foregrip, a front sight post, a short barrel with a chunky muzzle brake, and a wedge-shaped holo sight on a toothed top rail.

- **How it is built:** each part is a side profile (a polygon, so edges can be raked and chamfered) given a thickness, and the gun's side is painted as one piece of pixel art that all parts share: panel lines, vents, edge highlights and shadows, the "101" stamp, brass rounds in the magazine. Both sides show the same painting mirrored, so use only marks that read the same mirrored.
- **Colors:** GRAPHITE lower receiver, stock and lower guard, CONCRETE upper receiver and muzzle brake, BONE armour (receiver plate, handguard shell, cheek pad, magazine, sight hood), INK details. One SIGNAL accent: the **ammo strip**, a light on each side of the receiver, in a black channel under the armour plate, that shrinks as the magazine empties and turns HAZARD and blinks at 25% or less (the reticle dot is SIGNAL too). BRASS only as a few pixels (trigger, rounds). HAZARD is otherwise only the muzzle flash.
- **Model rules:** 32 units per metre, facing north (-Z), exported as glTF binary with scale 32. A locator named `muzzle` marks the muzzle: the game places the whole model by it, so the model may sit anywhere in Blockbench. The moving parts are the bones `mag`, `slide`, `strip_l` and `strip_r` (`rifle.test.ts` checks these); the strips shrink toward their bone's pivot. Keep the sight's window (0.06 × 0.05 m, its middle 0.107 m above the bore) and the grip where they are: aiming and the hands depend on them.
- **Moving parts:** the charging handle on the armour plate kicks back on each shot; the magazine is its own group, pulled out and slotted back in during the reload (`reloadAnim.ts`).
- **Held by the body:** the character's arms are two bones (shoulder, elbow), and both hands are solved onto the rifle every frame (`solveArm` in `character.ts`), so the gun and hands stay together in every animation: slung while drawing, held low and ready, up at the shoulder when aiming, kicking on a shot. `armed` on the body state turns it on; turning it on plays a draw (`G` in the viewer).
- **Preview:** `/figure.html`, model "Brick (rifle)": idle, fire loop, reload loop, strip drain, low-ammo blink.
- **To tune:** the shape and colors in Blockbench (then export over `rifle.glb`); `LOW_AMMO` and `SLIDE_KICK` in `rifle.ts`.

## The sniper: Needle

`client/src/sniper.ts`. Since 2026-10-14 a Blockbench model (`art/blockbench/sniper.bbmodel`, exported to `client/src/models/sniper.glb`): 67 mesh parts on a 256×128 texture, built and painted the same way as the Brick and following the same model rules (a `muzzle` locator, the bones `mag`, `slide` (the bolt), `strip_l` and `strip_r`). The texture is wider than the Brick's because the gun is about 60% longer and both keep the same pixel size. The older box-built look in `sniper.ts` is the fallback when the model is not loaded (the unit tests).

- **Shape:** long and slim. A stock of two beams around a web with raked cut-outs, a raised cheek rest, a ribbed butt plate; a receiver stamped "808" with a bolt handle on the right; a short five-round magazine; a big scope (eyepiece ring, tube, turrets, a wide hooded front bell); a long handguard with slanted vents and a folded bipod; a thin fluted barrel with an angular muzzle brake.
- **Colors:** mostly BONE (stock beams, upper receiver, handguard, magazine) over GRAPHITE, with an INK and GRAPHITE scope, so it reads as the long white gun next to the compact two-tone Brick. SIGNAL only on the ammo strip (five rounds, HAZARD and blinking at two or fewer).
- **Scope:** hollow, so you can see through it when it is not aimed: every section (eyepiece housing, tube, front bell, hood) is four walls, with no lens. When aimed the game hides everything behind the eyepiece (`sightMask`), and the reticle is drawn in code. Keep the eyepiece ring where it is (its window 0.084 m square, its axis 0.12 m above the bore, at z = -0.2 m) and keep the scope body a little ahead of the ring's back face.
- **Preview:** `/figure.html`, model "Needle (sniper)", or the trooper with the weapon set to Needle.

## The blade: katana

`client/src/katana.ts`. The Assassin's blade is a katana, a Blockbench model (`art/blockbench/katana.bbmodel`, exported to `client/src/models/katana.glb`, 2026-10-14) built and painted the same way as the guns, on a 256×64 texture at their pixel size. One model for every place a blade is held: both fists in first person (`fx.ts`), both hands and the slash in third person (`character.ts`). Without the model (the unit tests) a blade is a plain BONE bar.

- **Sword (group `katana`):** a blade about 0.72 m long that curves up to an angled tip, HAZE with a CONCRETE spine and a wavy BONE band along the cutting edge; a GRAPHITE stepped guard with a BRASS collar; a handle in a VIOLET wrap (the Assassin's colour, like the sash) with BONE diamonds, a BRASS ornament and BRASS caps. A locator named `grip` marks the middle of the handle: the game holds the sword there, pointing -Z with the edge down.
- **Sheath (group `saya`):** INK, following the blade's curve, with BRASS fittings and a VIOLET cord. The katana file's copy is the reference; the ones the game shows are part of the Assassin's own model (below).
- **On the Assassin's hips:** `art/blockbench/assassin.bbmodel` has a sheath on each hip (`saya_l`, `saya_r`, in the `upper` bone), slanted with the mouth to the front and the end down behind the leg, and a sheathed handle and guard in each (`blade_l`, `blade_r`). The game hides `blade_l` / `blade_r` while that sword is in the hand, so the sheath stays on the hip, empty. Each of the four is one mesh; they are painted from a few flat swatches and a short handle strip in a free corner of the Assassin's texture (around x 0-35, y 100-105), at the character's pixel size. They must stay inside the hitbox like every other part.

## Thrown things: grenade and beacon

`client/src/grenade.ts`. The Trooper's frag grenade (Q) and the marker that calls the bombardment (F) are two colour schemes of one Blockbench model (2026-10-14; before that both were the same plain HAZARD cube): a canister about 18 cm tall with a chamfered body, a wide band round the middle, a neck with a small light, a fuze head, a lever down one side and a BRASS pin and ring. Both keep a wide HAZARD band, so both still read as danger for everyone. Each is its own file, built and painted like the guns on a 128×64 texture at their pixel size; the grooves and stripes are on the two side faces only.

- **Grenade** (`art/blockbench/grenade.bbmodel` → `client/src/models/grenade.glb`): GRAPHITE body with INK grooves on an INK base, black hazard stripes on the band, a BONE neck with a HAZARD light, a HAZE lever.
- **Beacon** (`art/blockbench/beacon.bbmodel` → `client/src/models/beacon.glb`): the same shapes in a BONE body with CONCRETE grooves, BONE chevrons pointing down on the band ("it comes from above"), a GRAPHITE neck with a SIGNAL light, a GRAPHITE lever. The server marks a bombardment's marker with flags 1 on its grenade entity (`callStrike` in `skills.go`), which is how the client knows to draw this one.
- **Model rule:** a locator named `centre` in the middle of the body: the model tumbles about it. Without the models (the unit tests) both are the old HAZARD cube.

## First-person arms

`client/src/hands.ts`: two box arms attached to the gun, so they follow aiming, recoil and future viewmodel animations. Their colours follow the hero you play (`ARM_LOOKS`), matching the body others see: the trooper has GRAPHITE gloves and BONE forearms with a COBALT cuff, the assassin INK gloves and GRAPHITE gauntlets with a BRASS cuff. The bare fists (punch, blades) share the same materials. Each arm is set by a hand position plus two angles (`pitch` tips the elbow down, `yaw` swings it sideways) and a forearm length; tweak those numbers to change the pose.

## Animation list

Owner: Luke. Add rows here before building them. **Who** is either the first-person view (arms, gun, camera) or the third-person body (how other players and dummies see you). Every animation is visual only and is driven by the player state the movement code already produces (`client/src/sim/types.ts`); never add animation code to `sim/`.

| Animation | Who | Triggered by (game state) | Notes | Status |
|---|---|---|---|---|
| Walking | first-person, body | on ground, moving, speed below about 6 m/s | Body: legs and arms swing, step bounce, stride 1.4 m. First-person: gentle gun bob | body: done · first-person: to do |
| Running | first-person, body | on ground, speed near `runSpeed` (11 m/s) | Body: blends from walk between 5 and 11 m/s; longer stride (2.6 m), forward lean, pumping arms. No sprint key: walk vs run is speed only | body: done · first-person: to do |
| Jumping | first-person, body | off the ground (`onGround` false); rising vs falling from vertical speed | Body: knee up and arms forward when rising, legs reach down and arms out when falling, squash on landing | body: done · first-person: to do |
| Sliding | first-person, body | `sliding` | Body: feet-first, sitting up, gun arm forward, other hand trailing; head and chest inside the 1.0 m slide hitbox, legs reach out in front | body: done · first-person: to do |
| Blade slash | body (assassin) | `meleeing` (the same melee as everyone: same damage, reach and timing) | Instead of the punch: the rifle drops to the left hand, the right hand draws the blade from the hip, raises it high, cuts down across the body and sheathes it (the hip blade hides while it is in the hand). `slashHand` and `RIG_LOOKS` in `character.ts` | done |
| Grappling cable | body (assassin) | `wallRunning`, plus which side the wall is on (`wallSide`: other players' bodies find it with a short ray each way, `remoteView.ts`) | A black (INK) cable shoots from the hip tank on the wall's side to a point up ahead on the wall in 0.12 s, stays out during the run and reels back in. Visual only: the wall run is the same for every look. Tune `CABLE_FROM`, `CABLE_TO` | done |
| Reload | first-person | weapon `reloadT` > 0 (lasts `reloadTime`, 1.8 s) | Gun tilts, left hand pulls the magazine down off screen, brings a new one, slots it in with a jolt. Keyframes in `client/src/reloadAnim.ts` | done (first-person); body: to do |

Body animations live in `client/src/character.ts` (one `CharacterBody` per character; poses are blended by weights that fade in about 0.1 s). It only needs a position each frame plus "on the ground?" and "sliding?", so other players will use it unchanged once they arrive over the network (not rendered yet). Test every body animation in the character viewer (`/figure.html`): 1 idle, 2 walk, 3 run, Space jump, C slide.

States the game has that may also need animations: dash (`dashTime` > 0), mantle (`mantling`), air jump (`airJumps` decreases), aim down sights (`ads`), fire, idle.

## Roadmap for the look (M8)

Build in this order. Each layer is visible on its own.

1. ~~Palette~~ (done)
2. ~~Screen effect: palette snapping and dither~~ (done, reviewed in game)
3. **Graphic surface details**: panel lines, warning stripes, large painted numbers and symbols, generated on small canvases (about 64×64) with nearest-neighbor filtering. This is the heart of the Marathon look. *(Started, see "Surface details" below.)*
4. **Light strips and glowing panels** in SIGNAL. *(Started 2026-10-13: `lightStrips` in `client/src/levelRender.ts`. SIGNAL strips along the edges of walkways (decks, catwalks, gates, bridges, crane beams) and over doorways and passages, from `glow` in the level JSON; ACID strips along both edges of every ramp. Unlit, visual only, merged into one mesh per colour. No glowing panels yet.)*
5. **Map pass 2**: real architecture (catwalks, pillars, doorways, stairs) as boxes and ramps in `levels/*.json`. Geometry changes affect gameplay, so agree on them with the team.
6. **Effects**: muzzle flash, tracers and hit sparks in HAZARD; particles; gun viewmodel.
7. **HUD and typography**: bold graphic HUD in the Marathon spirit.
8. **Sound**: gunfire, hits, footsteps, dash and slide. No audio code exists yet.

## Asset rules

- Prefer code-generated visuals. Free assets are fine when they fit the palette.
- Only use **CC0** assets, or **CC-BY** with credit. Record every asset in `CREDITS.md` (source, author, license).
- Never put visual code in `client/src/sim/` (shared deterministic game logic; see `AGENTS.md`).

## References

- Marathon art direction: [The Game Post](https://thegamepost.com/marathon-art-style-mirrors-edge-ghost-in-the-shell/), [80.lv](https://80.lv/articles/marathon-art-director-shares-the-team-s-creative-influences)
- Original brainstorm on art style: `spec/brainstorm/03-art-style.md`
- Milestone: `spec/phases/p1/m8.md`
