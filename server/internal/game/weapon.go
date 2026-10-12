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

const (
	degToRad     = math.Pi / 180
	shotInterval = 60.0 / WeaponRpm
)

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
}

// SpawnWeapon returns a full magazine with the given random seed.
func SpawnWeapon(seed uint32) WeaponState {
	if seed == 0 {
		seed = 1
	}
	return WeaponState{Ammo: WeaponMagSize, SinceShot: 1e9, Rng: seed}
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
func SpreadDegrees(burst uint8, ads bool, ctx *WeaponContext) float64 {
	spread := float64(WeaponHipSpread)
	if ads {
		spread = WeaponAdsSpread
	}
	bloom := WeaponMoveBloom * math.Min(1, ctx.HSpeed/RunSpeed)
	if !ctx.OnGround {
		bloom += WeaponAirBloom
	}
	if ctx.Sliding {
		bloom *= WeaponSlideBloomScale
	}
	if ads {
		bloom *= WeaponAdsBloomScale
	}
	spread += bloom + math.Min(WeaponShotBloomMax, float64(burst)*WeaponShotBloom)
	// Crouching steadies hipfire a lot, sliding a little; aiming down sights is already tight.
	if !ads {
		if ctx.Crouching {
			spread *= WeaponCrouchHipMult
		} else if ctx.Sliding {
			spread *= WeaponSlideHipMult
		}
	}
	return spread
}

// StepWeapon advances the weapon by dt seconds in place. It reads Fire, Reload and ADS from in.
func StepWeapon(w *WeaponState, in *Input, ctx *WeaponContext, dt float64) ShotResult {
	var shot ShotResult

	w.SinceShot += dt
	if w.SinceShot > WeaponRecoilResetTime {
		w.Burst = 0
	}
	w.Cooldown -= dt

	// Reload
	if w.ReloadT > 0 {
		w.ReloadT -= dt
		if w.ReloadT <= 0 {
			w.ReloadT = 0
			w.Ammo = WeaponMagSize
			shot.ReloadFinished = true
		}
	} else if in.Reload && w.Ammo < WeaponMagSize {
		w.ReloadT = WeaponReloadTime
		shot.ReloadStarted = true
	}

	// Fire
	if in.Fire && w.ReloadT <= 0 && w.Cooldown <= 0 {
		if w.Ammo > 0 {
			spread := SpreadDegrees(w.Burst, in.ADS, ctx) * degToRad
			u, r1 := nextRandom(w.Rng)
			v, r2 := nextRandom(r1)
			w.Rng = r2
			radius := spread * math.Sqrt(u) // uniform over the disc
			shot.Fired = true
			shot.SpreadYaw = radius * math.Cos(v*2*math.Pi)
			shot.SpreadPitch = radius * math.Sin(v*2*math.Pi)
			i := int(w.Burst)
			if i > len(WeaponRecoilPitch)-1 {
				i = len(WeaponRecoilPitch) - 1
			}
			shot.KickPitch = WeaponRecoilPitch[i] * degToRad
			shot.KickYaw = WeaponRecoilYaw[i] * degToRad
			w.Ammo--
			w.Burst++
			w.SinceShot = 0
			w.Cooldown += shotInterval
		} else if w.ReloadT <= 0 {
			// Empty: start reloading automatically.
			shot.DryFire = true
			w.ReloadT = WeaponReloadTime
			shot.ReloadStarted = true
		}
	}
	if w.Cooldown < 0 && !shot.Fired {
		w.Cooldown = 0
	}
	return shot
}

// Damage returns the damage of one hit.
func Damage(headshot bool) float64 {
	if headshot {
		return WeaponDamage * WeaponHeadshotMult
	}
	return WeaponDamage
}

// ViewDirection is the unit view direction. Yaw 0 and pitch 0 face -Z; positive pitch looks up.
func ViewDirection(yaw, pitch float64) (x, y, z float64) {
	cp := math.Cos(pitch)
	return -math.Sin(yaw) * cp, math.Sin(pitch), -math.Cos(yaw) * cp
}
