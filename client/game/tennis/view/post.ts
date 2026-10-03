import * as THREE from "three";

// Soft "early-2010s console" finish in one cheap chain:
//   scene → (MSAA target) → quarter-res downsample → 2-pass blur → composite to screen.
// The composite mixes the blur back in (more toward the top of the frame, where the background
// is), adds bloom from bright areas, a slightly washed-out warm grade and a vignette. The blur
// work runs at 1/16 of the pixels, so it costs little even on weak GPUs.

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const DOWNSAMPLE = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel; // source texel size
varying vec2 vUv;
void main() {
  // 4 bilinear taps = a 4x4 box: smooth, no shimmering when the camera moves.
  vec3 c = texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture2D(tSrc, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir; // texel step along the blur axis
varying vec2 vUv;
void main() {
  // 9-tap Gaussian folded into 5 bilinear fetches.
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
  c += texture2D(tSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture2D(tSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
  c += texture2D(tSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlur;
uniform float uSoft;
uniform float uDepthSoft;
uniform float uBloom;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tScene, vUv).rgb;
  vec3 b = texture2D(tBlur, vUv).rgb;

  // Soft focus everywhere, stronger up the frame where the stands and trees are.
  float soft = uSoft + uDepthSoft * smoothstep(0.5, 0.95, vUv.y);
  c = mix(c, b, soft);

  // Bloom: bright areas bleed light.
  c += max(b - 0.5, 0.0) * uBloom;

  // Grade: a little washed out and warm, blacks lifted.
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, 0.86);
  c = c * vec3(1.03, 1.0, 0.93) + vec3(0.018, 0.018, 0.014);

  // Vignette.
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * 0.5;

  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export interface PostSettings {
  /** Blur mixed in everywhere, 0..1. */
  soft: number;
  /** Extra blur toward the top of the frame (the distance), 0..1. */
  depthSoft: number;
  bloom: number;
}

export const DEFAULT_POST: PostSettings = { soft: 0.28, depthSoft: 0.5, bloom: 0.7 };

export class PostFX {
  private readonly scene: THREE.WebGLRenderTarget;
  private readonly small: THREE.WebGLRenderTarget;
  private readonly small2: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly down: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
  private readonly dir = new THREE.Vector2();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    settings: PostSettings = DEFAULT_POST,
  ) {
    const opts = { type: THREE.UnsignedByteType, depthBuffer: false } as const;
    // The scene target keeps sRGB storage so 8 bits are spent where the eye sees them.
    this.scene = new THREE.WebGLRenderTarget(1, 1, { samples: 4, colorSpace: THREE.SRGBColorSpace });
    this.small = new THREE.WebGLRenderTarget(1, 1, { ...opts, colorSpace: THREE.SRGBColorSpace });
    this.small2 = new THREE.WebGLRenderTarget(1, 1, { ...opts, colorSpace: THREE.SRGBColorSpace });

    const shader = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.down = shader(DOWNSAMPLE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.blur = shader(BLUR, { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } });
    this.composite = shader(COMPOSITE, {
      tScene: { value: this.scene.texture },
      tBlur: { value: this.small.texture },
      uSoft: { value: settings.soft },
      uDepthSoft: { value: settings.depthSoft },
      uBloom: { value: settings.bloom },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.composite);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Size in device pixels (the canvas drawing buffer). */
  setSize(width: number, height: number) {
    this.scene.setSize(width, height);
    const sw = Math.max(1, Math.round(width / 4));
    const sh = Math.max(1, Math.round(height / 4));
    this.small.setSize(sw, sh);
    this.small2.setSize(sw, sh);
    this.down.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const r = this.renderer;
    r.setRenderTarget(this.scene);
    r.render(scene, camera);

    this.pass(this.down, { tSrc: this.scene.texture }, this.small);
    const { width, height } = this.small;
    this.pass(this.blur, { tSrc: this.small.texture, uDir: this.dir.set(1 / width, 0) }, this.small2);
    this.pass(this.blur, { tSrc: this.small2.texture, uDir: this.dir.set(0, 1 / height) }, this.small);

    this.quad.material = this.composite;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }

  private pass(material: THREE.ShaderMaterial, uniforms: Record<string, unknown>, target: THREE.WebGLRenderTarget) {
    for (const [k, v] of Object.entries(uniforms)) {
      const u = material.uniforms[k];
      if (v instanceof THREE.Vector2) (u.value as THREE.Vector2).copy(v);
      else u.value = v;
    }
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  dispose() {
    for (const t of [this.scene, this.small, this.small2]) t.dispose();
    for (const m of [this.down, this.blur, this.composite]) m.dispose();
    this.quad.geometry.dispose();
  }
}
