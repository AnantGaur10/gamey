export type UiSfx = 'hover' | 'click' | 'confirm' | 'back';

/** One looping layer of a map's sound bed (a file in public/assets/audio). */
export interface BedLayer {
  file: string;
  /** Layer level before the bus (0..1). */
  gain: number;
  /** music = the MUSIC slider; sfx = environment sounds (SOUND FX slider). */
  bus: 'music' | 'sfx';
}

export interface AudioManager {
  /** The looping sound bed (music + ambience). Idempotent: layers already
   *  playing keep running (a series' rounds never restart the tune) and only
   *  retarget their gain; others fade out, new ones fade in. [] = silence. */
  setBed(layers: BedLayer[]): void;
  setMusicVolume(v: number): void;
  /** Revolver shot: the pistol sample when it has loaded, else the Web Audio
   *  synth. far = the foe's shot down the street: quieter, duller, more echo. */
  playGunshot(volume?: number, far?: boolean): void;
  /** Fetch + decode the gunshot sample ahead of the first shot. */
  warmup(): void;
  /** Gusting wind bed for the duel (Web Audio noise). 0 = off ... 1 = gale;
   *  hell = a low hot roar instead of a whistle. */
  startWind(strength: number, hell?: boolean): void;
  stopWind(): void;
  /** A boot step (synth): pan -1..1, gain 0..1, on boards or in the dirt. */
  playFootstep(pan: number, gain: number, surface: 'wood' | 'dirt'): void;
  playSFX(sfx: 'hit-body' | 'hit-head', volume?: number): Promise<void>;
  /** Menu sounds (Web Audio synth on the SFX bus): hover = cylinder tick,
   *  click = hammer cock, confirm = cock + spur ring, back = a duller cock. */
  playUiSfx(kind: UiSfx): void;
  /** SETTINGS SFX level 0..1 (gunshots, wind, ambience, hit sounds). */
  setSfxVolume(v: number): void;
  muteForAd(): void;
  unmuteAfterAd(): void;
  /** The player's own mute; returns their choice, unchanged while the site mutes us. */
  toggleMute(): boolean;
  /** Silent for any reason, the player's mute or the site's. */
  isMuted(): boolean;
  /** The site's mute setting (SDK muteAudio): wins over the player's choice. */
  setPortalMuted(m: boolean): void;
  /** Inside a user gesture: create / wake the context (iOS) and start a bed
   *  that was waiting for it. */
  resumeAudioContext(): void;
}

// Audio failures are expected (autoplay policy, no AudioContext, a blocked
// fetch) and the game plays on silently: log in dev only.
function log(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

/** Only files that ship are ever requested (`__AUDIO_FILES__`, listed at
 *  build time by vite.config.ts): a probe for a missing file logged a console
 *  404 on every prod load (2026-10-21). BASE_URL-relative (portal rule). */
export function audioUrl(file: string): string | null {
  return __AUDIO_FILES__.includes(file) ? `${import.meta.env.BASE_URL}assets/audio/${file}` : null;
}

/** Music tracks (MUSIC bus) that ship: SETTINGS shows the MUSIC slider only then. */
const MUSIC_FILES = ['home-screen.mp3', 'saloon.mp3'];
export const HAS_MUSIC = __AUDIO_FILES__.some((f) => MUSIC_FILES.includes(f));

export function createAudioManager(): AudioManager {
  let audioContext: AudioContext | null = null;
  let playerMuted = false;
  let portalMuted = false;
  let adMuted = false;
  const silent = (): boolean => playerMuted || portalMuted || adMuted;
  let musicVolume = 0.5;
  let sfxVolume = 1; // SETTINGS SFX level (synth bus gain + hit sounds)

  /** True once the page has had a user gesture (or the API is missing). A
   *  context created before that starts suspended and Chrome logs "The
   *  AudioContext was not allowed to start". */
  function gestured(): boolean {
    const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
    return ua ? ua.hasBeenActive : true;
  }

  function getAudioContext(): AudioContext | null {
    try {
      if (!audioContext) {
        if (!gestured()) return null;
        const ContextClass = (window as any).AudioContext || (window as any).webkitAudioContext;
        audioContext = new ContextClass();
      }
      return audioContext;
    } catch (err) {
      log('AudioContext not available:', err);
      return null;
    }
  }

  function resumeAudioContext(): void {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // Silent fail - audio may not be available on this device
      });
    }
    if (ctx && pendingBed) {
      const b = pendingBed;
      pendingBed = null;
      setBed(b);
    }
  }

  // --- decoded samples (fetched once per session) --------------------------
  const buffers = new Map<string, Promise<AudioBuffer | null>>();
  const ready = new Map<string, AudioBuffer>();
  function loadBuffer(ctx: AudioContext, file: string): Promise<AudioBuffer | null> {
    let p = buffers.get(file);
    if (!p) {
      const url = audioUrl(file);
      p = !url
        ? Promise.resolve(null)
        : fetch(url)
            .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
            .then((a) => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(a, res, rej)))
            .then((b) => { ready.set(file, b); return b; })
            .catch((err) => { log(`audio ${file} failed`, err); buffers.delete(file); return null; });
      buffers.set(file, p);
    }
    return p;
  }

  // --- the bed: looping layers on the music / sfx buses ---------------------
  let musicBus: GainNode | null = null;
  function mbus(ctx: AudioContext): GainNode {
    if (!musicBus) {
      musicBus = ctx.createGain();
      musicBus.gain.value = silent() ? 0 : musicVolume;
      musicBus.connect(ctx.destination);
    }
    return musicBus;
  }
  interface Playing { gain: GainNode; src: AudioBufferSourceNode | null; dead: boolean }
  const bed = new Map<string, Playing>();
  let pendingBed: BedLayer[] | null = null;
  const FADE = 0.6; // s, time constant of bed fades

  function setBed(layers: BedLayer[]): void {
    try {
      const ctx = audioContext ?? (layers.length ? getAudioContext() : null);
      if (!ctx) {
        pendingBed = layers.length ? layers : null; // starts on the first gesture
        return;
      }
      pendingBed = null;
      const want = new Map(layers.filter((l) => audioUrl(l.file)).map((l) => [l.file, l]));
      const now = ctx.currentTime;
      for (const [file, p] of bed) {
        if (want.has(file)) continue;
        p.dead = true;
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.setTargetAtTime(0, now, FADE / 2);
        const src = p.src;
        window.setTimeout(() => { try { src?.stop(); p.gain.disconnect(); } catch { /* noop */ } }, FADE * 4000);
        bed.delete(file);
      }
      for (const [file, l] of want) {
        const live = bed.get(file);
        if (live) {
          live.gain.gain.setTargetAtTime(l.gain, now, FADE);
          continue;
        }
        const g = ctx.createGain();
        g.gain.value = 0;
        g.connect(l.bus === 'music' ? mbus(ctx) : bus(ctx));
        const p: Playing = { gain: g, src: null, dead: false };
        bed.set(file, p);
        void loadBuffer(ctx, file).then((buf) => {
          if (!buf || p.dead) return;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.loop = true;
          src.connect(g);
          // Ambience starts somewhere inside its loop, so two visits never sound identical.
          src.start(0, l.bus === 'sfx' ? Math.random() * buf.duration : 0);
          p.src = src;
          g.gain.setTargetAtTime(l.gain, ctx.currentTime, FADE);
        });
      }
    } catch (err) {
      log(`bed error: ${err}`);
    }
  }

  function setMusicVolume(v: number): void {
    musicVolume = Math.max(0, Math.min(1, v));
    if (musicBus && audioContext && !silent()) musicBus.gain.setTargetAtTime(musicVolume, audioContext.currentTime, 0.02);
  }

  function warmup(): void {
    const ctx = getAudioContext();
    if (ctx) void loadBuffer(ctx, 'gunshot.mp3');
  }

  // --- synth SFX bus (gunshots + wind): one gain so mute / ad pauses
  // silence everything synthesised at once. ---------------------------------
  let sfxBus: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let echo: { input: GainNode } | null = null;
  function bus(ctx: AudioContext): GainNode {
    if (!sfxBus) {
      sfxBus = ctx.createGain();
      sfxBus.gain.value = silent() ? 0 : sfxVolume;
      sfxBus.connect(ctx.destination);
    }
    return sfxBus;
  }
  function noise(ctx: AudioContext): AudioBuffer {
    if (!noiseBuf) {
      // 2s of seeded white noise, looped / sliced by every voice.
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      let seed = 1873;
      for (let i = 0; i < d.length; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = (seed / 2147483647) * 2 - 1;
      }
    }
    return noiseBuf;
  }
  /** Street acoustics: a slap-back off the facades (two delays, damped
   *  feedback) + a short generated reverb tail. Shared by every shot. */
  function echoSend(ctx: AudioContext): GainNode {
    if (echo) return echo.input;
    const input = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1800;
    input.connect(lp);
    const d1 = ctx.createDelay(1);
    d1.delayTime.value = 0.19;
    const d2 = ctx.createDelay(1);
    d2.delayTime.value = 0.43;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    lp.connect(d1);
    lp.connect(d2);
    d1.connect(fb);
    fb.connect(d1);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    d1.connect(wet);
    d2.connect(wet);
    // Reverb: exponentially decaying noise impulse (1.4s), generated once.
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 1.4);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let seed = 97 + ch * 31;
      for (let i = 0; i < len; i++) {
        seed = (seed * 16807) % 2147483647;
        d[i] = ((seed / 2147483647) * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
    }
    conv.buffer = ir;
    const rev = ctx.createGain();
    rev.gain.value = 0.22;
    lp.connect(conv);
    conv.connect(rev);
    wet.connect(bus(ctx));
    rev.connect(bus(ctx));
    echo = { input };
    return input;
  }
  /** One-shot noise voice: filtered, enveloped, into dst. */
  function noiseHit(ctx: AudioContext, dst: AudioNode, t: number, type: BiquadFilterType, freq: number, q: number,
                    peak: number, attack: number, decay: number): void {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f);
    f.connect(g);
    g.connect(dst);
    src.start(t, Math.random() * 1.5);
    src.stop(t + attack + decay + 0.05);
  }

  /** The pistol sample (Michel Baradari, CC-BY 3.0): same voice chain as the
   *  synth (distance lowpass + street echo send), pitch jittered per shot. */
  function playGunshotSample(ctx: AudioContext, buf: AudioBuffer, volume: number, far: boolean): void {
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = (far ? 0.9 : 1) * (0.95 + Math.random() * 0.1);
    const voice = ctx.createGain();
    voice.gain.value = volume * (far ? 0.55 : 0.9);
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = far ? 2600 : 14000;
    src.connect(voice);
    voice.connect(tone);
    tone.connect(bus(ctx));
    const send = ctx.createGain();
    send.gain.value = far ? 0.8 : 0.4;
    tone.connect(send);
    send.connect(echoSend(ctx));
    src.start(t);
    src.onended = () => { try { voice.disconnect(); tone.disconnect(); send.disconnect(); } catch { /* noop */ } };
  }

  function playGunshot(volume: number = 0.85, far = false): void {
    try {
      if (silent()) return;
      const ctx = getAudioContext();
      if (!ctx) return;
      const buf = ready.get('gunshot.mp3');
      if (buf) return playGunshotSample(ctx, buf, volume, far);
      void loadBuffer(ctx, 'gunshot.mp3'); // next shot has it; this one is synth
      const t = ctx.currentTime + 0.005;
      // Per-shot voice: dry to the bus, plus a send into the street echo.
      const voice = ctx.createGain();
      voice.gain.value = volume * 0.72; // headroom: overlapping shots + echoes stay under clipping
      const tone = ctx.createBiquadFilter(); // distance: air eats the highs
      tone.type = 'lowpass';
      tone.frequency.value = far ? 3200 : 12000;
      voice.connect(tone);
      tone.connect(bus(ctx));
      const send = ctx.createGain();
      send.gain.value = far ? 0.9 : 0.55;
      tone.connect(send);
      send.connect(echoSend(ctx));
      const v = (k: number) => k * (0.92 + Math.random() * 0.16); // no two shots identical
      // 1. Crack: the supersonic snap, a hard bright transient.
      noiseHit(ctx, voice, t, 'bandpass', v(far ? 1800 : 2600), 0.8, v(far ? 0.45 : 1.0), 0.001, far ? 0.05 : 0.07);
      // 2. Boom: the muzzle blast body.
      noiseHit(ctx, voice, t, 'lowpass', v(900), 0.7, v(0.9), 0.002, far ? 0.28 : 0.22);
      // 3. Thump: low sine kick under the blast.
      const osc = ctx.createOscillator();
      const og = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(v(140), t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 0.16);
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(far ? 0.35 : 0.8, t + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(og);
      og.connect(voice);
      osc.start(t);
      osc.stop(t + 0.25);
      // 4. Rumble: the shot rolling off down the street.
      noiseHit(ctx, voice, t + 0.03, 'lowpass', 320, 0.5, v(0.35), 0.03, 0.9);
      window.setTimeout(() => { try { voice.disconnect(); } catch { /* noop */ } }, 1500);
    } catch (err) {
      log(`Synth error: ${err}. Game continues.`);
    }
  }

  // --- wind: looped noise through a bandpass "body" + a narrow whistle,
  // gusts scheduled as smoothed random targets (audio-thread ramps). -------
  let wind: { stop(): void } | null = null;
  function startWind(strength: number, hell = false): void {
    stopWind();
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const k = Math.max(0, Math.min(1, strength));
      if (k <= 0) return;
      const src = ctx.createBufferSource();
      src.buffer = noise(ctx);
      src.loop = true;
      const body = ctx.createBiquadFilter();
      body.type = 'bandpass';
      body.Q.value = 0.6;
      body.frequency.value = hell ? 180 : 420;
      const bodyG = ctx.createGain();
      bodyG.gain.value = 0;
      const whistle = ctx.createBiquadFilter();
      whistle.type = 'bandpass';
      whistle.Q.value = hell ? 2 : 9;
      whistle.frequency.value = hell ? 320 : 950;
      const whistleG = ctx.createGain();
      whistleG.gain.value = 0;
      const master = ctx.createGain();
      master.gain.value = 0;
      src.connect(body);
      body.connect(bodyG);
      bodyG.connect(master);
      src.connect(whistle);
      whistle.connect(whistleG);
      whistleG.connect(master);
      master.connect(bus(ctx));
      src.start();
      const now = ctx.currentTime;
      master.gain.setTargetAtTime(0.5 * k, now, 1.2); // fade in
      let timer = 0;
      const gust = () => {
        const t = ctx.currentTime;
        const g = Math.random();
        const lull = g < 0.3; // calm stretches between gusts
        const lvl = lull ? 0.08 + 0.1 * Math.random() : 0.25 + 0.75 * g;
        const tc = lull ? 1.2 : 0.4 + Math.random() * 0.8;
        bodyG.gain.setTargetAtTime(lvl * 0.6, t, tc);
        body.frequency.setTargetAtTime((hell ? 140 : 300) + lvl * (hell ? 160 : 500), t, tc);
        whistleG.gain.setTargetAtTime(lvl * lvl * (hell ? 0.25 : 0.45) * k, t, tc * 0.8);
        whistle.frequency.setTargetAtTime((hell ? 260 : 750) + lvl * (hell ? 120 : 650) + Math.random() * 120, t, tc);
        timer = window.setTimeout(gust, 1500 + Math.random() * 3500);
      };
      gust();
      wind = {
        stop() {
          window.clearTimeout(timer);
          const t = ctx.currentTime;
          master.gain.cancelScheduledValues(t);
          master.gain.setTargetAtTime(0, t, 0.25);
          window.setTimeout(() => {
            try { src.stop(); master.disconnect(); } catch { /* noop */ }
          }, 1200);
        },
      };
    } catch (err) {
      log(`Wind error: ${err}`);
    }
  }
  function stopWind(): void {
    if (wind) {
      wind.stop();
      wind = null;
    }
  }

  // --- UI: short metallic one-shots, no echo send (dry, close to the ear). --
  /** A struck-metal ping: a sine/triangle partial with a fast exponential decay. */
  function ping(ctx: AudioContext, dst: AudioNode, t: number, freq: number, peak: number, decay: number,
                type: OscillatorType = 'sine'): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g);
    g.connect(dst);
    o.start(t);
    o.stop(t + decay + 0.02);
  }
  /** One click of the action: a bright noise snap + a short metal ping. */
  function metalClick(ctx: AudioContext, dst: AudioNode, t: number, bright: number, peak: number): void {
    noiseHit(ctx, dst, t, 'bandpass', bright, 3, peak, 0.0008, 0.022);
    ping(ctx, dst, t, bright * 0.62, peak * 0.35, 0.05, 'triangle');
  }
  let lastUi = 0;
  function playUiSfx(kind: UiSfx): void {
    try {
      if (silent()) return;
      // Hover never creates or wakes the context (no user gesture yet: Chrome
      // would warn "AudioContext was not allowed to start"); a click may.
      const ctx = kind === 'hover' ? audioContext : getAudioContext();
      if (!ctx) return;
      if (ctx.state !== 'running') {
        if (kind === 'hover') return;
        resumeAudioContext();
      }
      const now = ctx.currentTime;
      if (kind === 'hover' && now - lastUi < 0.04) return; // sweeping across a row of buttons
      lastUi = now;
      const t = now + 0.003;
      const voice = ctx.createGain();
      voice.gain.value = 0.55;
      voice.connect(bus(ctx));
      const j = (k: number) => k * (0.96 + Math.random() * 0.08);
      if (kind === 'hover') {
        // The cylinder turning one notch: a tiny, high, dry tick.
        noiseHit(ctx, voice, t, 'bandpass', j(4200), 5, 0.32, 0.0006, 0.018);
        ping(ctx, voice, t, j(2900), 0.07, 0.03, 'triangle');
      } else {
        // Hammer back: two clicks ~50ms apart, the second (the sear) brighter.
        const dull = kind === 'back';
        metalClick(ctx, voice, t, j(dull ? 1500 : 2100), dull ? 0.32 : 0.42);
        metalClick(ctx, voice, t + 0.052, j(dull ? 2400 : 3600), dull ? 0.38 : 0.5);
        if (kind === 'confirm') {
          // A spur's ring under it: two inharmonic partials, a slower decay.
          ping(ctx, voice, t + 0.06, j(3150), 0.07, 0.32);
          ping(ctx, voice, t + 0.06, j(4730), 0.04, 0.22);
          ping(ctx, voice, t + 0.11, j(3480), 0.04, 0.26);
        }
      }
      window.setTimeout(() => { try { voice.disconnect(); } catch { /* noop */ } }, 600);
    } catch (err) {
      log(`UI sfx error: ${err}`);
    }
  }

  // --- footsteps: townsfolk boots (synth), panned by where the walker is. ---
  let stepN = 0;
  function playFootstep(pan: number, gain: number, surface: 'wood' | 'dirt'): void {
    try {
      if (silent() || gain < 0.01) return;
      const ctx = audioContext; // never the first sound of a session
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.002;
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const voice = ctx.createGain();
      voice.gain.value = gain;
      if (p) {
        p.pan.value = Math.max(-1, Math.min(1, pan));
        voice.connect(p);
        p.connect(bus(ctx));
      } else voice.connect(bus(ctx));
      const j = (k: number) => k * (0.9 + Math.random() * 0.2);
      if (surface === 'wood') {
        // Heel on a hollow plank: a low knock + the board's short resonance.
        noiseHit(ctx, voice, t, 'lowpass', j(420), 0.8, 0.5, 0.002, 0.06);
        noiseHit(ctx, voice, t, 'bandpass', j(950), 6, 0.35, 0.001, 0.035);
        ping(ctx, voice, t, j(190), 0.18, 0.08);
      } else {
        // Boot in packed dirt: a dull thud + a little grit.
        noiseHit(ctx, voice, t, 'lowpass', j(260), 0.7, 0.45, 0.004, 0.07);
        noiseHit(ctx, voice, t + 0.01, 'highpass', j(2600), 0.7, 0.05, 0.004, 0.05);
      }
      // A spur's jingle on every other step.
      if (stepN++ % 2 === 0) ping(ctx, voice, t + 0.02, j(5200), 0.03, 0.12);
      window.setTimeout(() => { try { voice.disconnect(); p?.disconnect(); } catch { /* noop */ } }, 400);
    } catch (err) {
      log(`footstep error: ${err}`);
    }
  }

  async function playSFX(sfx: 'hit-body' | 'hit-head', volume: number = 0.8): Promise<void> {
    try {
      if (silent()) return;

      const filename = sfx === 'hit-body' ? 'hit-body.mp3' : 'hit-head.mp3';
      const url = audioUrl(filename);
      if (!url) return;
      const audio = new Audio(url);
      audio.volume = Math.min(1, volume * sfxVolume);

      audio.play().catch((err) => {
        log(`Failed to play SFX: ${sfx}`, err);
      });
    } catch (err) {
      log(`SFX error: ${err}`);
    }
  }

  function applyMute(): void {
    if (!audioContext) return;
    const t = audioContext.currentTime;
    if (sfxBus) sfxBus.gain.setTargetAtTime(silent() ? 0 : sfxVolume, t, 0.02);
    if (musicBus) musicBus.gain.setTargetAtTime(silent() ? 0 : musicVolume, t, 0.02);
  }

  function setSfxVolume(v: number): void {
    sfxVolume = Math.max(0, Math.min(1, v));
    applyMute();
  }

  function muteForAd(): void {
    adMuted = true;
    applyMute();
  }

  function unmuteAfterAd(): void {
    adMuted = false;
    applyMute();
  }

  function toggleMute(): boolean {
    if (portalMuted) return playerMuted; // the speaker button can't override the site
    playerMuted = !playerMuted;
    applyMute();
    return playerMuted;
  }

  function setPortalMuted(m: boolean): void {
    if (m === portalMuted) return;
    portalMuted = m;
    applyMute();
  }

  function isMuted(): boolean {
    return silent();
  }

  return {
    setBed,
    setMusicVolume,
    playGunshot,
    warmup,
    playFootstep,
    startWind,
    stopWind,
    playSFX,
    playUiSfx,
    setSfxVolume,
    muteForAd,
    unmuteAfterAd,
    toggleMute,
    isMuted,
    setPortalMuted,
    resumeAudioContext,
  };
}
