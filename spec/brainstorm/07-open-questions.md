# 07. Open Questions

Move items to the relevant file's **Decided** section (and the README decision log) once answered.

## Game design
- [ ] **Death model:** downed + revive, beacon respawn, timed respawn, or a mix?
- [ ] **Win condition for control-point mode:** score target, timer, or final boss?
- [ ] **Number of teams:** about 5 (30 players), or more?
- [ ] **Roles:** identical players, or light classes (frontline / support / scout)?
- [ ] **Uneven teams:** fill with bots, or scale objectives and AI to team size?
- [ ] **Loot/upgrades:** a single score only, or pickups that change weapons mid-match?
- [ ] **Map:** one fixed hand-built map (easier), or procedural rooms?
- [ ] **Tone:** pure Ultrakill chaos, or more tactical (hide and ambush)?
- [ ] **Enemy roster:** a few fast, readable types or fewer, tougher ones?
- [ ] **Casual vs. competitive friend group:** how forgiving should balance be?
- [ ] **Which second mode** after control points (send-the-horde, boss race, ...)?

## Technical
- [ ] Binary protocol timing: when to leave JSON?
- [ ] Protocol codegen: which schema format (protobuf, custom, FlatBuffers)?
- [ ] Voxel/destructible terrain, or authored static maps only?
- [ ] Hosting: where do match servers run, and how are rooms allocated?
- [ ] Lobby / matchmaking service (could be Spring Boot) vs. everything in Go?
- [ ] Voice chat: rely on external (Discord) or build in?

## Later
- Accounts, stats, leaderboards
- Squad/party system
- Anti-cheat beyond server authority
