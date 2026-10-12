import * as THREE from "three";

import { PALETTE } from "./palette";
import { letterbox, ndcToScreen } from "./viewport";

/**
 * Internal render height in pixels (16:9), upscaled with nearest-neighbor to the window.
 * Lower = chunkier. Try ?res=240 (very chunky), 360, 480, 540, 720 (default, barely pixelated).
 */
const DEFAULT_RENDER_HEIGHT = 720;

function requestedHeight(): number {
  const raw =
    typeof location === "undefined" ? null : new URLSearchParams(location.search).get("res");
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(1080, Math.max(120, n)) : DEFAULT_RENDER_HEIGHT;
}

export const RENDER_HEIGHT = requestedHeight();
export const RENDER_WIDTH = Math.round((RENDER_HEIGHT * 16) / 9);

/** ?fx=off disables the palette/dither screen effect, for comparison. */
const FX_ENABLED =
  typeof location === "undefined" || new URLSearchParams(location.search).get("fx") !== "off";

/** How far the dither pattern nudges a color before snapping. 0 = flat bands, higher = noisier. */
const DITHER_STRENGTH = 0.12;

/**
 * The screen effect (spec/art/style-guide.md): per low-res pixel, convert to sRGB,
 * add a 4x4 Bayer ordered-dither offset, then snap to the nearest palette color.
 */
function paletteMaterial(source: THREE.Texture): THREE.ShaderMaterial {
  const colors = Object.values(PALETTE).map((c) => {
    const srgb = { r: 0, g: 0, b: 0 };
    c.getRGB(srgb, THREE.SRGBColorSpace);
    return new THREE.Vector3(srgb.r, srgb.g, srgb.b);
  });
  return new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: source },
      uResolution: { value: new THREE.Vector2(RENDER_WIDTH, RENDER_HEIGHT) },
      uPalette: { value: colors },
      uDither: { value: DITHER_STRENGTH },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      #define PALETTE_SIZE ${colors.length}
      uniform sampler2D tScene;
      uniform vec2 uResolution;
      uniform vec3 uPalette[PALETTE_SIZE];
      uniform float uDither;
      varying vec2 vUv;

      const float BAYER[16] = float[16](
         0.0,  8.0,  2.0, 10.0,
        12.0,  4.0, 14.0,  6.0,
         3.0, 11.0,  1.0,  9.0,
        15.0,  7.0, 13.0,  5.0
      );

      vec3 linearToSrgb(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }

      void main() {
        // Which low-res pixel this is, so the pattern stays aligned to the chunky grid.
        ivec2 px = ivec2(floor(vUv * uResolution));
        vec3 color = linearToSrgb(texture2D(tScene, vUv).rgb);

        float threshold = (BAYER[(px.y % 4) * 4 + (px.x % 4)] + 0.5) / 16.0 - 0.5;
        color += threshold * uDither;

        vec3 best = uPalette[0];
        float bestDist = 1e9;
        for (int i = 0; i < PALETTE_SIZE; i++) {
          vec3 d = color - uPalette[i];
          float dist = dot(d, d);
          if (dist < bestDist) {
            bestDist = dist;
            best = uPalette[i];
          }
        }
        gl_FragColor = vec4(best, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * Renders the scene into a small render target, then blits it to the canvas
 * with NearestFilter, letterboxed to keep the aspect ratio. The blit applies
 * the palette/dither screen effect unless ?fx=off.
 */
export class RetroRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(75, RENDER_WIDTH / RENDER_HEIGHT, 0.1, 500);
  private readonly target: THREE.WebGLRenderTarget;
  private readonly blitScene = new THREE.Scene();
  private readonly blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(
    canvas: HTMLCanvasElement,
    private readonly scene: THREE.Scene,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.camera.rotation.order = "YXZ";

    this.target = new THREE.WebGLRenderTarget(RENDER_WIDTH, RENDER_HEIGHT, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });

    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      FX_ENABLED
        ? paletteMaterial(this.target.texture)
        : new THREE.MeshBasicMaterial({ map: this.target.texture }),
    );
    this.blitScene.add(quad);
    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
  }

  /** Where a world point appears on the page, in CSS pixels, or null if it is off screen or behind us. */
  toScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    this.camera.updateMatrixWorld();
    const p = new THREE.Vector3(x, y, z).project(this.camera);
    const el = this.renderer.domElement;
    return ndcToScreen(p.x, p.y, p.z, letterbox(el.width, el.height, RENDER_WIDTH, RENDER_HEIGHT));
  }

  render(): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.setViewport(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
    r.render(this.scene, this.camera);

    // Letterbox the low-res image into the full canvas.
    const cw = r.domElement.width;
    const ch = r.domElement.height;
    const box = letterbox(cw, ch, RENDER_WIDTH, RENDER_HEIGHT);
    r.setRenderTarget(null);
    r.setViewport(0, 0, cw, ch);
    r.setScissorTest(false);
    r.clear();
    r.setViewport(box.x, ch - box.y - box.h, box.w, box.h); // GL counts y from the bottom
    r.render(this.blitScene, this.blitCamera);
  }
}
