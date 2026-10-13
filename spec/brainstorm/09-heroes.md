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
| E | **Barrier.** A wall you place in front of you that stops bullets (both ways) | 2.5 m wide, 2 m tall; lasts 6 s or until it has taken 250 damage; 16 s cooldown |
| Ultimate | **Bombardment.** Mark an area; after a warning, shells fall on it | 8 m across; 2 s warning (a HAZARD ring everyone can see); 4 s of shells, about 40 damage per second inside; cannot be placed under a roof |

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
- **Where:** the pause screen (Esc, the overlay shown while the mouse is released) has a row of hero buttons. A click there chooses a hero and does not resume the game.
- **When it takes effect:** on your next life. It is immediate where it cannot be used to dodge a fight: in the practice range, outside a live match, while you are dead, and during spawn protection (so you can still pick just after joining or respawning). The picker says when a change is waiting for your next life.
- **Remembered:** the browser keeps your last choice and sends it when you join a room.
- **What others see:** each player's entity carries their hero, so everyone is drawn as the character they chose (your own body, when you look down, too).
- **Skills:** each hero has its own three on the same keys (Q, E, F); the HUD row shows the ones for the hero you are.
- **Not done:** the first-person arms and the hitbox are the same for every hero; there is no picker on the start screen.

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
- **Not done:** the Trooper still has rifle, sniper and fists (pistol not built); the spear launchers show as the sniper on other players' bodies.

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

## Open questions
- [x] **Can the Assassin shoot during a grapple pull?** Yes, with heavy spread (built that way).
- [ ] **How do ultimates charge?** Suggested: over time plus from damage dealt, so a losing player still gets one.
- [ ] **Do heroes differ in health or hitbox?** Suggested: no, identical for now (the models already share one hitbox).
- [ ] **Do players walk through the Trooper's barrier, or is it solid?** Solid is simpler to read but can be used to trap or block doors.
- [ ] **Does the grenade hurt the thrower?** Suggested: yes (it stops point-blank spam).
- [ ] **Slow on hit?** Apex slows a player who is shot (40% for 0.25 s, at most once every 3 s, same for every ammo type). Not decided for Arena; it would matter most against the Assassin.
- [x] **Hero picker:** on the pause screen (Esc), changeable any time; see "Hero picker: as built".

## What it costs
- **Grapple** is the expensive one: it is movement, so it is written twice (TypeScript and Go) and locked by test vectors, like every other move.
- **Slash, grenade, barrier, bombardment** are damage and objects, which the server already owns: cheaper.
- **Hero choice** is the prerequisite for a second hero: a character field from client to server, and a picker.
