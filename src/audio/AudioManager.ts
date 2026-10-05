export type MusicTrack = 'home-screen' | 'duel';

export interface AudioManager {
  playMusic(track: MusicTrack): Promise<void>;
  stopMusic(): void;
  setMusicVolume(v: number): void;
  /** Synthesised revolver shot (Web Audio, zero shipped bytes). far = the
   *  foe's shot down the street: quieter, duller, more echo. */
  playGunshotSynth(volume?: number, far?: boolean): void;
  /** Gusting wind bed for the duel (Web Audio noise). 0 = off ... 1 = gale;
   *  hell = a low hot roar instead of a whistle. */
  startWind(strength: number, hell?: boolean): void;
  stopWind(): void;
  playSFX(sfx: 'hit-body' | 'hit-head', volume?: number): Promise<void>;
  muteForAd(): void;
  unmuteAfterAd(): void;
  toggleMute(): boolean;
  isMuted(): boolean;
  resumeAudioContext(): void;
}

// Audio failures are expected (no music files yet, autoplay policy, no
// AudioContext) and the game plays on silently: log in dev only.
function log(...args: unknown[]): void {
  if (import.meta.env.DEV) console.log(...args);
}

export function createAudioManager(): AudioManager {
  let audioContext: AudioContext | null = null;
  let muted = false;
  let currentMusic: HTMLAudioElement | null = null;
  let musicVolume = 0.5;
  let sfxVolume = 0.8;
  let wasPlayingBeforeAd = false;

  function getAudioContext(): AudioContext | null {
    try {
      if (!audioContext) {
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
  }

  // Music files land in Phase 3 (tail); until then HEAD-probe first so a
  // missing file is a silent skip, never a console 404 (QA noise). URL is
  // BASE_URL-relative (relative-paths-only portal rule — never absolute).
  async function resolveMusicUrl(filename: string): Promise<string | null> {
    try {
      const url = `${import.meta.env.BASE_URL}assets/music/${filename}`;
      const res = await fetch(url, { method: "HEAD" });
      return res.ok ? url : null;
    } catch {
      return null;
    }
  }

  async function loadMusicTrack(track: MusicTrack): Promise<HTMLAudioElement | null> {
    try {
      const filename = track === 'home-screen' ? 'home-screen.mp3' : 'duel.mp3';
      const url = await resolveMusicUrl(filename);
      if (!url) return null;
      const audio = new Audio(url);
      audio.loop = true;
      audio.volume = muted ? 0 : musicVolume;

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Audio load timeout'));
        }, 5000);

        audio.oncanplay = () => {
          clearTimeout(timeout);
          resolve(audio);
        };

        audio.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };

        audio.load();
      });
    } catch (err) {
      log(`Audio file not found or error loading: ${track}`, err);
      return null;
    }
  }

  async function playMusic(track: MusicTrack): Promise<void> {
    try {
      if (currentMusic) {
        currentMusic.pause();
        currentMusic = null;
      }

      const audio = await loadMusicTrack(track);
      if (!audio) {
        log(`Skipping music track: ${track} (file not found)`);
        return;
      }

      currentMusic = audio;
      if (!muted) {
        audio.play().catch((err) => {
          log(`Failed to play music: ${err}`);
        });
      }
    } catch (err) {
      log(`Audio error: ${err}. Game continues.`);
    }
  }

  function stopMusic(): void {
    if (currentMusic) {
      currentMusic.pause();
      currentMusic.currentTime = 0;
      currentMusic = null;
    }
  }

  function setMusicVolume(v: number): void {
    musicVolume = Math.max(0, Math.min(1, v));
    if (currentMusic) {
      currentMusic.volume = muted ? 0 : musicVolume;
    }
  }

  // --- synth SFX bus (gunshots + wind): one gain so mute / ad pauses
  // silence everything synthesised at once. ---------------------------------
  let sfxBus: GainNode | null = null;
  let noiseBuf: AudioBuffer | null = null;
  let echo: { input: GainNode } | null = null;
  function bus(ctx: AudioContext): GainNode {
    if (!sfxBus) {
      sfxBus = ctx.createGain();
      sfxBus.gain.value = muted ? 0 : 1;
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

  function playGunshotSynth(volume: number = 0.85, far = false): void {
    try {
      if (muted) return;
      const ctx = getAudioContext();
      if (!ctx) return;
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

  async function playSFX(sfx: 'hit-body' | 'hit-head', volume: number = 0.8): Promise<void> {
    try {
      if (muted) return;

      const filename = sfx === 'hit-body' ? 'hit-body.mp3' : 'hit-head.mp3';
      const url = await resolveMusicUrl(filename);
      if (!url) return;
      const audio = new Audio(url);
      audio.volume = volume;

      audio.play().catch((err) => {
        log(`Failed to play SFX: ${sfx}`, err);
      });
    } catch (err) {
      log(`SFX error: ${err}`);
    }
  }

  function setBus(on: boolean): void {
    if (sfxBus && audioContext) sfxBus.gain.setTargetAtTime(on ? 1 : 0, audioContext.currentTime, 0.02);
  }

  function muteForAd(): void {
    setBus(false);
    wasPlayingBeforeAd = currentMusic !== null && !currentMusic.paused;
    if (currentMusic) {
      currentMusic.pause();
    }
  }

  function unmuteAfterAd(): void {
    if (!muted) setBus(true);
    if (wasPlayingBeforeAd && currentMusic) {
      currentMusic.play().catch((err) => {
        log('Failed to resume music after ad:', err);
      });
    }
  }

  function toggleMute(): boolean {
    muted = !muted;
    setBus(!muted);

    if (currentMusic) {
      if (muted) {
        currentMusic.pause();
      } else {
        currentMusic.volume = musicVolume;
        currentMusic.play().catch((err) => {
          log('Failed to resume music:', err);
        });
      }
    }

    return muted;
  }

  function isMuted(): boolean {
    return muted;
  }

  return {
    playMusic,
    stopMusic,
    setMusicVolume,
    playGunshotSynth,
    startWind,
    stopWind,
    playSFX,
    muteForAd,
    unmuteAfterAd,
    toggleMute,
    isMuted,
    resumeAudioContext,
  };
}
