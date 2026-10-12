import * as THREE from "three";

/** Internal render resolution (16:9). Upscaled with nearest-neighbor to the window. */
export const RENDER_WIDTH = 427;
export const RENDER_HEIGHT = 240;

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

  render(): void {
    const r = this.renderer;
    r.setRenderTarget(this.target);
    r.setViewport(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
    r.render(this.scene, this.camera);

    // Letterbox the low-res image into the full canvas.
    const cw = r.domElement.width;
    const ch = r.domElement.height;
    const scale = Math.min(cw / RENDER_WIDTH, ch / RENDER_HEIGHT);
    const vw = Math.floor(RENDER_WIDTH * scale);
    const vh = Math.floor(RENDER_HEIGHT * scale);
    r.setRenderTarget(null);
    r.setViewport(0, 0, cw, ch);
    r.setScissorTest(false);
    r.clear();
    r.setViewport(Math.floor((cw - vw) / 2), Math.floor((ch - vh) / 2), vw, vh);
    r.render(this.blitScene, this.blitCamera);
  }
}
