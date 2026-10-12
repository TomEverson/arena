import * as THREE from "three";

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

/**
 * Renders the scene into a small render target, then blits it to the canvas
 * with NearestFilter, letterboxed to keep the aspect ratio.
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
      new THREE.MeshBasicMaterial({ map: this.target.texture }),
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
