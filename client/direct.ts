import type { RtcSignal } from "../shared/protocol";

// A direct WebRTC link between a phone and the game screen: the only way input travels during play.
// The phone and the screen must be on the same Wi-Fi or hotspot, so input never leaves the room and a
// match keeps going if the internet drops. The server only carries the handshake, one message each way.

/**
 * No STUN or TURN servers: each side offers only its local network addresses, so the link either
 * forms over the local network or not at all (never a slower route through the internet).
 */
const ICE_SERVERS: RTCIceServer[] = [];
/**
 * Browsers hide their local address behind a random name like `a1b2.local` that the other device
 * must look up, and many hotspots and Wi-Fi networks block that lookup. The link still forms if the
 * game screen shares its real address (the phone's address is learned when it first reaches out), so
 * the screen's Chrome is started with `npm run screen`, which turns the hiding off.
 */
export function sharesLocalAddress(sdp: string) {
  return sdp.split("\n").some((line) => line.startsWith("a=candidate") && !line.split(" ")[4]?.endsWith(".local"));
}

/** Local candidates come in within milliseconds; this is only a safety net. */
const GATHER_TIMEOUT_MS = 1500;

export class DirectLink {
  private pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  /** Unordered, no retransmits: a late tilt is useless, the next one replaces it. */
  private fast?: RTCDataChannel;
  /** Ordered and reliable: swings, bounces, pongs, and everything the screen sends. */
  private sure?: RTCDataChannel;
  private wasOpen = false;

  onMessage: (msg: unknown) => void = () => {};
  /** Fires when the link comes up and when it goes down. */
  onChange: (open: boolean) => void = () => {};

  private constructor(readonly id: number) {
    this.pc.onconnectionstatechange = () => this.update();
    this.pc.ondatachannel = (e) => this.attach(e.channel);
  }

  /** Usable right now. */
  get open() {
    return this.sure?.readyState === "open" && this.pc.connectionState === "connected";
  }

  /** Game screen: open the channels and make the offer for a phone. */
  static async offer(id: number): Promise<{ link: DirectLink; signal: RtcSignal }> {
    const link = new DirectLink(id);
    link.attach(link.pc.createDataChannel("fast", { ordered: false, maxRetransmits: 0 }));
    link.attach(link.pc.createDataChannel("sure"));
    await link.pc.setLocalDescription(await link.pc.createOffer());
    return { link, signal: await link.localSignal() };
  }

  /** Phone: answer the game screen's offer. */
  static async answer(offer: RtcSignal): Promise<{ link: DirectLink; signal: RtcSignal }> {
    const link = new DirectLink(offer.id);
    await link.pc.setRemoteDescription(offer.sdp);
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    return { link, signal: await link.localSignal() };
  }

  /** Game screen: finish the handshake with the phone's answer. */
  async accept(answer: RtcSignal) {
    if (answer.id !== this.id || this.pc.signalingState !== "have-local-offer") return;
    await this.pc.setRemoteDescription(answer.sdp);
  }

  /** Sends `msg` over the link. False if the link isn't up (the message is dropped). */
  send(msg: unknown, fast = false): boolean {
    if (!this.open) return false;
    const channel = fast && this.fast?.readyState === "open" ? this.fast : this.sure!;
    try {
      channel.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.pc.close();
    this.update();
  }

  private attach(channel: RTCDataChannel) {
    if (channel.label === "fast") this.fast = channel;
    else this.sure = channel;
    channel.onmessage = (e) => {
      try {
        this.onMessage(JSON.parse(e.data));
      } catch {
        // not ours
      }
    };
    channel.onopen = channel.onclose = () => this.update();
  }

  private update() {
    const open = this.open;
    if (open === this.wasOpen) return;
    this.wasOpen = open;
    this.onChange(open);
  }

  /** Our description once candidate gathering is done (or has had long enough). */
  private async localSignal(): Promise<RtcSignal> {
    if (this.pc.iceGatheringState !== "complete") {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
        this.pc.onicegatheringstatechange = () => {
          if (this.pc.iceGatheringState !== "complete") return;
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const { type, sdp } = this.pc.localDescription!;
    return { id: this.id, sdp: { type: type as "offer" | "answer", sdp } };
  }
}
