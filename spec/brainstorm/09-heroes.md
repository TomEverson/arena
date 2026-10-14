# 09. Heroes and Skills

Brainstorm from 2026-10-13. **Both heroes' skills are built** (same day; see "Trooper: as built" and "Assassin: as built" below). The character models exist (`client/src/character.ts`: trooper, assassin, plus the dummy base model), and **there is a hero picker** on the pause screen (see "Hero picker: as built").

## Decided
- **Heroes have skills.** This answers the "Roles" open question: light classes, one hero each, starting with two.
- **Three slots per hero:** Q (skill), E (skill), and an ultimate.
- **Two heroes to start:** the **Trooper** (all-rounder, holds ground) and the **Assassin** (fast, grapple and blades).
- **Trooper is built first.**
- **Assassin direction (Tom):** grapple gear in the style of Attack on Titan's ODM gear. Q grapples to a point and pulls you to it, usable twice in a row. E is a 180-degree sword slash, only in the air.

## The constraint that shapes everything
Every player already has two dashes, a double jump, a slide, wall running and wall jumping. A skill only gives a hero an identity if it does something that kit cannot.
- The grapple qualifies: long, straight travel to a point you choose.
- So the Trooper gets **no extra movement**. Its skills are about damage, cover and area.

## Trooper (first to build)
The all-rounder and the hero a new player picks: simple skills, about holding ground. Numbers are first guesses to tune in play. For scale: a player has 150 total health (100 + 50 shield) and the rifle kills in 1.5 to 2 s.

| Slot | Skill | First numbers |
|---|---|---|
| Q | **Frag grenade.** Thrown where you look, bounces, explodes on a fuse. Flushes people out of cover | 2 s fuse; about 80 damage at the centre falling to 0 at 5 m; hurts the thrower too; 12 s cooldown |
| E | **Barrier.** A wall you place in front of you that stops bullets (both ways) | 4.5 m wide, 3 m tall (2.5 by 2 at first; Tom: "should be larger"); lasts 6 s or until it has taken 250 damage; 16 s cooldown |
| Ultimate | **Bombardment.** Mark an area; after a warning, shells fall on it | 14 m across (8 m at first; Tom: "should be larger"); a 0.5 s warning (it had 2 s, then none, then Tom settled on "a bit of delay, maybe like 0.5"): the ring blinks and a short siren sounds, then the shells start; 2 s warning (a HAZARD ring everyone can see); 4 s of shells, about 40 damage per second inside; cannot be placed under a roof |

Why these:
- **Grenade:** everyone understands it, and it is the answer to a player sitting behind a kerb or in a room.
- **Barrier:** the Trooper's answer to a sniper, and a way to cross an avenue.
- **Bombardment:** clears a control point (the first team mode) and flushes snipers off the decks and roofs, which the 200 m map's sightline numbers suggest are strong. "Not under a roof" makes the arcades, rooms and tunnels the counter.

### Build order for the Trooper
Each step is playable on its own.
1. **Skill plumbing:** Q and E inputs in the protocol, a cooldown per slot in the weapon state (predicted on the client like the reload is), and cooldown icons on the HUD.
2. **Grenade:** a server-flown projectile, like bullets are today (`bullets.go`), with bounce and area damage.
3. **Barrier:** a temporary box in the collision world for bullets only (players walk through? see open questions), with health.
4. **Ultimate charge and Bombardment.**

Until there is a hero picker, everyone is the Trooper, so the Trooper's skills can be built and played before any character select exists.

### Trooper: as built
- **Keys:** Q grenade, E barrier, F bombardment. A HUD row above the weapon slots shows each cooldown and the ultimate's charge.
- **Answers used for the open questions:** the grenade hurts the thrower (a self-kill is a death, not a kill, and does not charge the ultimate); the barrier stops bullets only, players walk through; the ultimate charges over time (full in 90 s while the match is live) plus from damage dealt (600 damage for a full charge), and is kept through death.
- **Where the code is:** cooldowns in the weapon sim on both sides (`client/src/sim/weapon.ts`, `server/internal/game/weapon.go`, locked by the `weapon-skills` vector); everything else on the server in `server/internal/game/skills.go`; drawing in `client/src/skillView.ts`; numbers in `shared/params.json` under `skill`.
- **How clients see them:** each grenade, barrier and bombardment is an entity of its own kind in the normal snapshot. A grenade that stops being sent has gone off.
- **Bombardment rules:** aim at a surface within 80 m; the spot must have open sky; anyone in the circle with a roof overhead is spared. A failed call keeps the charge.
- **Practice range:** two recharge pickups (a turning SIGNAL box over a pad; beside the spawn and mid-range). Walk over one and both skills, the ultimate, the dashes and the melee are ready again; it comes back 3 s after being taken. Level data: `pickups[]` in `levels/greybox.json`.
- **No offline mode:** offline play was removed on 2026-10-13 so nothing has to be built twice. Skills exist only on the server; the practice range is an online room.
- **Not done:** grenades pass through barriers and other players; no throw or place animation on the body; not playtested, so every number is still a first guess.

### Hero picker: as built
- **Where:** the start screen (every way in, room links included, stops there first so the hero is chosen before the game starts) and the pause screen (Esc, the overlay shown while the mouse is released). A click on the pause screen's buttons chooses a hero and does not resume the game.
- **When it takes effect:** at once (changed 2026-10-14; it used to wait for the next life, which made switching in FFA feel broken). Mid-fight in a live match a change respawns you: a fresh life at a spawn point, like the dev respawn, with no death counted. Elsewhere (practice range, outside a live match, while dead, during spawn protection) the hero is swapped in place. The pause picker warns when a change would respawn you. Open question: switching heals you fully and moves you, so it can be used to escape a lost fight; a cost (a short delay, or counting it as a death) may be needed after playtesting.
- **Remembered:** the browser keeps your last choice and sends it when you join a room.
- **What others see:** each player's entity carries their hero, so everyone is drawn as the character they chose (your own body, when you look down, too).
- **Skills:** each hero has its own three on the same keys (Q, E, F); the HUD row shows the ones for the hero you are.
- **Not done:** the first-person arms and the hitbox are the same for every hero; the start-screen picker is a plain row of names (no portraits).

## Assassin
| Slot | Skill | First numbers |
|---|---|---|
| Q | **Grapple** (two charges). Hook a surface you are looking at and get pulled to it, keeping your speed when you let go | 30 m range; pull at 25 to 30 m/s; 6 to 8 s per charge |
| E | **Air slash.** A 180-degree sword arc in front of you with a short lunge; only while airborne | 3 m reach; about 70 damage (never a one-hit kill); 5 s cooldown |
| Ultimate | **Overdrive.** For a few seconds the grapple recharges almost at once and the slash has no cooldown, but the gun is put away | about 8 s |

Notes:
- **Straight pull first, not a swing.** A real ODM swing needs rope physics that must match exactly on client and server. Start with the pull; add the swing later if the pull is not enough.
- **Give the grapple a tell:** a visible line and a sound, so a good player can track and shoot the Assassin mid-pull.
- **Slash reset on a kill** is worth testing. It makes "grapple in, slash, grapple out" work, but it can snowball.
- **Overdrive** reuses the two skills, so it is cheap to build. The alternative considered was an explosive lance (AOT's thunder spear): more burst, less identity.
- **Name:** "ODM gear" is Attack on Titan's term. The in-game name must be our own.

### Assassin: as built
- **Q, grapple (reworked into a swing, see below):** two charges. Hooks the first solid surface in view within 50 m. First version, kept here for the record: it pulled you to the hook at 28 m/s with no gravity. **A second press in the middle of a pull adds a second hook without letting go of the first** (Tom, after trying a version where it replaced the first): the pull then goes up the middle of the V the two lines make, and lets go once you are between the hooks. With two hooks out, a third press (only possible in overdrive) drops the older one. A press with nothing in range costs nothing. A dash cancels it.
- **Q, the swing (Tom: "the entire kit should be Levi from AOT"; the straight pull felt locked):** a hook puts you on a line.
  - **On the line** gravity acts and you can steer, and the line will not let you get further from the hook than it is long: that is the swing.
  - **Hold Q** and the line reels you in (50 m/s² toward the hook, up to 30 m/s, with lighter gravity). **Let go of Q** and the line stays as long as it is: a pendulum.
  - **Leaving the line:** Space drops it with a hop, C drops it without, landing drops it (unless you are reeling), and so does reaching the hook. Reeling without getting closer for 0.3 s (circling a hook you cannot reach) drops it too. Your speed is kept in every case: the fling.
  - **Two hooks** still make a V: reeling goes up the middle and lets go once you are between them.
  - **Chaining:** a charge comes back in 3 s (was 7), each hook gives your air jump back and a kick toward it, and with two hooks out a new one replaces the older. So: hook, swing, fling, hook the next thing.
- **E, air slash:** only off the ground. Hits everyone within 3 m in the half circle in front, with a clear line, for 70; lunges you 9 m/s along your view; 5 s cooldown; a kill with it makes it ready again at once.
- **F, overdrive:** 8 s. Grapple charges are always full, the slash has no cooldown, and the gun is put away (holding fire does nothing).
- **Answers used for the open questions:** you can shoot during a pull, with 4 degrees of extra spread; the slash resets on a kill; health and hitbox are the same as the Trooper's.
- **Where the code is:** the grapple is movement, so it is in both movement sims (`client/src/sim/movement.ts`, `server/internal/game/movement.go`), locked by the `grapple-*` movement vectors (`grapple-v` is the two-hook pull). The slash's cooldown and overdrive's rules are in the weapon sims (`weapon-slash`, `weapon-overdrive` vectors). Who the slash hits, and overdrive's clock, are server-only (`skills.go`). So that both sides agree on whose skills the buttons are, every input carries `hero` and `overdrive`; the client sends what it believes and the server overwrites them.
- **What others see:** a grappling player has a flag and a "hook" entity at each point they are hooked to, drawn as a line each; the slash is shown with the melee swing.
- **Not done:** no blade model or slash arc in first person (it reuses the punch); no grapple or slash animation on the body; the in-game name is still just "Grapple"; not playtested, so every number is a first guess.

### Loadouts (Tom, 2026-10-13: "need to rework heroes")
Each hero gets its own three weapon slots.

| Slot | Trooper (planned) | Assassin (built) |
|---|---|---|
| 1 | Rifle | **Sniper** (the Needle) |
| 2 | Pistol | **Thunder spears** |
| 3 | Punch | **Blades** |

**Assassin, as built:**
- **Grapple (Q) works in every slot.**
- **Thunder spears:** a launcher on each arm, two spears in all, and a 4 s reload (2.8 s at first; Tom: "should be longer") with its own animation: both launchers drop and tip up, a fresh spear slides onto the left rail and then the right, and they come back level. A spear flies fast and nearly straight (70 m/s), sticks in the first thing it hits, and explodes one second later: up to 90 damage, falling to nothing at 4.5 m, the thrower included. Hitting a body also does 25 on impact. Stuck spears blink faster and faster.
- **Blades:** slot 3 is the hands. Left click (or V) is a cut for 40, against the Trooper's 20 punch, with the same reach and timing as a punch.
- **E is the spinning slash:** the air slash now hits all the way round, not only in front (Tom: "180/spinning slashes like from the series"). It works on the ground as well as in the air (it was air only at first). Still a lunge, still ready again on a kill.
- **F, overdrive,** now also holds you to the blades for its 8 s: it puts them in your hand and ignores slot presses. In overdrive the slash has no cooldown but cannot be spammed: the next one starts only when the current spin (0.45 s) is over, so it is one slash after another (Tom).
- **Where the code is:** loadouts are in the weapon sims (`LOADOUTS` / `loadouts`), locked by the `weapon-assassin-loadout` vector; the spear's flight and blast are server-only (`skills.go`); changing hero gives you that hero's weapons.
- **Two of everything (Tom):** a blade in each hand and a spear launcher on each arm, as in the series. The two spears are the two loaded rounds: a full pair shows one on each arm, and the left one fires first.
- **The spin is shown:** in first person the view turns right round once, flat like a fan (0.45 s; Tom: "around the plane, not vertically"; a first try rolled it), with both blades swept out to the sides; other players see the whole body turn once with a blade in each hand. The slash does not let go of a grapple: you spin on the line.
- **Melee with the blades** is a cut with both at once (out and up together, then in across each other), in first person and on the body; it was the right-fist punch. With the spear launchers the left hand is on the left launcher's grip, so it is held in two hands.
- **Not done:** the Trooper still has rifle, sniper and fists (pistol not built). (The spear launchers were drawn as the sniper on other players' bodies until they got a body model: see "Spear launchers: bigger" below.)

### Assassin controls, second pass (Tom, 2026-10-13)
"Disable the dash for Shift, and E will be Shift instead and it will move forward. There will not be a double jump. The new E is a downward 360 slash, like Sonic rolling: a dash in the air, or a slam down to the ground."

| Key | Assassin | Notes |
|---|---|---|
| Shift | **Spinning slash** (was E) | The flat fan spin, all the way round, 70 damage within 3 m, with a real dash straight ahead (the Trooper's dash: 26 m/s for 0.22 s; a first try was only a shove): this is the Assassin's dash. Ground or air. 5 s cooldown, ready again on a kill. It does not let go of a grapple. |
| E | **Rolling dive** (new) | Air only. You tumble forward and fly 26 m/s forward and down with no gravity until you hit something (0.9 s at most): a slam to the front (Tom). It follows your view but always points at least 40 degrees down, so looking level still brings you down ahead of you. Anyone the blades pass within 2.5 m of is cut for 60, once each. Hitting the ground ends it at once and hurts everyone within 4 m of the landing (up to 40, not you). Half the speed is kept. 6 s cooldown. It lets go of a grapple. |
| Q | Grapple | Unchanged. |
| F | Overdrive | Unchanged, except both blade skills come one after another: the only wait is for the move itself. |
| Space | One jump only | No double jump: the grapple and the dive are the Assassin's air movement. |

- The Trooper keeps its dash and double jump.
- **Where the code is:** the missing dash and air jump, and the dive's flight, are in the movement sims (vectors `assassin-no-dash`, `assassin-no-air-jump`, `roll-dive`, `roll-slam`); which button does what and the cooldowns are in the weapon sims (`weapon-slash` vector); who the dive cuts and the slam are server-only (`stepRoll` in `skills.go`). The slash's cooldown is the weapon state's `skillQT`, the dive's is `skillET`.
- **Shown as:** in first person the view tumbles forward right over once; other players see the body somersault about its hips.

### Dash cut replaces the spinning slash (Tom, 2026-10-13)
"I don't like spinning slash. How about dashing front and doing an X cut?"

| | Spinning slash (before) | Dash cut (now) |
|---|---|---|
| Move | the same dash straight ahead (26 m/s for 0.22 s) | unchanged |
| Who it hits | everyone within 3 m, all the way round, at the moment it starts | everyone the dash reaches in front of you within 2.5 m, once each, for as long as the dash lasts |
| Look | the view and the body turn right round once | no turn: both blades come up and out, then cut down across each other |

- Damage (70), cooldown (5 s), ready again on a kill, and the overdrive rules are unchanged. `slashSpin` (0.45 s) keeps its name: it is still the wait between cuts in overdrive.
- Someone just behind you is no longer hit; someone 6 m ahead now is, because the dash carries the blades to them.
- **Where the code is:** `stepSlash` in `skills.go` (it runs on each of the attacker's ticks during the dash, like the dive's `stepRoll`); the first-person cut is in `fx.ts`, the body's in `character.ts` (`crossHand`). The viewer lists it as "Dash cut (Shift)".
- **Wind-up (Tom: "pull the sword out, do the X, dash, unequip"):** the dash no longer starts on the press. The press starts a 0.3 s wind-up (`slashWindup`): the blades are drawn from the hips and cut the X. Then the dash fires, where you are looking at that moment, and cuts along its path; then the blades go back on the hips. The whole animation lasts 1 s (0.3 s and 0.45 s were "too fast"). The cooldown runs from the press. You can move and turn during the wind-up. Others are shown the wind-up too, so it is a tell.
- **Where the wind-up is:** in the weapon sims (`slashT` in the weapon state; `slashStarted` on the press, `slash` when the dash fires; vectors `weapon-slash` and `weapon-overdrive`).
- **Not done:** the arm paths are a first pass, checked on the body in the viewer only (drawn, crossed, dashing, sheathed); the first-person cut has not been looked at in play. In overdrive a new cut starts every 0.45 s, before the last dash has ended.

### Rolling dive: wind-up and a longer dive (Tom, 2026-10-13)
Tom: "it should be 2 s at least", then, asked which part: "both gameplay and wind-up like dash cut". Taken as: the dive may last up to 2 s, and it gets a wind-up like the dash cut's.

| | Before | Now |
|---|---|---|
| On pressing E (in the air) | the dive starts at once | a 0.3 s wind-up (`rollWindup`): the blades are drawn from the hips and held out ahead; then it dives, where you are looking at that moment |
| Longest dive (`rollTime`) | 0.9 s (about 23 m) | 2 s (about 52 m); it still ends on hitting the ground or a wall |
| Afterwards | nothing | the blades go back on the hips |

- Speed (26 m/s), damage (60 on the way, up to 40 for the slam) and the 6 s cooldown are unchanged; the cooldown runs from the press.
- **Landing during the wind-up calls the dive off** and the skill is ready again at once (a dive started on the ground would only slam your own feet).
- **In overdrive** the wait between dives is `rollTime`, so it is now 2 s, not 0.9 s.
- **Where the code is:** the wind-up is in the weapon sims (`diveT` in the weapon state; `rollStarted` on the press, `roll` when it dives; vector `weapon-slash`). Others are shown the wind-up by the `divePrep` entity flag. The body's animation is the dive phases in `character.ts`, the first-person one in `fx.ts`.
- **One full turn, landing on the feet (Tom: "it is now landing on head? dive, make a slash, land back on feet, full 360"):** the body no longer keeps tumbling for as long as it dives (a turn every 0.45 s, stopping wherever it was). It makes exactly one forward turn, paced to be complete at 85% of the way to the landing, so it comes down feet first. Between 40% and 70% of the turn both blades cut down across each other. The same in first person: one turn of the view, level again before the landing. A dive that ends before the turn is complete finishes it quickly (0.25 s a turn) instead of snapping upright.
- **How the pace is known:** a ray from the feet along the dive to the first wall or floor (`diveLeft` in `main.ts` for yourself, in `remoteView.ts` for others, from the way they are moving). With nothing ahead the turn takes 0.6 s.
- **Not done:** neither first-person animation has been looked at in play. The body was checked in the viewer from 10 m up: head down early in the dive, upright with the blades crossed just before it lands.

### The dive cuts harder from higher up (Tom, 2026-10-13)
"The damage will scale based on how high the dive originated. I want to reward the player that grapples higher to one-hit kill with E."

| Drop since the dive began | Cut damage |
|---|---|
| up to 5 m (`rollDropMin`) | 40 (`rollDamage`; it was 60 at any height) |
| 10 m | 62 |
| 15 m | 84 |
| 20 m | 106 |
| 25 m | 128 |
| 30 m and more (`rollDropFull`) | 150 (`rollDropMult` 3.75): a kill on full health and shield |

- **The numbers are Tom's:** a first version went from 60 at 5 m to 150 at 20 m; Tom: "height is still low... you can use the 26 m building to grapple up and gain height up to 30 m".
- **What is measured:** how far the diver has dropped from where the dive began to where the blades reach the victim. Diving from a tower onto someone on another tower earns little.
- **Only the cut scales.** The landing slam is unchanged (up to 40, to everyone within 4 m): an area hit that also grew would be too much. So a direct landing kills from about 21 m (110 + 40).
- For scale: most surfaces on the FFA map are under 7 m, the tallest are 16 m and 26 m, and the grapple reaches 50 m.
- **Where the code is:** server only (`diveDropMult` and `stepRoll` in `skills.go`).
- **Not done:** nothing on screen tells the diver how much the height is worth; not playtested, so the three numbers are a first guess.

### The line is kept when Q is let go on the ground (Tom, 2026-10-13)
"Grapple is cancelled when Q is no longer pressed, so I can't shoot two grapples at the same time. Don't cancel the grapple unless the user clicks jump."

- **The cause:** landing let the line go unless you were reeling. A hook fired from the ground leaves you on or near the ground, so letting go of Q (which you must, to press it again for the second hook) dropped the first.
- **Now:** being on the ground never lets the line go. With the button up you walk and run as usual on the line, and it still will not let you get further from the hook than it is long. So: Q for the first hook, let go, aim, Q for the second, hold to reel up between them.
- **Still lets go:** a jump (with a hop), a crouch (without), reaching the hook, reeling until you are between two hooks or stalled, the dive, and 6 s on the line (the clock only runs in the air or while reeling).
- **Where the code is:** both movement sims; vector `grapple-landing`.

### Grapple recharge: 6 s a charge (Tom, 2026-10-13)
"Make the grapple cooldown longer, and overdrive will remove the grapple cooldown too." A charge now comes back in 6 s (`grappleRegen`; it was 3 s, and 7 s before that), so both take 12 s, the same as the Trooper's dashes. Tom gave no number: 6 is a first guess. Overdrive already kept the grapple charges full for its 8 s; that is unchanged, and is checked by `TestOverdriveNeedsAChargeThenChainsSlashesFreesTheGrappleAndStowsTheGun`.

### Spear launchers: bigger, on the body, in the viewer (Tom, 2026-10-13)
"It should look like two RPGs, one on each arm, instead of pistols", and "add that in the model viewer, in both model and weapon".

- **The model (`client/src/spear.ts`):** each launcher is now a tube about a metre long and 11.5 cm across (it was a 60 cm rail on a pistol grip), with a flared back end, a heat shield, a grip and a fore grip, a sight, and a ring at the muzzle that kicks back on a shot. The spear loads from the front and its head sticks out of the muzzle.
- **The spear itself** is fatter too (a 14 cm head, was 7 cm; a 5 cm shaft, was 3 cm), in the tube and in flight.
- **On the body:** other players now see the pair, one launcher in each hand either side of the body. Before, a player holding the spears was drawn holding the sniper.
- **In the viewer:** "Spears (launchers)" is in the Model list (fire, reload and ammo loops at the spears' own pace: two shots, a 4 s reload) and in the Weapon list for a character.
- **Half size in your own view (`SPEAR_VIEW_SCALE`):** at full size the pair filled the screen (Tom: "blocking the entire pov, reduce it like 50%"). Each launcher is drawn at half size there, the two as far apart as before; the body and the viewer keep the full size.
- **Not done:** the first-person view has not been looked at in play by me. The reload animation slides each spear in from the front.

### Spear damage: a small hit, then a big blast that follows its victim (Tom, 2026-10-13)
"When it hits someone it will only deal 10 damage, but it will stick and will deal 150 explosive damage. Same for the ground: it will stick to the ground and the explosion will deal 150."

| | Before | Now |
|---|---|---|
| Hitting a body (`spear.damage`) | 25 | 10 |
| The blast (`spearDamage`) | up to 90, falling to nothing at 4.5 m | 150 to everyone within 4 m of it, nothing beyond (`spearCore` and `spearRadius` are both 4) |
| A spear stuck in a body | stayed where it hit, while they ran off | goes where they go; the blast is on them |

- **Stuck in someone:** they take the full 150 wherever they run in the 1 s fuse, on top of the 10: 160 in all, a kill from full health and shield. Nothing takes the spear out. If they die or leave first, it stays where it was and still goes off.
- **Stuck in the ground or a wall:** the full 150 to anyone within 4 m, nothing beyond and nothing through a wall (Tom: "make it deal 150 dmg on 4 m radius"; before that it fell off from a 2 m core out to 4.5 m).
- **The reach is shown:** a stuck spear has a HAZARD ring on the ground under it, as wide as the blast reaches there (`skillView.ts`). The blast is a ball round the spear, so one high on a wall marks a smaller circle. The ring follows a spear stuck in someone. The thrower is hurt by it too, as before. (At first the blast was full only right at the spot, so a spear in the ground at someone's feet did about 100; Tom: "blast is not dealing 150 dmg".)
- It also follows a practice target. A barrier is a wall: it sticks and stays.
- **Where the code is:** server only (`stepSpear` in `skills.go`).
- **Reload:** 6 s for the pair (`spear.reloadTime`; Tom, the same day, after the damage change: it was 4 s, then 8 s for a moment).
- **Not playtested:** a stuck spear is now a certain kill a second later.

### Spears bounce off bodies instead of sticking (Tom, 2026-10-14)
"Make spears not stick to target (maybe bounceback)." This replaces "goes where they go" above: a spear stuck in someone was a certain kill, and nothing they did mattered.

| | Before | Now |
|---|---|---|
| A spear hitting a body | stuck in them and was carried along; the blast was on them wherever they ran | does its 10, bounces back off them, drops and goes off where it lands |
| A spear hitting a wall, the ground or a barrier | sticks there | the same |

- **The bounce:** the 1 s fuse starts at the hit. The spear comes back the way it came at 3 m/s with a 3 m/s hop and falls fast (`spearBounceBack`, `spearBounceUp`, `spearBounceGravity` 20), so from chest height it lands about 1.5 m short of them after half a second, sticks there and goes off when the fuse ends (in the air, if it has not landed). After the bounce it passes through bodies and only stops at the level.
- **What it means:** standing still they still take the full 150 (it lands well inside 4 m). Moving off at once gets them clear: they have 1 s to be more than 4 m from where it lands. The 10 on impact is unchanged, and so are the blast, the HAZARD ring under the spear (it follows the spear as it drops) and the blinking.
- **Practice targets** are bodies: it bounces off them too. A barrier is still a wall.
- **Where the code is:** `stepSpear` in `skills.go`; tests `TestThunderSpearBouncesOffABodyAndCanBeEscaped` and `TestThunderSpearBouncedOffABodyStillBlastsThemIfTheyStay`.
- **Not playtested:** the bounce numbers are a first guess.

### Grapple cables: black, from the hip gear (Tom, 2026-10-14)
The grapple lines were SIGNAL and started near the hands (yours 0.35 m under the camera, other players' at chest height). They are now INK and start at the tanks of the hip gear, the first hook from the left tank and the second from the right, for you and for everyone else; yours come down with your hips when you crouch or slide. The rig's wall-run cable is INK too (it was CONCRETE). `main.ts` (where the lines start), `skillView.ts` (how they are drawn), `character.ts` (`CABLE_FROM`, the tank's place on the body).

### Overdrive: 10 s, and the spears work in it (Tom, 2026-10-13)
"While overdrive, the spear can also be used and its reload will be reduced by half. And make the overdrive duration 10 s instead."

- **10 s** (`overdriveSeconds`, was 8).
- **The spears can be held and fired.** Before, overdrive put the blades in your hand and ignored every slot. Now spears in hand stay in hand, and slots 2 (spears) and 3 (blades) both work. The sniper is still put away: holding it when overdrive starts gives you the blades, and its slot does nothing.
- **The spears reload in half the time** during overdrive (`overdriveReload` 0.5: 3 s for the pair, not 6). A reload already running when overdrive starts keeps its length.
- Unchanged: the dash cut and the dive come one after another, and the grapple charges are always full.
- **Where the code is:** the weapon sims (vector `weapon-overdrive-spears`).
- **Not playtested:** ten seconds of a spear pair every 3 s, each a 4 m blast for 150, is a lot.

## Open questions
- [x] **Can the Assassin shoot during a grapple pull?** Yes, with heavy spread (built that way).
- [ ] **How do ultimates charge?** Suggested: over time plus from damage dealt, so a losing player still gets one.
- [ ] **Do heroes differ in health or hitbox?** Suggested: no, identical for now (the models already share one hitbox).
- [ ] **Do players walk through the Trooper's barrier, or is it solid?** Solid is simpler to read but can be used to trap or block doors.
- [ ] **Does the grenade hurt the thrower?** Suggested: yes (it stops point-blank spam).
- [x] **Slow on hit?** Yes, built 2026-10-13 (see "Balance pass" below). Apex slows a player who is shot (40% for 0.25 s, at most once every 3 s, same for every ammo type).
- [x] **Hero picker:** on the start screen and the pause screen (Esc), changeable any time (mid-fight it respawns you); see "Hero picker: as built".

## Balance pass (2026-10-13)
Playtest feedback: "the rifle is useless when the Trooper can dash twice every 3 s". The rifle needs 13 body hits in a row (1.2 s with perfect aim, about 2.5 s in practice) and was the only gun with travel time, while a dash charge came back in 1.2 s.

| Change | Before | After |
|---|---|---|
| Dash regen (`dashRegenTime`) | 1.2 s per charge | 6 s per charge (12 s for both; Tom) |
| Dashes on a kill | nothing | both charges back (Tom) |
| Rifle bullet speed (`bulletSpeed`) | 300 m/s | 500 m/s (Tom) |
| Slow on hit (`hitSlowMult`, `hitSlowTime`) | none | a bullet (rifle or sniper) that hurts a player cuts their run speed to 60% for 0.3 s |

| Slide boost cooldown (`slideCooldown`) | 0.4 s | 2 s |
| Jump out of a slide (`slideJumpKeep`) | keeps all its speed | keeps 75%, never less than run speed |

| Sniper (`sniper.bulletSpeed`, `sniper.bulletGravity`) | hitscan: hits the moment it fires | a bullet at 800 m/s with the rifle's drop (8 m/s²); Tom asked for a projectile, the numbers are a first guess |

- **Sniper, as built:** it goes through the same server bullet code as the rifle (`bullets.go`), lag compensation included; each bullet remembers its gun for damage, range and drop. At 100 m it takes 0.125 s to arrive (a runner moves 1 m) and drops 6 cm. Its tracer is now a real bullet on screen; before, it was a streak drawn at 2000 m/s, gone within a frame.
- **Slide-jump, why:** chained slide-jumps held 14.8 m/s for ever (run speed is 8): the jump kept all the slide's speed, the air has no drag, and the boost was ready again at every landing. Measured after the change, over 20 s: spamming it gives 8.1 m/s, one slide-jump each time the boost is ready gives 9.0 m/s. The cooldown still runs from the end of a slide, so spamming never gets a second boost.
- **Slow on hit, as built:** each hit restarts the 0.3 s, so a tracked player stays slowed (there is no immunity window). It cuts the run speed on the ground and steering in the air; a dash, slide or grapple keeps its speed. The sniper slows as well (Tom; at first only the rifle did). Practice targets are not slowed.
- **Where the code is:** `slowT` is part of the player's movement state, so both movement sims count it down (vector `hit-slow`); the server sets it in `bulletHit` (`bullets.go`) and the victim's client picks it up from the next snapshot, like a melee knock. The dash reset is in `damage` (`combat.go`) and `damageTarget`.
- **Not done:** nothing on screen tells you that you are slowed; not playtested, so every number is a first guess.

## What it costs
- **Grapple** is the expensive one: it is movement, so it is written twice (TypeScript and Go) and locked by test vectors, like every other move.
- **Slash, grenade, barrier, bombardment** are damage and objects, which the server already owns: cheaper.
- **Hero choice** is the prerequisite for a second hero: a character field from client to server, and a picker.
