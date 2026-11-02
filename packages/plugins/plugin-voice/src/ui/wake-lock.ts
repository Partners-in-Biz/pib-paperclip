/** Keeps the phone screen on while a live call is open, so an auto-lock does not freeze the page and kill the call. */

export interface WakeGuard {
  /** Idempotent. Drops the screen lock and stops the fallback video. */
  release(): void;
}

export interface WakeLockOptions {
  audioContext: AudioContext;
  /** A line for the call panel ("screen may lock"), or null to clear it. Never fatal. */
  onNotice: (message: string | null) => void;
}

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

const NOTICE = "Screen may lock during this call. Keep the screen on to stay connected.";
const LOG = "[pib-voice]";

/**
 * Must run synchronously inside the tap that opens Talk, before any await: iOS refuses the lock
 * (and video playback) outside a user gesture. A denied, unsupported or throwing lock only raises
 * the notice; it never ends the call.
 */
export function startWakeLock(opts: WakeLockOptions): WakeGuard {
  let released = false;
  let sentinel: Sentinel | null = null;
  let requesting = false;
  let video: HTMLVideoElement | null = null;
  let drawTimer: number | null = null;

  const notice = (message: string | null) => {
    try {
      opts.onNotice(message);
    } catch {
      // The banner is cosmetic.
    }
  };

  const stopVideo = () => {
    if (drawTimer !== null) window.clearInterval(drawTimer);
    drawTimer = null;
    if (!video) return;
    try {
      video.pause();
      const stream = video.srcObject as MediaStream | null;
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      video.remove();
    } catch {
      // Already gone.
    }
    video = null;
  };

  /** A muted, inline, silent video keeps iOS awake where the Wake Lock API is missing or refused. */
  const startVideo = () => {
    if (released || video) return;
    // A context that is closed or interrupted (a call, Siri) is not playing: a video would only hold the screen for nothing.
    const state = opts.audioContext.state as string;
    if (state === "closed" || state === "interrupted") {
      notice(NOTICE);
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const capture = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream;
      if (typeof capture !== "function") {
        notice(NOTICE);
        return;
      }
      const ctx = canvas.getContext("2d");
      let tick = 0;
      const paint = () => {
        // A changing frame, so the stream keeps producing video.
        if (ctx) {
          ctx.fillStyle = tick++ % 2 === 0 ? "#000" : "#010101";
          ctx.fillRect(0, 0, 16, 16);
        }
      };
      paint();
      const el = document.createElement("video");
      el.muted = true;
      el.defaultMuted = true;
      el.loop = true;
      el.setAttribute("muted", "");
      el.setAttribute("playsinline", "");
      el.setAttribute("aria-hidden", "true");
      el.playsInline = true;
      el.srcObject = capture.call(canvas, 2);
      el.style.cssText = "position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;top:0;";
      document.body.appendChild(el);
      video = el;
      drawTimer = window.setInterval(paint, 500);
      Promise.resolve(el.play()).catch((err: unknown) => {
        console.warn(LOG, "fallback video did not start", err);
        stopVideo();
        notice(NOTICE);
      });
    } catch (err) {
      console.warn(LOG, "fallback video failed", err);
      stopVideo();
      notice(NOTICE);
    }
  };

  const request = () => {
    if (released || requesting || sentinel) return;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } }).wakeLock;
    if (!wakeLock || typeof wakeLock.request !== "function") {
      console.info(LOG, "wake lock unsupported");
      notice(NOTICE);
      startVideo();
      return;
    }
    requesting = true;
    let pending: Promise<Sentinel>;
    try {
      pending = Promise.resolve(wakeLock.request("screen"));
    } catch (err) {
      requesting = false;
      console.warn(LOG, "wake lock denied", err);
      notice(NOTICE);
      startVideo();
      return;
    }
    pending.then(
      (lock) => {
        requesting = false;
        if (released) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
        console.info(LOG, "wake lock granted");
        notice(null);
        try {
          // The browser drops the lock when the tab is hidden; visibilitychange asks for it again.
          lock.addEventListener("release", () => {
            if (sentinel === lock) sentinel = null;
          });
        } catch {
          // Not an event target; the next request just replaces it.
        }
      },
      (err: unknown) => {
        requesting = false;
        if (released) return;
        console.warn(LOG, "wake lock denied", err);
        notice(NOTICE);
        startVideo();
      },
    );
  };

  const onVisible = () => {
    if (released || document.visibilityState !== "visible") return;
    if (video) void Promise.resolve(video.play()).catch(() => undefined);
    request();
  };

  const onContextState = () => {
    // Running -> anything else (suspended by the OS, interrupted, closed): the video no longer helps.
    if (opts.audioContext.state !== "running") stopVideo();
  };

  document.addEventListener("visibilitychange", onVisible);
  try {
    opts.audioContext.addEventListener("statechange", onContextState);
  } catch {
    // Test doubles and very old WebKit have no event target.
  }

  request();

  return {
    release() {
      if (released) return;
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      try {
        opts.audioContext.removeEventListener("statechange", onContextState);
      } catch {
        // See above.
      }
      stopVideo();
      const lock = sentinel;
      sentinel = null;
      if (lock) void lock.release().catch(() => undefined);
    },
  };
}
