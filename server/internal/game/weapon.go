package game

// Weapon fire control, spread, recoil and damage: a line-for-line port of
// client/src/sim/weapon.ts. Both must agree on every vector in
// /testvectors/weapon. Any change here must update the TypeScript twin and the
// vectors in the same commit (`pnpm vectors`). Never allocates.

import (
	"math"

	"arena/server/internal/protocol"
)

// WeaponState is defined once in protocol/messages.json.
type WeaponState = protocol.WeaponState

const degToRad = math.Pi / 180

// weaponDef is what differs between guns. Slot 0 is the rifle (a projectile weapon), slot 1 the
// sniper (hitscan). Mirrors WEAPON_DEFS in client/src/sim/weapon.ts.
type weaponDef struct {
	hitscan         bool
	rpm             float64
	magSize         int
	reloadTime      float64
	damage          float64
	headshotMult    float64
	rng             float64 // range, metres
	hipSpread       float64
	adsSpread       float64
	moveBloom       float64
	airBloom        float64
	adsBloomScale   float64
	crouchHipMult   float64
	slideHipMult    float64
	slideBloomScale float64
	shotBloom       float64
	shotBloomMax    float64
	recoilResetTime float64
	recoilPitch     []float64
	recoilYaw       []float64
	adsSpeedMult    float64
}

var weaponDefs = [2]weaponDef{
	{
		hitscan: false, rpm: WeaponRpm, magSize: WeaponMagSize, reloadTime: WeaponReloadTime,
		damage: WeaponDamage, headshotMult: WeaponHeadshotMult, rng: WeaponRange,
		hipSpread: WeaponHipSpread, adsSpread: WeaponAdsSpread, moveBloom: WeaponMoveBloom, airBloom: WeaponAirBloom,
		adsBloomScale: WeaponAdsBloomScale, crouchHipMult: WeaponCrouchHipMult, slideHipMult: WeaponSlideHipMult,
		slideBloomScale: WeaponSlideBloomScale, shotBloom: WeaponShotBloom, shotBloomMax: WeaponShotBloomMax,
		recoilResetTime: WeaponRecoilResetTime, recoilPitch: WeaponRecoilPitch[:], recoilYaw: WeaponRecoilYaw[:], adsSpeedMult: WeaponAdsSpeedMult,
	},
	{
		hitscan: true, rpm: SniperRpm, magSize: SniperMagSize, reloadTime: SniperReloadTime,
		damage: SniperDamage, headshotMult: SniperHeadshotMult, rng: SniperRange,
		hipSpread: SniperHipSpread, adsSpread: SniperAdsSpread, moveBloom: SniperMoveBloom, airBloom: SniperAirBloom,
		adsBloomScale: SniperAdsBloomScale, crouchHipMult: SniperCrouchHipMult, slideHipMult: SniperSlideHipMult,
		slideBloomScale: SniperSlideBloomScale, shotBloom: SniperShotBloom, shotBloomMax: SniperShotBloomMax,
		recoilResetTime: SniperRecoilResetTime, recoilPitch: SniperRecoilPitch[:], recoilYaw: SniperRecoilYaw[:], adsSpeedMult: SniperAdsSpeedMult,
	},
}

// emptyHands is the slot value of no gun in hand.
const emptyHands = 2

// activeDef is the definition of the gun in hand, or nil for empty hands.
func activeDef(w *WeaponState) *weaponDef {
	if w.Slot == emptyHands {
		return nil
	}
	return &weaponDefs[w.Gun]
}

// movementMods is how the weapon in hand changes movement: empty hands run faster, and each gun
// has its own slowdown while aiming down sights. Mirrors movementMods in client/src/sim/weapon.ts;
// the server puts the result on every input before stepping the player.
func movementMods(w *WeaponState) (runSpeedMult, adsSpeedMult float64) {
	if d := activeDef(w); d != nil {
		return 1, d.adsSpeedMult
	}
	return WeaponEmptyRunMult, AdsSpeedMult
}

func (d *weaponDef) shotInterval() float64 { return 60.0 / d.rpm }

// WeaponContext is the movement state that affects spread.
type WeaponContext struct {
	HSpeed    float64 `json:"hSpeed"`
	OnGround  bool    `json:"onGround"`
	Crouching bool    `json:"crouching"`
	Sliding   bool    `json:"sliding"`
}

// ShotResult is what one weapon tick produced.
type ShotResult struct {
	Fired bool `json:"fired"`
	// SpreadYaw and SpreadPitch are this bullet's random offset from the view direction (radians).
	SpreadYaw   float64 `json:"spreadYaw"`
	SpreadPitch float64 `json:"spreadPitch"`
	// KickYaw and KickPitch are the view kick for the client to apply after the shot (radians).
	KickYaw        float64 `json:"kickYaw"`
	KickPitch      float64 `json:"kickPitch"`
	ReloadStarted  bool    `json:"reloadStarted"`
	ReloadFinished bool    `json:"reloadFinished"`
	// DryFire means the trigger was pulled on an empty magazine.
	DryFire bool `json:"dryFire"`
	// Switched: the weapon in hand changed this tick.
	Switched bool `json:"switched"`
	// MeleeStarted: a melee swing began this tick. MeleeStrike: it landed this tick (the caller
	// finds who it hit, see melee.go).
	MeleeStarted bool `json:"meleeStarted"`
	MeleeStrike  bool `json:"meleeStrike"`
}

// SpawnWeapon returns a full magazine with the given random seed.
func SpawnWeapon(seed uint32) WeaponState {
	if seed == 0 {
		seed = 1
	}
	return WeaponState{Ammo: WeaponMagSize, Stash: SniperMagSize, SinceShot: 1e9, Rng: seed}
}

// nextRandom is mulberry32: it returns a value in [0, 1) and the next state.
func nextRandom(state uint32) (float64, uint32) {
	t := state + 0x6d2b79f5
	next := t
	t = (t ^ (t >> 15)) * (t | 1)
	t ^= t + (t^(t>>7))*(t|61)
	return float64(t^(t>>14)) / 4294967296, next
}

// SpreadDegrees is the half-angle of the shot cone in degrees for the shot about to be fired.
func SpreadDegrees(burst uint8, ads bool, ctx *WeaponContext, d *weaponDef) float64 {
	spread := d.hipSpread
	if ads {
		spread = d.adsSpread
	}
	bloom := d.moveBloom * math.Min(1, ctx.HSpeed/RunSpeed)
	if !ctx.OnGround {
		bloom += d.airBloom
	}
	if ctx.Sliding {
		bloom *= d.slideBloomScale
	}
	if ads {
		bloom *= d.adsBloomScale
	}
	spread += bloom + math.Min(d.shotBloomMax, float64(burst)*d.shotBloom)
	// Crouching steadies hipfire a lot, sliding a little; aiming down sights is already tight.
	if !ads {
		if ctx.Crouching {
			spread *= d.crouchHipMult
		} else if ctx.Sliding {
			spread *= d.slideHipMult
		}
	}
	return spread
}

// StepWeapon advances the weapon by dt seconds in place. It reads Fire, Reload, Melee, Slot and ADS from in.
func StepWeapon(w *WeaponState, in *Input, ctx *WeaponContext, dt float64) ShotResult {
	var shot ShotResult

	w.SinceShot += dt
	resetTime := WeaponRecoilResetTime
	if d := activeDef(w); d != nil {
		resetTime = d.recoilResetTime
	}
	if w.SinceShot > resetTime {
		w.Burst = 0
	}
	w.Cooldown -= dt
	w.MeleeCooldown = math.Max(0, w.MeleeCooldown-dt)
	w.SwitchT = math.Max(0, w.SwitchT-dt)

	// Switch weapon: 1 rifle, 2 sniper, 3 empty hands. The old gun is put away (a reload is lost)
	// and the new one is ready after the draw. Each gun keeps its own rounds.
	want := int(in.Slot) - 1
	if want >= 0 && want <= emptyHands && want != int(w.Slot) {
		if want != emptyHands && want != int(w.Gun) {
			w.Ammo, w.Stash = w.Stash, w.Ammo
			w.Gun = uint8(want)
		}
		quick := want == emptyHands || int(w.Slot) == emptyHands
		w.Slot = uint8(want)
		if quick {
			w.SwitchT = WeaponSwitchQuickTime
		} else {
			w.SwitchT = WeaponSwitchTime
		}
		w.ReloadT = 0
		w.Burst = 0
		shot.Switched = true
	}
	def := activeDef(w)

	// Melee: press to swing; the blow lands after the wind-up, and firing is locked meanwhile.
	if w.MeleeT > 0 {
		w.MeleeT -= dt
		if w.MeleeT <= 0 {
			w.MeleeT = 0
			shot.MeleeStrike = true
		}
	} else if in.Melee && w.MeleeCooldown <= 0 {
		w.MeleeT = WeaponMeleeWindup
		w.MeleeCooldown = WeaponMeleeCooldown
		shot.MeleeStarted = true
	}
	swinging := w.MeleeCooldown > WeaponMeleeCooldown-WeaponMeleeLock
	ready := def != nil && w.SwitchT <= 0

	// Reload
	if w.ReloadT > 0 {
		w.ReloadT -= dt
		if w.ReloadT <= 0 {
			w.ReloadT = 0
			if def != nil {
				w.Ammo = uint8(def.magSize)
			}
			shot.ReloadFinished = true
		}
	} else if in.Reload && ready && int(w.Ammo) < def.magSize {
		w.ReloadT = def.reloadTime
		shot.ReloadStarted = true
	}

	// Fire
	if in.Fire && ready && w.ReloadT <= 0 && w.Cooldown <= 0 && !swinging {
		if w.Ammo > 0 {
			spread := SpreadDegrees(w.Burst, in.ADS, ctx, def) * degToRad
			u, r1 := nextRandom(w.Rng)
			v, r2 := nextRandom(r1)
			w.Rng = r2
			radius := spread * math.Sqrt(u) // uniform over the disc
			shot.Fired = true
			shot.SpreadYaw = radius * math.Cos(v*2*math.Pi)
			shot.SpreadPitch = radius * math.Sin(v*2*math.Pi)
			i := int(w.Burst)
			if i > len(def.recoilPitch)-1 {
				i = len(def.recoilPitch) - 1
			}
			shot.KickPitch = def.recoilPitch[i] * degToRad
			shot.KickYaw = def.recoilYaw[i] * degToRad
			w.Ammo--
			w.Burst++
			w.SinceShot = 0
			w.Cooldown += def.shotInterval()
		} else if w.ReloadT <= 0 {
			// Empty: start reloading automatically.
			shot.DryFire = true
			w.ReloadT = def.reloadTime
			shot.ReloadStarted = true
		}
	}
	if w.Cooldown < 0 && !shot.Fired {
		w.Cooldown = 0
	}
	return shot
}

// Damage returns the damage of one hit of the rifle (slot 0).
func Damage(headshot bool) float64 { return weaponDefs[0].damageOf(headshot) }

// damageOf is the damage of one hit of this gun.
func (d *weaponDef) damageOf(headshot bool) float64 {
	if headshot {
		return d.damage * d.headshotMult
	}
	return d.damage
}

// ViewDirection is the unit view direction. Yaw 0 and pitch 0 face -Z; positive pitch looks up.
func ViewDirection(yaw, pitch float64) (x, y, z float64) {
	cp := math.Cos(pitch)
	return -math.Sin(yaw) * cp, math.Sin(pitch), -math.Cos(yaw) * cp
}
