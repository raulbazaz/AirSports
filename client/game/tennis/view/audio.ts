// Court sounds, synthesised with Web Audio (no files to load):
// - hit: a hollow "pok" (a fast pitch drop plus a band of noise), brighter on a sweet-spot hit;
// - bounce: a soft low thud; net: a dull thump, or a tick for a ball clipping the tape;
// - crowd: applause after a point, louder when the player wins it.
// Sounds pan left/right with where they happen on court.

const MASTER = 0.7;

export class CourtAudio {
  private readonly out: GainNode | null = null;
  private readonly noise: AudioBuffer | null = null;
  private readonly applause: AudioBuffer | null = null;

  constructor(private readonly ctx: AudioContext | null) {
    if (!ctx) return;
    this.out = ctx.createGain();
    this.out.gain.value = MASTER;
    this.out.connect(ctx.destination);
    this.noise = whiteNoise(ctx, 0.5);
    this.applause = applause(ctx, 2.6);
  }

  /** A racquet strike. `power` and `quality` 0..1; `x` court position (m) for panning. */
  hit(power: number, quality: number, x: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const dest = this.pan(x);
    const level = 0.35 + 0.45 * power;

    // Body: a sine dropping fast in pitch.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(700 + quality * 500, t);
    osc.frequency.exponentialRampToValueAtTime(220, t + 0.05);
    const og = envelope(ctx, t, level * 0.7, 0.002, 0.09);
    osc.connect(og).connect(dest);
    osc.start(t);
    osc.stop(t + 0.12);

    // Strings: a short burst of band-passed noise.
    const n = this.noiseSource(t, 0.06);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1500 + quality * 1700;
    bp.Q.value = 1.4;
    n.connect(bp).connect(envelope(ctx, t, level * (0.5 + quality * 0.6), 0.001, 0.05)).connect(dest);
  }

  /** The ball hitting the ground at `speed` m/s. */
  bounce(speed: number, x: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || speed < 1) return;
    const t = ctx.currentTime;
    const dest = this.pan(x);
    const level = Math.min(0.5, 0.06 + speed * 0.022);
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(85, t + 0.07);
    osc.connect(envelope(ctx, t, level, 0.002, 0.08)).connect(dest);
    osc.start(t);
    osc.stop(t + 0.1);
    const n = this.noiseSource(t, 0.05);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    n.connect(lp).connect(envelope(ctx, t, level * 0.6, 0.001, 0.04)).connect(dest);
  }

  /** The ball hit the net (`cord`: clipped the tape). */
  net(cord: boolean, x: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const dest = this.pan(x);
    const n = this.noiseSource(t, 0.2);
    const f = ctx.createBiquadFilter();
    f.type = cord ? "bandpass" : "lowpass";
    f.frequency.value = cord ? 2400 : 500;
    n.connect(f).connect(envelope(ctx, t, cord ? 0.5 : 0.6, 0.002, cord ? 0.05 : 0.16)).connect(dest);
  }

  /** Applause after a point; `cheer` 0..1 (how much the crowd likes it). */
  crowd(cheer: number) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running" || !this.applause) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.applause;
    src.playbackRate.value = 0.95 + Math.random() * 0.1;
    const g = ctx.createGain();
    g.gain.value = 0.12 + cheer * 0.3;
    src.connect(g).connect(this.out!);
    src.start(t + 0.05);
  }

  private pan(x: number): AudioNode {
    const ctx = this.ctx!;
    if (!ctx.createStereoPanner) return this.out!;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-0.8, Math.min(0.8, x / 7));
    p.connect(this.out!);
    return p;
  }

  private noiseSource(t: number, dur: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.3, dur);
    return src;
  }
}

/** Gain node shaped as a quick attack and exponential-ish decay. */
function envelope(ctx: AudioContext, t: number, peak: number, attack: number, decay: number) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setTargetAtTime(0, t + attack, decay / 3);
  return g;
}

function whiteNoise(ctx: AudioContext, seconds: number) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Many people clapping: lots of short noise bursts, swelling and fading out. */
function applause(ctx: AudioContext, seconds: number) {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.ceil(rate * seconds), rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const claps = Math.round(seconds * 260);
    for (let c = 0; c < claps; c++) {
      const at = Math.random() * seconds;
      const swell = Math.min(1, at / 0.25) * Math.max(0, 1 - Math.pow(at / seconds, 1.6));
      const start = Math.floor(at * rate);
      const len = Math.floor(rate * (0.004 + Math.random() * 0.008));
      const amp = swell * (0.25 + Math.random() * 0.35);
      // A clap: a few ms of noise, with a little one-pole low-pass for body.
      let lp = 0;
      for (let i = 0; i < len && start + i < d.length; i++) {
        lp += ((Math.random() * 2 - 1) - lp) * 0.55;
        d[start + i] += lp * amp * Math.exp(-i / (len * 0.35));
      }
    }
  }
  return buf;
}
