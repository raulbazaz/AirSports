import type { RtcSignal } from "../shared/protocol";

// A direct WebRTC link between a phone and the game screen. Once it's up, inputs and host messages
// skip the server: on the same Wi-Fi or hotspot they never leave the room, and a match keeps going
// if the internet drops. The server only carries the handshake, one message each way.

/** Lets the link also form between different networks, through each side's public address. */
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
/** Local candidates come in within milliseconds; don't hold the handshake for a slow STUN reply. */
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

  /** Usable right now. While it isn't, callers send through the server instead. */
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

  /** Sends `msg` over the link. False if the link isn't up (send it through the server instead). */
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
