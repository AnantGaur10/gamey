export type MusicTrack = 'home-screen' | 'duel';

export interface AudioManager {
  playMusic(track: MusicTrack): Promise<void>;
  stopMusic(): void;
  setMusicVolume(v: number): void;
  playGunshotSynth(volume?: number): void;
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

  function playGunshotSynth(volume: number = 0.85): void {
    try {
      if (muted) return;

      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      filter.type = 'highpass';
      filter.frequency.value = 100;

      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);

      gain.gain.setValueAtTime(volume, now);
      gain.gain.exponentialRampToValueAtTime(0.1, now + 0.05);
      gain.gain.exponentialRampToValueAtTime(0, now + 0.15);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.15);
    } catch (err) {
      log(`Synth error: ${err}. Game continues.`);
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

  function muteForAd(): void {
    wasPlayingBeforeAd = currentMusic !== null && !currentMusic.paused;
    if (currentMusic) {
      currentMusic.pause();
    }
  }

  function unmuteAfterAd(): void {
    if (wasPlayingBeforeAd && currentMusic) {
      currentMusic.play().catch((err) => {
        log('Failed to resume music after ad:', err);
      });
    }
  }

  function toggleMute(): boolean {
    muted = !muted;

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
    playSFX,
    muteForAd,
    unmuteAfterAd,
    toggleMute,
    isMuted,
    resumeAudioContext,
  };
}
