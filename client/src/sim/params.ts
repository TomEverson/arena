/**
 * Movement tuning. Every number the feel depends on lives here.
 * Changing any of these changes movement: update /testvectors and the Go twin.
 */
export const PARAMS = {
  // Body
  halfWidth: 0.3,
  standHeight: 1.8,
  slideHeight: 1.0,
  standEye: 1.6,
  slideEye: 0.8,

  // Ground movement (Quake-style accelerate)
  runSpeed: 11,
  groundAccel: 10,
  groundFriction: 8,
  stopSpeed: 3,

  /** Ground speed multiplier while aiming down sights. */
  adsSpeedMult: 0.65,

  // Air
  airAccel: 4,
  gravity: 30,
  terminalVelocity: 60,
  jumpSpeed: 9.5,
  /** Extra jumps allowed while airborne (1 = double jump). Refilled on landing. */
  maxAirJumps: 1,
  airJumpSpeed: 9.5,
  coyoteTime: 0.1,
  jumpBufferTime: 0.1,

  // Collision
  stepHeight: 0.4,
  rampStep: 0.5,
  snapDown: 0.35,
  groundEps: 0.02,
  /** Max distance moved per collision sub-step, to prevent tunnelling. */
  maxSubstep: 0.2,

  // Slide
  slideMinSpeed: 5,
  slideSpeed: 15,
  slideDecel: 6,
  slideEndSpeed: 4,
  slideMaxTime: 1.6,
  slideCooldown: 0.4,
  /** Walk speed while stuck low under a ceiling (cannot stand). */
  crouchSpeed: 5,

  // Dash
  dashCharges: 2,
  dashSpeed: 26,
  dashDuration: 0.22,
  dashExitSpeed: 13,
  /** Seconds to regenerate one charge. */
  dashRegenTime: 1.2,

  // Climb (hold jump facing a climbable surface)
  climbSpeed: 5,
  /** How close to the wall counts as touching it. */
  climbReach: 0.1,
  /** How squarely the player must face the wall (cosine). */
  climbFacing: 0.5,
  /** Pull over the top automatically once the feet are this close below it. */
  climbTopOut: 1.0,

  // Mantle
  mantleReach: 2.3,
  mantleDuration: 0.25,
  mantleInset: 0.15,
  mantleExitSpeed: 4,
} as const;

/**
 * Assault rifle tuning. Combat math lives in weapon.ts / hitscan.ts and will be
 * ported to the Go server in M5, so keep it pure and numeric.
 * Angles are in degrees here and converted to radians where used.
 */
export const WEAPON = {
  // Damage
  damage: 9,
  headshotMult: 1.5,
  /** Hits above this height (metres above the feet) are headshots. */
  headMinHeight: 1.5,
  maxHealth: 100,
  maxShield: 50,

  // Fire control
  rpm: 600,
  magSize: 30,
  reloadTime: 1.8,
  range: 250,

  // Spread: half-angle of the cone shots land in
  hipSpread: 2.0,
  adsSpread: 0.15,
  /** Extra spread at full run speed (scaled down while ADS). */
  moveBloom: 1.2,
  airBloom: 0.8,
  adsBloomScale: 0.3,
  /** Extra spread per consecutive shot, up to shotBloomMax. */
  shotBloom: 0.04,
  shotBloomMax: 0.6,

  // Recoil: the view is kicked by pattern[n] on the n-th consecutive shot.
  // The player pulls the mouse down/sideways to counter it.
  recoilResetTime: 0.35,
  recoilPitch: [
    0.5, 0.48, 0.46, 0.44, 0.42, 0.4, 0.38, 0.36, 0.34, 0.32, 0.28, 0.28, 0.28, 0.28, 0.28, 0.28,
    0.28, 0.28, 0.28, 0.28, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22,
  ],
  recoilYaw: [
    0, 0.05, 0.1, 0.12, 0.1, 0.05, -0.05, -0.12, -0.2, -0.22, -0.15, -0.05, 0.08, 0.18, 0.25, 0.28,
    0.2, 0.1, -0.05, -0.15, -0.25, -0.3, -0.2, -0.05, 0.1, 0.2, 0.3, 0.25, 0.1, -0.1,
  ],

  // Aim down sights
  adsFovScale: 0.7,
  /** Look sensitivity multiplier while ADS. */
  adsSensitivity: 0.7,
} as const;
