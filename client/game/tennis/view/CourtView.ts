import * as THREE from "three";
import { COURT } from "../court";
import { Match, type Shot, type Side, type Stroke } from "../match";
import { buildArena } from "./arena";
import { type AthleteAsset, AthleteModel, CPU_LOOK, PLAYER_LOOK } from "./athlete";
import { CourtAudio } from "./audio";
import { DebugOverlay } from "./debug";
import { Hud } from "./hud";
import { PostFX } from "./post";
import { makeRacquet, poseRacquet, RACQUET_HEAD } from "./racquet";
import { CONTACT_U, StrokeAnim } from "./stroke";
import { w, wv } from "./space";
import { ballTexture, glowTexture, shadowTexture, skyTexture } from "./textures";

export interface CourtHooks {
  /** Whether the phone's Bounce button should be enabled. */
  onServeReady(ready: boolean): void;
  /** The player connected with the ball (good moment for a buzz); `quality` 0..1. */
  onPlayerHit(quality: number): void;
}

const BALL_RADIUS = 0.09; // bigger than real, so it reads at the far end
const TRAIL = 5;
/** How far from the shoulder the racquet hand sits, as a share of the arm (a slightly bent arm). */
const ARM_REACH = 0.85;
/** The stroke path overrides at most this much of the phone-driven hand position. */
const PLAYER_PATH_WEIGHT = 0.8;
/** Freeze-frame on impact (s): longer for big, clean hits. */
const HIT_STOP = { min: 0.035, max: 0.065 };
/** Ball squash on impact: how much, and how long it takes to spring back (s). */
const SQUASH = { hit: 0.42, bounce: 0.3, time: 0.08 };
/** Render resolution bounds: start sharp, drop toward MIN if the device can't hold ~45 fps. */
const PIXEL_RATIO = { max: 1.25, min: 0.6, step: 0.2 };

const UP = new THREE.Vector3(0, 1, 0);

/** One side's animation state beyond the body simulation. */
interface Racket {
  model: AthleteModel;
  racquet: THREE.Object3D;
  anim: StrokeAnim;
  /** Where the ball was struck (scene), held for the contact snap until the swing ends. */
  hitAt: THREE.Vector3 | null;
  /** The plan we already stepped in for (so the front foot plants once). */
  planted: object | null;
}

export class CourtView {
  readonly match: Match;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(44, 16 / 9, 0.1, 400);
  private readonly hud: Hud;
  readonly debug: DebugOverlay;
  private readonly post: PostFX;
  private readonly resize: ResizeObserver;

  private readonly player: AthleteModel;
  private readonly cpu: AthleteModel;
  private readonly playerRacquet = makeRacquet(0x2f7de1);
  private readonly cpuRacquet = makeRacquet(0xe5532d);
  private readonly ball: THREE.Mesh;
  /** Holds the ball mesh; squashes along an axis on impact. */
  private readonly ballHolder = new THREE.Group();
  private squash = { amount: 0, age: 1, axis: new THREE.Vector3(0, 1, 0) };
  readonly audio: CourtAudio;
  private readonly sides: Record<Side, Racket>;
  /** Hit-stop time left (s), and the camera's impact kick (decays to 0). */
  private hitStop = 0;
  private kick = 0;
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
  private pixelRatio: number;
  private slowFrames = 0;
  private sampledTime = 0;
  /** Soft-focus post chain; switched off if the device is still slow at the lowest resolution. */
  private usePost = true;
  private sampledFrames = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly hooks: CourtHooks,
    athlete: AthleteAsset,
    audio?: AudioContext,
  ) {
    this.player = new AthleteModel(athlete, PLAYER_LOOK, Math.PI);
    this.cpu = new AthleteModel(athlete, CPU_LOOK, 0);
    this.audio = new CourtAudio(audio ?? null);
    const racket = (model: AthleteModel, racquet: THREE.Object3D): Racket => ({
      model,
      racquet,
      anim: new StrokeAnim(),
      hitAt: null,
      planted: null,
    });
    this.sides = { player: racket(this.player, this.playerRacquet), cpu: racket(this.cpu, this.cpuRacquet) };
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    // Antialiasing happens in the post chain's multisampled scene target instead.
    this.post = new PostFX(this.renderer);
    this.pixelRatio = Math.min(window.devicePixelRatio, PIXEL_RATIO.max);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "court-canvas";
    parent.append(this.renderer.domElement);
    this.hud = new Hud(parent);
    this.debug = new DebugOverlay(parent, this.renderer);
    // The post chain renders several passes per frame; count them all, reset once per frame.
    this.renderer.info.autoReset = false;

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
    this.ballHolder.visible = false;
    this.ballHolder.add(this.ball);
    this.scene.add(this.ballHolder);
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
      hit: (shot) => this.onHit(shot),
      bounce: (speed) => {
        this.audio.bounce(speed, this.match.ball.pos.x);
        this.squashBall(SQUASH.bounce * Math.min(1, speed / 14), UP);
      },
      net: (cord) => this.audio.net(cord, this.match.ball.pos.x),
      point: (winner) => this.audio.crowd(winner === "player" ? Math.min(1, 0.55 + this.match.rally * 0.06) : 0.2),
      ballVisible: (v) => {
        this.ballHolder.visible = v;
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
    this.debug.destroy();
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
    const cpuStart = performance.now();
    this.renderer.info.reset();
    // Hit-stop: the world holds still for a few frames on impact (the camera still kicks).
    const stopped = Math.min(dt, this.hitStop);
    this.hitStop -= stopped;
    const simDt = this.match.paused ? 0 : dt - stopped;
    if (simDt > 0) {
      this.time += simDt;
      this.match.update(simDt);
    }
    this.sync(simDt, this.match.paused ? 0 : dt);
    if (this.usePost) this.post.render(this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    if (this.debug.visible) {
      const { calls, triangles } = this.renderer.info.render;
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      this.debug.frame(raw * 1000, performance.now() - cpuStart, {
        calls,
        triangles,
        width: size.x,
        height: size.y,
        pixelRatio: this.pixelRatio,
        post: this.usePost,
      });
    }
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

  /** `dt`: simulation time this frame (0 during hit-stop); `realDt`: wall time, for the camera. */
  private sync(dt: number, realDt: number) {
    const m = this.match;
    const ms = this.time * 1000;
    this.player.root.position.copy(w(m.player.x, 0, m.player.z));
    this.cpu.root.position.copy(w(m.cpu.x, 0, m.cpu.z));
    const look = this.ballHolder.visible ? this.ballHolder.position : null;
    this.player.setLookTarget(look);
    this.cpu.setLookTarget(look);
    this.animateStroke("player", dt);
    this.animateStroke("cpu", dt);
    this.player.update(dt, ms, m.player.vx, -m.player.vz);
    this.cpu.update(dt, ms, m.cpu.vx, -m.cpu.vz);

    this.syncRacquet("player");
    this.syncRacquet("cpu");
    this.syncBall(dt);
    this.syncShadows();
    this.syncCamera(realDt);
    this.syncFlashes(realDt);

    this.hud.setRally(m.rally);
    this.hud.setMarker(m.phase === "ready" ? this.toScreen(this.player.headWorld()) : null);
  }

  /** A swing from the phone arrived: animate it now, with contact just ahead. */
  playerSwing(power: number) {
    const m = this.match;
    if (m.lastHitter === "player" || (m.phase !== "feed" && m.phase !== "rally")) return;
    const side = this.sides.player;
    if (side.anim.swinging) return;
    const stroke = m.plan.player?.stroke ?? (m.ball.pos.x >= m.player.x ? "forehand" : "backhand");
    side.hitAt = null;
    side.anim.start(stroke, power, CONTACT_U - 0.05 / StrokeAnim.leadTime(power) * CONTACT_U);
  }

  /** Preparation, the computer's swing timing, and footwork from the match's plans. */
  private animateStroke(who: Side, dt: number) {
    const m = this.match;
    const side = this.sides[who];
    const plan = m.plan[who];
    const coming = !!plan && m.lastHitter !== who && (m.phase === "rally" || m.phase === "feed") && plan.time - m.now < 1600;
    if (coming && plan) {
      // The computer starts its swing so the racquet arrives with the ball.
      if (who === "cpu" && !side.anim.swinging && m.now >= plan.time - StrokeAnim.leadTime(0.6) * 1000) {
        side.hitAt = null;
        side.anim.start(plan.stroke, 0.6);
      }
      // Step in with the front foot just before contact.
      if (side.planted !== plan && m.now >= plan.time - 170) {
        side.planted = plan;
        side.model.plantFront(plan.stroke);
      }
    }
    side.anim.update(dt, coming, plan?.stroke ?? side.anim.stroke);
    if (!side.anim.swinging && side.hitAt && side.anim.pose().weight < 0.05) side.hitAt = null;
    side.model.setCoil(side.anim.pose().coil);
  }

  /**
   * Put the racquet in the hand. The player's racquet is the phone (same axes, no smoothing); the
   * hand follows where that grip would put it, pulled along the stroke path while preparing and
   * swinging. The computer's racquet follows the stroke path. Around contact the hand is drawn so
   * the strings meet the ball.
   */
  private syncRacquet(who: Side) {
    const m = this.match;
    const { model, racquet, anim, hitAt } = this.sides[who];
    // The model's own frame in the world. Its right (racquet) hand is on its -x.
    const right = model.toWorldDir(-1, 0, 0);
    const fwd = model.toWorldDir(0, 0, 1);
    const pose = anim.pose();
    const local = (p: THREE.Vector3) =>
      right.clone().multiplyScalar(p.x).addScaledVector(UP, p.y).addScaledVector(fwd, p.z);

    let shaft: THREE.Vector3;
    let strings: THREE.Vector3;
    if (who === "player") {
      shaft = wv(m.racquetAxes.shaft);
      strings = wv(m.racquetAxes.strings);
    } else {
      shaft = local(pose.shaft).normalize();
      strings = new THREE.Vector3().crossVectors(shaft, fwd);
      if (strings.lengthSq() < 1e-3) strings = right.clone();
      strings.normalize();
    }

    const S = model.shoulderWorld();
    // Where the racquet's own direction puts the hand (a relaxed arm hanging toward the shaft).
    const free = right.clone().multiplyScalar(0.2).addScaledVector(fwd, 0.15).addScaledVector(UP, -1).addScaledVector(shaft, 0.9);
    const hand = S.clone().addScaledVector(free.normalize(), model.armLength * ARM_REACH);
    // The stroke path.
    const weight = who === "player" ? pose.weight * PLAYER_PATH_WEIGHT : pose.weight;
    if (weight > 0) hand.lerp(S.clone().add(local(pose.hand)), weight);
    // Contact snap: the sweet spot onto the ball (where it was struck, or where it is now).
    const target = hitAt ?? (this.ballHolder.visible ? this.ballHolder.position : null);
    if (pose.contact > 0 && target && target.distanceTo(S) < 2) {
      const grip = target.clone().addScaledVector(shaft, -RACQUET_HEAD);
      hand.lerp(grip, pose.contact * (hitAt ? 1 : 0.7));
    }
    hand.y = Math.max(0.2, hand.y);
    const pole = right.clone().multiplyScalar(0.6).addScaledVector(UP, -1).addScaledVector(fwd, -0.6);
    model.reach(hand, pole, shaft);
    poseRacquet(racquet, model.handWorld(), shaft, strings);
  }

  private syncBall(dt: number) {
    const b = this.match.ball;
    if (!this.ballHolder.visible) {
      for (const t of this.trail) t.visible = false;
      return;
    }
    const holder = this.ballHolder;
    holder.position.copy(w(b.pos.x, b.pos.y + BALL_RADIUS * 0.5, b.pos.z));
    const v = wv(b.vel);
    const speed = v.length();
    // Show the real spin axis (slowed down: real spin would strobe), or roll along when spinless.
    // Spin is a pseudo-vector, so mirroring z into the scene flips its other two components.
    const spin = new THREE.Vector3(-b.spin.x, -b.spin.y, b.spin.z);
    const rate = spin.length();
    if (rate > 5) this.ball.rotateOnWorldAxis(spin.normalize(), Math.min(rate * 0.12, 30) * dt);
    else if (speed > 0.1) this.ball.rotateOnWorldAxis(new THREE.Vector3().crossVectors(UP, v).normalize(), (speed * dt) / BALL_RADIUS / 3);

    // Squash along the impact, springing back.
    const sq = this.squash;
    sq.age += dt;
    const k = sq.amount * Math.max(0, 1 - sq.age / SQUASH.time);
    holder.quaternion.setFromUnitVectors(UP, sq.axis);
    holder.scale.set(1 + k * 0.45, 1 - k, 1 + k * 0.45);

    if (dt > 0) {
      this.trailPos.unshift(holder.position.clone());
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
    s.visible = this.ballHolder.visible;
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
    // Impact kick: a short jolt toward the court with a fast shake.
    if (this.kick > 0.01) {
      const k = this.kick;
      const t = this.time * 1000;
      this.camera.position.addScaledVector(this.camera.getWorldDirection(new THREE.Vector3()), 0.18 * k);
      this.camera.position.x += Math.sin(t * 0.09) * 0.05 * k;
      this.camera.position.y += Math.sin(t * 0.07 + 1) * 0.04 * k;
      this.kick *= Math.exp(-dt * 14);
    }
  }

  private onHit(shot: Shot) {
    const { by, power, quality } = shot;
    this.hud.setSpeed(shot.kmh);
    this.flash();
    this.audio.hit(power, quality, shot.at.x);
    const side = this.sides[by];
    side.hitAt = w(shot.at.x, shot.at.y, shot.at.z);
    side.anim.contactNow(shot.stroke as Stroke, power);
    this.sides[by === "player" ? "cpu" : "player"].model.splitStep();
    const v = wv(this.match.ball.vel);
    this.squashBall(SQUASH.hit * (0.5 + power * 0.5), v.lengthSq() > 0 ? v.normalize() : UP);
    if (by === "player") {
      this.hooks.onPlayerHit(quality);
      this.hitStop = THREE.MathUtils.lerp(HIT_STOP.min, HIT_STOP.max, power * 0.5 + quality * 0.5);
      this.kick = 0.4 + 0.6 * power * quality;
    } else {
      this.hitStop = HIT_STOP.min;
    }
  }

  private squashBall(amount: number, axis: THREE.Vector3) {
    this.squash.amount = amount;
    this.squash.age = 0;
    this.squash.axis.copy(axis);
  }

  private flash() {
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    s.position.copy(this.ballHolder.position);
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
