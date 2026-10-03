import * as THREE from "three";
import { COURT } from "../court";
import { Match, type Side } from "../match";
import { buildArena } from "./arena";
import { AthleteModel, CPU_LOOK, PLAYER_LOOK } from "./athlete";
import { Hud } from "./hud";
import { PostFX } from "./post";
import { makeRacquet, poseRacquet } from "./racquet";
import { w, wv } from "./space";
import { ballTexture, glowTexture, shadowTexture, skyTexture } from "./textures";

export interface CourtHooks {
  /** Whether the phone's Bounce button should be enabled. */
  onServeReady(ready: boolean): void;
  /** The player connected with the ball (good moment for a buzz). */
  onPlayerHit(): void;
}

const BALL_RADIUS = 0.09; // bigger than real, so it reads at the far end
const TRAIL = 5;
/** How far from the shoulder the racquet hand sits (a slightly bent arm). */
const ARM_REACH = 0.47;
const CPU_SWING_S = 0.42;
/** Render resolution bounds: start sharp, drop toward MIN if the device can't hold ~45 fps. */
const PIXEL_RATIO = { max: 1.25, min: 0.6, step: 0.2 };

const UP = new THREE.Vector3(0, 1, 0);

/** Swing keyframes for the computer, as racquet shaft directions in its own frame (right, up, forward). */
const CPU_SHAFT = {
  ready: [-0.1, 0.65, 0.75],
  back: [0.55, 0.3, -0.8],
  contact: [1, 0.1, 0.25],
  follow: [-0.6, 0.85, 0.25],
} as const;

export class CourtView {
  readonly match: Match;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 400);
  private readonly hud: Hud;
  private readonly post: PostFX;
  private readonly resize: ResizeObserver;

  private readonly player = new AthleteModel(PLAYER_LOOK, Math.PI);
  private readonly cpu = new AthleteModel(CPU_LOOK, 0);
  private readonly playerRacquet = makeRacquet(0x2f7de1);
  private readonly cpuRacquet = makeRacquet(0xe5532d);
  private readonly ball: THREE.Mesh;
  private readonly trail: THREE.Mesh[] = [];
  private readonly trailPos: THREE.Vector3[] = [];
  private flashes: { sprite: THREE.Sprite; age: number }[] = [];
  private readonly flashTex = glowTexture();
  private readonly shadows: { player: THREE.Mesh; cpu: THREE.Mesh; ball: THREE.Mesh };

  private raf = 0;
  private last = 0;
  private time = 0;
  private camX = 0;
  private camZ = 0;
  /** Computer's swing: seconds since contact (null when not swinging) and backswing amount. */
  private cpuSwing: number | null = null;
  private cpuPrep = 0;
  private pixelRatio: number;
  private slowFrames = 0;
  private sampledTime = 0;
  /** Soft-focus post chain; switched off if the device is still slow at the lowest resolution. */
  private usePost = true;
  private sampledFrames = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly hooks: CourtHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    // Antialiasing happens in the post chain's multisampled scene target instead.
    this.post = new PostFX(this.renderer);
    this.pixelRatio = Math.min(window.devicePixelRatio, PIXEL_RATIO.max);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "court-canvas";
    parent.append(this.renderer.domElement);
    this.hud = new Hud(parent);

    this.scene.background = skyTexture();
    this.scene.fog = new THREE.Fog(0xe2eef2, 34, 120); // haze on the trees and far stands
    // Soft, bright daylight: sky fill plus one sun high behind the camera so faces and backs are
    // both lit. No shadow maps; players and ball get blob shadows instead.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8fb070, 1.9));
    const sun = new THREE.DirectionalLight(0xfff6e8, 1.7);
    sun.position.copy(w(-6, 20, -8));
    this.scene.add(sun);

    buildArena(this.scene);
    this.scene.add(this.player.root, this.cpu.root, this.playerRacquet, this.cpuRacquet);

    const blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });
    const shadow = (size: number) => {
      const m = new THREE.Mesh(blob, blobMat);
      m.scale.setScalar(size);
      m.renderOrder = 0.5;
      this.scene.add(m);
      return m;
    };
    this.shadows = { player: shadow(1.1), cpu: shadow(1.1), ball: shadow(0.3) };

    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_RADIUS, 14, 10),
      new THREE.MeshLambertMaterial({ map: ballTexture(), emissive: 0x4a5500 }),
    );
    this.ball.visible = false;
    this.scene.add(this.ball);
    for (let i = 0; i < TRAIL; i++) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(BALL_RADIUS * (1 - i / (TRAIL + 2)), 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xf4ff9a, transparent: true, opacity: 0.45 * (1 - i / TRAIL), depthWrite: false }),
      );
      m.visible = false;
      this.trail.push(m);
      this.scene.add(m);
    }

    this.match = new Match({
      serveReady: (ready) => hooks.onServeReady(ready),
      hit: (by, kmh, power) => this.onHit(by, kmh, power),
      ballVisible: (v) => {
        this.ball.visible = v;
        this.trailPos.length = 0;
        if (!v) this.hud.setRally(0);
      },
      banner: (title, sub) => this.hud.banner(title, sub),
      pop: (text) => this.hud.pop(text, this.toScreen(this.player.headWorld())),
      score: (s) => this.hud.setScore(s),
    });

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(parent);
    this.fit();
    this.raf = requestAnimationFrame(this.frame);
  }

  setPaused(paused: boolean) {
    this.match.paused = paused;
    this.hud.setPaused(paused);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.hud.destroy();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        for (const m of [o.material].flat()) {
          (m as THREE.MeshBasicMaterial).map?.dispose();
          m.dispose();
        }
      }
    });
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private fit() {
    const { clientWidth: wpx, clientHeight: hpx } = this.parent;
    if (!wpx || !hpx) return;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(wpx, hpx, false);
    const buf = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post.setSize(buf.x, buf.y);
    this.camera.aspect = wpx / hpx;
    // Keep the whole court width in view on narrow screens.
    this.camera.fov = this.camera.aspect >= 1.5 ? 36 : 36 * Math.min(1.7, 1.5 / this.camera.aspect);
    this.camera.updateProjectionMatrix();
  }

  private frame = (t: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const raw = this.last ? (t - this.last) / 1000 : 1 / 60;
    const dt = Math.min(raw, 1 / 20);
    this.last = t;
    this.adaptResolution(raw);
    if (!this.match.paused) {
      this.time += dt;
      this.match.update(dt);
    }
    this.sync(this.match.paused ? 0 : dt);
    if (this.usePost) this.post.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
  };

  /** Weak GPU? Render fewer pixels: count slow frames over ~2 s windows and step down. */
  private adaptResolution(frameS: number) {
    if (document.hidden || frameS > 0.25) return; // tab switches and hitches don't count
    this.sampledFrames++;
    this.sampledTime += frameS;
    if (frameS > 1 / 45) this.slowFrames++;
    if (this.sampledFrames < 60) return;
    if (this.slowFrames > 20) {
      // Way too slow (under ~24 fps): go straight to the lowest resolution instead of stepping.
      const crawling = this.sampledTime / this.sampledFrames > 1 / 24;
      if (this.pixelRatio > PIXEL_RATIO.min) {
        this.pixelRatio = crawling ? PIXEL_RATIO.min : Math.max(PIXEL_RATIO.min, this.pixelRatio - PIXEL_RATIO.step);
        this.fit();
      } else {
        this.usePost = false;
      }
    }
    this.sampledFrames = this.slowFrames = this.sampledTime = 0;
  }

  // ---------- per-frame sync ----------

  private sync(dt: number) {
    const m = this.match;
    const ms = this.time * 1000;
    this.player.root.position.copy(w(m.player.x, 0, m.player.z));
    this.cpu.root.position.copy(w(m.cpu.x, 0, m.cpu.z));
    const look = this.ball.visible ? this.ball.position : null;
    this.player.setLookTarget(look);
    this.cpu.setLookTarget(look);
    this.player.update(dt, ms, m.player.vx, -m.player.vz);
    this.cpu.update(dt, ms, m.cpu.vx, -m.cpu.vz);

    // The player's racquet is the phone: same axes, no smoothing.
    const shaft = wv(m.racquetAxes.shaft);
    const strings = wv(m.racquetAxes.strings);
    this.holdRacquet(this.player, this.playerRacquet, shaft, strings, new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1));
    this.syncCpuRacquet(dt);
    this.syncBall(dt);
    this.syncShadows();
    this.syncCamera(dt);
    this.syncFlashes(dt);

    this.hud.setRally(m.rally);
    this.hud.setMarker(m.phase === "ready" ? this.toScreen(this.player.headWorld()) : null);
  }

  /** Arm reaches to where a hand holding the racquet this way would be; racquet sits in the hand. */
  private holdRacquet(
    model: AthleteModel,
    racquet: THREE.Object3D,
    shaft: THREE.Vector3,
    strings: THREE.Vector3,
    right: THREE.Vector3,
    fwd: THREE.Vector3,
  ) {
    const S = model.shoulderWorld();
    const reach = right
      .clone()
      .multiplyScalar(0.2)
      .addScaledVector(fwd, 0.15)
      .addScaledVector(UP, -1)
      .addScaledVector(shaft, 0.9);
    const hand = S.clone().addScaledVector(reach.normalize(), ARM_REACH);
    hand.y = Math.max(0.2, hand.y);
    const pole = right.clone().multiplyScalar(0.6).addScaledVector(UP, -1).addScaledVector(fwd, -0.6);
    model.reach(hand, pole);
    poseRacquet(racquet, model.handWorld(), shaft, strings);
  }

  private syncCpuRacquet(dt: number) {
    const m = this.match;
    // Take the racquet back once the ball has bounced on our side and is coming.
    const coming = m.lastHitter === "player" && m.bouncesSinceHit === 1 && (m.phase === "rally");
    this.cpuPrep = THREE.MathUtils.clamp(this.cpuPrep + (coming ? dt / 0.3 : -dt / 0.4), 0, 1);

    const k = (v: readonly number[]) => new THREE.Vector3(...v).normalize();
    let dir: THREE.Vector3;
    if (this.cpuSwing !== null) {
      this.cpuSwing += dt;
      const t = this.cpuSwing / CPU_SWING_S;
      if (t < 0.3) dir = slerpDir(k(CPU_SHAFT.contact), k(CPU_SHAFT.follow), t / 0.3);
      else if (t < 1) dir = slerpDir(k(CPU_SHAFT.follow), k(CPU_SHAFT.ready), (t - 0.3) / 0.7);
      else {
        this.cpuSwing = null;
        dir = k(CPU_SHAFT.ready);
      }
    } else {
      dir = slerpDir(k(CPU_SHAFT.ready), k(CPU_SHAFT.back), easeInOut(this.cpuPrep));
    }

    // Local (right, up, forward) → world. The model's right hand is on its -x.
    const right = this.cpu.toWorldDir(-1, 0, 0);
    const fwd = this.cpu.toWorldDir(0, 0, 1);
    const shaft = right
      .clone()
      .multiplyScalar(dir.x)
      .addScaledVector(UP, dir.y)
      .addScaledVector(fwd, dir.z);
    let strings = new THREE.Vector3().crossVectors(shaft, fwd);
    if (strings.lengthSq() < 1e-3) strings = right.clone();
    this.holdRacquet(this.cpu, this.cpuRacquet, shaft, strings.normalize(), right, fwd);
  }

  private syncBall(dt: number) {
    const b = this.match.ball;
    if (!this.ball.visible) {
      for (const t of this.trail) t.visible = false;
      return;
    }
    this.ball.position.copy(w(b.pos.x, b.pos.y + BALL_RADIUS * 0.5, b.pos.z));
    const v = wv(b.vel);
    const speed = v.length();
    if (speed > 0.1) this.ball.rotateOnWorldAxis(new THREE.Vector3().crossVectors(UP, v).normalize(), (speed * dt) / BALL_RADIUS / 3);

    if (dt > 0) {
      this.trailPos.unshift(this.ball.position.clone());
      this.trailPos.length = Math.min(this.trailPos.length, TRAIL + 1);
    }
    const fast = speed > 9;
    this.trail.forEach((t, i) => {
      const p = this.trailPos[i + 1];
      t.visible = fast && !!p;
      if (p) t.position.copy(p);
    });
  }

  private syncShadows() {
    const m = this.match;
    this.shadows.player.position.copy(w(m.player.x, 0.012, m.player.z));
    this.shadows.cpu.position.copy(w(m.cpu.x, 0.012, m.cpu.z));
    const s = this.shadows.ball;
    s.visible = this.ball.visible;
    if (s.visible) {
      const h = Math.max(0, m.ball.pos.y);
      s.position.copy(w(m.ball.pos.x, 0.014, m.ball.pos.z));
      s.scale.setScalar(0.28 + h * 0.06); // grows as the ball rises: a cheap height cue
    }
  }

  private syncCamera(dt: number) {
    // High behind the near baseline looking down the whole court, drifting a little with the
    // player so they stay framed.
    const p = this.match.player;
    const k = Math.min(1, dt * 2.5);
    this.camX += (p.x * 0.35 - this.camX) * k;
    this.camZ += (Math.min(p.z, COURT.netZ) * 0.35 - this.camZ) * k;
    this.camera.position.copy(w(this.camX, 7.6, this.camZ - 9.6));
    this.camera.lookAt(w(this.camX * 0.4, 0, COURT.netZ - 3.2 + this.camZ));
  }

  private onHit(by: Side, kmh: number, power: number) {
    this.hud.setSpeed(kmh);
    this.flash();
    if (by === "player") this.hooks.onPlayerHit();
    else {
      this.cpuSwing = 0;
      this.cpuPrep = 0;
    }
  }

  private flash() {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    s.position.copy(this.ball.position);
    s.scale.setScalar(0.3);
    this.scene.add(s);
    this.flashes.push({ sprite: s, age: 0 });
  }

  private syncFlashes(dt: number) {
    this.flashes = this.flashes.filter((f) => {
      f.age += dt;
      const t = f.age / 0.25;
      if (t >= 1) {
        this.scene.remove(f.sprite);
        f.sprite.material.dispose();
        return false;
      }
      f.sprite.scale.setScalar(0.3 + t * 1.2);
      f.sprite.material.opacity = 1 - t;
      return true;
    });
  }

  private toScreen(p: THREE.Vector3) {
    const v = p.clone().project(this.camera);
    const { clientWidth: wpx, clientHeight: hpx } = this.parent;
    return { x: ((v.x + 1) / 2) * wpx, y: ((1 - v.y) / 2) * hpx };
  }
}

function slerpDir(a: THREE.Vector3, b: THREE.Vector3, t: number) {
  const q = new THREE.Quaternion().setFromUnitVectors(a, b);
  return a.clone().applyQuaternion(new THREE.Quaternion().slerp(q, t));
}

const easeInOut = (t: number) => t * t * (3 - 2 * t);
