import * as THREE from "three";
import { COURT } from "../court";
import {
  Match,
  mirror,
  type Opponent,
  other,
  type Shot,
  type Side,
  type Stroke,
} from "../match";
import { buildArena, CROWD_PALETTE, simpleCrowd } from "./arena";
import {
  type AthleteAsset,
  AthleteModel,
  CPU_LOOK,
  PLAYER2_LOOK,
  PLAYER_LOOK,
} from "./athlete";
import { CourtAudio } from "./audio";
import { Crowd, type SpectatorAsset, weakDevice } from "./crowd";
import { DebugOverlay } from "./debug";
import { Hud } from "./hud";
import { drawIn, type Pane, PostFX } from "./post";
import { makeRacquet, poseRacquet, RACQUET_HEAD } from "./racquet";
import { CONTACT_U, StrokeAnim } from "./stroke";
import { w, wv } from "./space";
import {
  ballTexture,
  glowTexture,
  shadowTexture,
  skyTexture,
} from "./textures";

export interface CourtHooks {
  /** Whether `side`'s phone should enable its Bounce button. */
  onServeReady(side: Side, ready: boolean): void;
  /** A player connected with the ball (good moment for a buzz on their phone); `quality` 0..1. */
  onPlayerHit(side: Side, quality: number): void;
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
/**
 * First-person eye: a little above and behind the player's head so their own racquet sits in the
 * lower right of the frame, looking down the court at a point `ahead` meters away on the ground.
 */
const EYE = { height: 1.8, back: 0.75, ahead: 9 };
/**
 * Field of view: about this wide (degrees, horizontal) on any screen shape, with the vertical
 * angle kept within `minV`..`maxV` so a wide split-screen pane doesn't squash it to a letterbox.
 */
const FOV = { across: 96, minV: 44, maxV: 90 };
/**
 * The head turns toward the ball once it's within `near` meters (up to `max` of the way), easing
 * over `ease` seconds, so a ball bouncing at your feet stays on screen.
 */
const GAZE = { near: 5, max: 0.85, ease: 0.15 };
/**
 * Easing on the drawn racquet's angle (s). Phone tilts arrive over Wi-Fi in uneven bursts; this
 * hides the gaps without a noticeable delay. The match still uses the raw angle for shots.
 */
const RACQUET_SMOOTH = 0.035;

const UP = new THREE.Vector3(0, 1, 0);

/** One side's animation state beyond the body simulation. */
interface Racket {
  /** Each player sees through their own eyes; their own body is on a layer their camera skips. */
  camera: THREE.PerspectiveCamera;
  layer: number;
  /** The racquet's axes as drawn, eased toward the phone's (see RACQUET_SMOOTH). */
  shown: { shaft: THREE.Vector3; strings: THREE.Vector3 };
  /** How far the head is turned toward the ball (0..GAZE.max), and the last place it was seen. */
  gaze: number;
  gazeAt: THREE.Vector3;
  /** The camera's impact kick (decays to 0). */
  kick: number;
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
  private readonly hud: Hud;
  readonly debug: DebugOverlay;
  private readonly post: PostFX;
  private readonly resize: ResizeObserver;

  private readonly ball: THREE.Mesh;
  /** Holds the ball mesh; squashes along an axis on impact. */
  private readonly ballHolder = new THREE.Group();
  private squash = { amount: 0, age: 1, axis: new THREE.Vector3(0, 1, 0) };
  readonly audio: CourtAudio;
  private readonly crowd: Crowd | null = null;
  private readonly sides: Record<Side, Racket>;
  /** Who has a screen: Player 1 always, Player 2 too in a two-player match (split screen). */
  private readonly viewers: Side[];
  /** Hit-stop time left (s). */
  private hitStop = 0;
  private readonly trail: THREE.Mesh[] = [];
  private readonly trailPos: THREE.Vector3[] = [];
  private flashes: { sprite: THREE.Sprite; age: number }[] = [];
  private readonly flashTex = glowTexture();
  private readonly shadows: {
    p1: THREE.Mesh;
    p2: THREE.Mesh;
    ball: THREE.Mesh;
  };

  private raf = 0;
  private last = 0;
  private time = 0;
  private pixelRatio: number;
  private slowFrames = 0;
  private sampledTime = 0;
  /** Soft-focus post chain; switched off if the device is still slow at the lowest resolution. */
  private usePost = true;
  private sampledFrames = 0;

  constructor(
    private readonly parent: HTMLElement,
    private readonly hooks: CourtHooks,
    {
      athlete,
      spectator,
    }: { athlete: AthleteAsset; spectator: SpectatorAsset | null },
    audio?: AudioContext,
    opponent: Opponent = "cpu",
  ) {
    this.audio = new CourtAudio(audio ?? null);
    this.viewers = opponent === "human" ? ["p1", "p2"] : ["p1"];
    const racket = (
      model: AthleteModel,
      color: number,
      layer: number,
    ): Racket => ({
      model,
      racquet: makeRacquet(color),
      anim: new StrokeAnim(),
      hitAt: null,
      planted: null,
      camera: new THREE.PerspectiveCamera(64, 16 / 9, 0.1, 400),
      layer,
      shown: {
        shaft: new THREE.Vector3(0, 1, 0),
        strings: new THREE.Vector3(1, 0, 0),
      },
      gaze: 0,
      gazeAt: new THREE.Vector3(),
      kick: 0,
    });
    this.sides = {
      p1: racket(new AthleteModel(athlete, PLAYER_LOOK, Math.PI), 0x2f7de1, 1),
      p2:
        opponent === "human"
          ? racket(new AthleteModel(athlete, PLAYER2_LOOK, 0), 0x9b5de5, 2)
          : racket(new AthleteModel(athlete, CPU_LOOK, 0), 0xe5532d, 2),
    };
    // Each camera sees everything except its own player's body.
    this.sides.p1.camera.layers.enable(2);
    this.sides.p2.camera.layers.enable(1);
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    });
    // Antialiasing happens in the post chain's multisampled scene target instead.
    this.post = new PostFX(this.renderer);
    this.pixelRatio = Math.min(window.devicePixelRatio, PIXEL_RATIO.max);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "court-canvas";
    parent.append(this.renderer.domElement);
    this.hud = new Hud(
      parent,
      { p1: "Player 1", p2: opponent === "human" ? "Player 2" : "Computer" },
      opponent === "human",
    );
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

    const seats = buildArena(this.scene);
    if (spectator) {
      this.crowd = new Crowd(
        spectator,
        seats,
        CROWD_PALETTE,
        w(0, 1, COURT.netZ),
        weakDevice(),
      );
      this.scene.add(this.crowd.mesh);
    } else {
      this.scene.add(simpleCrowd(seats));
    }
    for (const side of ["p1", "p2"] as const)
      this.scene.add(this.sides[side].model.root, this.sides[side].racquet);

    const blob = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const blobMat = new THREE.MeshBasicMaterial({
      map: shadowTexture(),
      transparent: true,
      depthWrite: false,
    });
    const shadow = (size: number) => {
      const m = new THREE.Mesh(blob, blobMat);
      m.scale.setScalar(size);
      m.renderOrder = 0.5;
      this.scene.add(m);
      return m;
    };
    this.shadows = { p1: shadow(1.1), p2: shadow(1.1), ball: shadow(0.3) };
    // First person: a player's body is still simulated (it places the racquet) but their own
    // camera doesn't draw it.
    for (const side of ["p1", "p2"] as const) {
      const { model, layer } = this.sides[side];
      for (const o of [model.root, this.shadows[side]])
        o.traverse((c) => c.layers.set(layer));
    }

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
        new THREE.MeshBasicMaterial({
          color: 0xf4ff9a,
          transparent: true,
          opacity: 0.45 * (1 - i / TRAIL),
          depthWrite: false,
        }),
      );
      m.visible = false;
      this.trail.push(m);
      this.scene.add(m);
    }

    this.match = new Match(
      {
        serveReady: (side, ready) => hooks.onServeReady(side, ready),
        hit: (shot) => this.onHit(shot),
        bounce: (speed) => {
          this.audio.bounce(speed, this.match.ball.pos.x);
          this.squashBall(SQUASH.bounce * Math.min(1, speed / 14), UP);
        },
        net: (cord) => this.audio.net(cord, this.match.ball.pos.x),
        point: (winner) => {
          const cheer = this.match.isCpu(winner)
            ? 0.2
            : Math.min(1, 0.55 + this.match.rally * 0.06);
          this.audio.crowd(cheer);
          this.crowd?.cheer(cheer);
        },
        ballVisible: (v) => {
          this.ballHolder.visible = v;
          this.trailPos.length = 0;
          if (!v) this.hud.setRally(0);
        },
        banner: (title, sub) => this.hud.banner(title, sub),
        pop: (side, text) => this.hud.pop(text, this.eyeLevel(side)),
        score: (s) => this.hud.setScore(s),
      },
      opponent,
    );

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(parent);
    this.fit();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** `who`: whose phone dropped ("Player 2's phone"). */
  setPaused(paused: boolean, who?: string) {
    this.match.paused = paused;
    this.hud.setPaused(paused, who);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.resize.disconnect();
    this.hud.destroy();
    this.debug.destroy();
    this.crowd?.dispose();
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
    const panes = this.viewers.length;
    this.post.setSize(buf.x, Math.round(buf.y / panes));
    for (const side of this.viewers) {
      const camera = this.sides[side].camera;
      camera.aspect = wpx / (hpx / panes);
      // The same sweep across on every screen, so the racquet and the sidelines stay in view.
      const across = Math.tan(THREE.MathUtils.degToRad(FOV.across / 2));
      const v = THREE.MathUtils.radToDeg(2 * Math.atan(across / camera.aspect));
      camera.fov = THREE.MathUtils.clamp(v, FOV.minV, FOV.maxV);
      camera.updateProjectionMatrix();
    }
  }

  /** `side`'s part of the screen (CSS pixels from the bottom left): Player 1 on top when split. */
  private pane(side: Side): Pane {
    const { clientWidth: width, clientHeight: h } = this.parent;
    if (this.viewers.length === 1) return { x: 0, y: 0, width, height: h };
    const height = h / 2;
    return { x: 0, y: side === "p1" ? height : 0, width, height };
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
    for (const side of this.viewers) {
      const camera = this.sides[side].camera;
      const pane = this.pane(side);
      if (this.usePost) this.post.render(this.scene, camera, pane);
      else
        drawIn(this.renderer, pane, () =>
          this.renderer.render(this.scene, camera),
        );
    }
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

  /**
   * Weak GPU? Count slow frames over ~2 s windows and step down: first a lighter crowd, then
   * fewer pixels, then no post effects.
   */
  private adaptResolution(frameS: number) {
    if (document.hidden || frameS > 0.25) return; // tab switches and hitches don't count
    this.sampledFrames++;
    this.sampledTime += frameS;
    if (frameS > 1 / 45) this.slowFrames++;
    if (this.sampledFrames < 60) return;
    if (this.slowFrames > 20) {
      // Way too slow (under ~24 fps): go straight to the lowest resolution instead of stepping.
      const crawling = this.sampledTime / this.sampledFrames > 1 / 24;
      if (this.crowd?.degrade()) {
        if (crawling) while (this.crowd.degrade());
      } else if (this.pixelRatio > PIXEL_RATIO.min) {
        this.pixelRatio = crawling
          ? PIXEL_RATIO.min
          : Math.max(PIXEL_RATIO.min, this.pixelRatio - PIXEL_RATIO.step);
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
    const look = this.ballHolder.visible ? this.ballHolder.position : null;
    for (const side of ["p1", "p2"] as const) {
      const a = m.athletes[side];
      const model = this.sides[side].model;
      model.root.position.copy(w(a.x, 0, a.z));
      model.setLookTarget(look);
      this.animateStroke(side, dt);
      model.update(dt, ms, a.vx, -a.vz);
    }

    for (const side of ["p1", "p2"] as const) this.syncRacquet(side, realDt);
    this.syncBall(dt);
    this.crowd?.update(
      realDt,
      this.time,
      this.ballHolder.visible ? this.ballHolder.position : null,
    );
    this.syncShadows();
    for (const side of this.viewers) this.syncCamera(side, realDt);
    this.syncFlashes(realDt);

    this.hud.setRally(m.rally);
    for (const side of ["p1", "p2"] as const) {
      const serving =
        m.phase === "ready" && m.server === side && this.viewers.includes(side);
      this.hud.setMarker(side, serving ? this.eyeLevel(side) : null);
    }
  }

  /** A swing from `who`'s phone arrived: animate it now, with contact just ahead. */
  playerSwing(who: Side, power: number) {
    const m = this.match;
    if (
      m.isCpu(who) ||
      m.lastHitter === who ||
      (m.phase !== "feed" && m.phase !== "rally")
    )
      return;
    const side = this.sides[who];
    if (side.anim.swinging) return;
    const a = m.athletes[who];
    const ballX = mirror(who, m.ball.pos).x;
    const stroke =
      m.plan[who]?.stroke ??
      (ballX >= mirror(who, { x: a.x, y: 0, z: a.z }).x
        ? "forehand"
        : "backhand");
    side.hitAt = null;
    side.anim.start(
      stroke,
      power,
      CONTACT_U - (0.05 / StrokeAnim.leadTime(power)) * CONTACT_U,
    );
  }

  /** Preparation, the computer's swing timing, and footwork from the match's plans. */
  private animateStroke(who: Side, dt: number) {
    const m = this.match;
    const side = this.sides[who];
    const plan = m.plan[who];
    const coming =
      !!plan &&
      m.lastHitter !== who &&
      (m.phase === "rally" || m.phase === "feed") &&
      plan.time - m.now < 1600;
    if (coming && plan) {
      // The computer starts its swing so the racquet arrives with the ball.
      if (
        m.isCpu(who) &&
        !side.anim.swinging &&
        m.now >= plan.time - StrokeAnim.leadTime(0.6) * 1000
      ) {
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
    if (!side.anim.swinging && side.hitAt && side.anim.pose().weight < 0.05)
      side.hitAt = null;
    side.model.setCoil(side.anim.pose().coil);
  }

  /**
   * Put the racquet in the hand. A player's racquet is their phone (same axes, no smoothing); the
   * hand follows where that grip would put it, pulled along the stroke path while preparing and
   * swinging. The computer's racquet follows the stroke path. Around contact the hand is drawn so
   * the strings meet the ball.
   */
  private syncRacquet(who: Side, dt: number) {
    const m = this.match;
    const { model, racquet, anim, hitAt, shown } = this.sides[who];
    const phone = m.racquetAxes(who);
    // The model's own frame in the world. Its right (racquet) hand is on its -x.
    const right = model.toWorldDir(-1, 0, 0);
    const fwd = model.toWorldDir(0, 0, 1);
    const pose = anim.pose();
    const local = (p: THREE.Vector3) =>
      right
        .clone()
        .multiplyScalar(p.x)
        .addScaledVector(UP, p.y)
        .addScaledVector(fwd, p.z);

    let shaft: THREE.Vector3;
    let strings: THREE.Vector3;
    if (phone) {
      const k = 1 - Math.exp(-dt / RACQUET_SMOOTH);
      shaft = shown.shaft.lerp(wv(phone.shaft), k).normalize().clone();
      strings = shown.strings.lerp(wv(phone.strings), k).normalize().clone();
    } else {
      shaft = local(pose.shaft).normalize();
      strings = new THREE.Vector3().crossVectors(shaft, fwd);
      if (strings.lengthSq() < 1e-3) strings = right.clone();
      strings.normalize();
    }

    const S = model.shoulderWorld();
    // Where the racquet's own direction puts the hand (a relaxed arm hanging toward the shaft).
    const free = right
      .clone()
      .multiplyScalar(0.2)
      .addScaledVector(fwd, 0.15)
      .addScaledVector(UP, -1)
      .addScaledVector(shaft, 0.9);
    const hand = S.clone().addScaledVector(
      free.normalize(),
      model.armLength * ARM_REACH,
    );
    // The stroke path.
    const weight = phone ? pose.weight * PLAYER_PATH_WEIGHT : pose.weight;
    if (weight > 0) hand.lerp(S.clone().add(local(pose.hand)), weight);
    // Contact snap: the sweet spot onto the ball (where it was struck, or where it is now).
    const target =
      hitAt ?? (this.ballHolder.visible ? this.ballHolder.position : null);
    if (pose.contact > 0 && target && target.distanceTo(S) < 2) {
      const grip = target.clone().addScaledVector(shaft, -RACQUET_HEAD);
      hand.lerp(grip, pose.contact * (hitAt ? 1 : 0.7));
    }
    hand.y = Math.max(0.2, hand.y);
    const pole = right
      .clone()
      .multiplyScalar(0.6)
      .addScaledVector(UP, -1)
      .addScaledVector(fwd, -0.6);
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
    if (rate > 5)
      this.ball.rotateOnWorldAxis(
        spin.normalize(),
        Math.min(rate * 0.12, 30) * dt,
      );
    else if (speed > 0.1)
      this.ball.rotateOnWorldAxis(
        new THREE.Vector3().crossVectors(UP, v).normalize(),
        (speed * dt) / BALL_RADIUS / 3,
      );

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
    for (const side of ["p1", "p2"] as const) {
      const a = m.athletes[side];
      this.shadows[side].position.copy(w(a.x, 0.012, a.z));
    }
    const s = this.shadows.ball;
    s.visible = this.ballHolder.visible;
    if (s.visible) {
      const h = Math.max(0, m.ball.pos.y);
      s.position.copy(w(m.ball.pos.x, 0.014, m.ball.pos.z));
      s.scale.setScalar(0.28 + h * 0.06); // grows as the ball rises: a cheap height cue
    }
  }

  /** `side`'s eyes, from a point in their own frame of the court (x to their right, z ahead). */
  private eye(side: Side, x: number, y: number, z: number) {
    const p = mirror(side, { x, y, z });
    return w(p.x, p.y, p.z);
  }

  private syncCamera(who: Side, dt: number) {
    // First person: locked to the player (any easing here makes the racquet swim against the
    // view), looking down the court and turned a little toward the middle when out wide.
    const side = this.sides[who];
    const camera = side.camera;
    const a = this.match.athletes[who];
    const p = mirror(who, { x: a.x, y: 0, z: a.z });
    camera.position.copy(this.eye(who, p.x, EYE.height, p.z - EYE.back));
    const ball = this.ballHolder.visible ? this.ballHolder.position : null;
    const near = ball
      ? THREE.MathUtils.clamp(
          1 - ball.distanceTo(camera.position) / GAZE.near,
          0,
          1,
        )
      : 0;
    if (ball) side.gazeAt.copy(ball);
    side.gaze +=
      (near * GAZE.max - side.gaze) * (1 - Math.exp(-dt / GAZE.ease));
    camera.lookAt(
      this.eye(who, p.x * 0.6, 0, p.z + EYE.ahead).lerp(side.gazeAt, side.gaze),
    );
    // Impact kick: a short jolt toward the court with a fast shake.
    if (side.kick > 0.01) {
      const k = side.kick;
      const t = this.time * 1000;
      camera.position.addScaledVector(
        camera.getWorldDirection(new THREE.Vector3()),
        0.18 * k,
      );
      camera.position.x += Math.sin(t * 0.09) * 0.05 * k;
      camera.position.y += Math.sin(t * 0.07 + 1) * 0.04 * k;
      side.kick *= Math.exp(-dt * 14);
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
    this.sides[other(by)].model.splitStep();
    const v = wv(this.match.ball.vel);
    this.squashBall(
      SQUASH.hit * (0.5 + power * 0.5),
      v.lengthSq() > 0 ? v.normalize() : UP,
    );
    if (!this.match.isCpu(by)) {
      this.hooks.onPlayerHit(by, quality);
      this.hitStop = THREE.MathUtils.lerp(
        HIT_STOP.min,
        HIT_STOP.max,
        power * 0.5 + quality * 0.5,
      );
      side.kick = 0.4 + 0.6 * power * quality;
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
      new THREE.SpriteMaterial({
        map: this.flashTex,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
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

  /** Upper middle of `side`'s view (CSS pixels from the top left): where its serve arrow and "nice shot" pops go. */
  private eyeLevel(side: Side) {
    const pane = this.pane(side);
    const top = this.parent.clientHeight - pane.y - pane.height;
    return { x: pane.width / 2, y: top + pane.height * 0.3 };
  }
}
