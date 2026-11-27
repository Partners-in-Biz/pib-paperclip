// Fake microphone for the voice live harness (PAR-15051 T2). Injected with CDP
// `Page.addScriptToEvaluateOnNewDocument`, so it runs before the plugin's code on every page.
// - getUserMedia({audio}) answers a MediaStreamAudioDestinationNode stream on the harness's own AudioContext,
//   resumed inside the call (the call runs after the Start click, so the page has its user activation).
// - window.__voiceHarness.say(i) plays loaded clip i into that stream and resolves when it ends.
// - window.__voiceHarness.played counts AudioBufferSourceNode.start calls on any other context: the plugin's
//   playback only, never the harness clips.
(() => {
  if (window.__voiceHarness) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  let harnessCtx = null;
  let dest = null;
  const clips = [];
  const harness = { played: 0, clips };

  const ensure = () => {
    if (!harnessCtx) {
      harnessCtx = new Ctor();
      dest = harnessCtx.createMediaStreamDestination();
    }
    void harnessCtx.resume();
    return harnessCtx;
  };

  const realStart = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function start(...args) {
    if (this.context !== harnessCtx) harness.played += 1;
    return realStart.apply(this, args);
  };

  const media = navigator.mediaDevices;
  const realGum = media && media.getUserMedia ? media.getUserMedia.bind(media) : null;
  if (media) {
    media.getUserMedia = async (constraints) => {
      if (!constraints || !constraints.audio) {
        if (!realGum) throw new DOMException("No media", "NotFoundError");
        return realGum(constraints);
      }
      ensure();
      return dest.stream;
    };
  }

  /** Clip: {sampleRate, pcm16} with pcm16 as base64 little-endian mono samples. */
  harness.load = (index, clip) => {
    const bin = atob(clip.pcm16);
    const view = new DataView(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i += 1) view.setUint8(i, bin.charCodeAt(i));
    const samples = new Float32Array(bin.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
    clips[index] = { sampleRate: clip.sampleRate, samples };
    return samples.length;
  };

  /** Plays clip i into the fake mic; resolves with its duration in ms once it has ended. */
  harness.say = (index) => {
    const clip = clips[index];
    if (!clip) return Promise.reject(new Error(`clip ${index} not loaded`));
    const ctx = ensure();
    const buffer = ctx.createBuffer(1, clip.samples.length, clip.sampleRate);
    buffer.copyToChannel(clip.samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(dest);
    return new Promise((resolve) => {
      source.onended = () => resolve(Math.round(buffer.duration * 1000));
      source.start();
    });
  };

  harness.context = () => harnessCtx;
  window.__voiceHarness = harness;
})();
