/**
 * Short, quiet signal tones (setting "Ton bei Fehlern" / "Ton, wenn alles
 * hochgeladen ist"). Generated with the Web Audio API so no sound files are
 * needed; both tones stay under half a second.
 */

let ctx: AudioContext | null = null;

function tone(freqs: number[], step: number, volume: number) {
  try {
    ctx = ctx ?? new AudioContext();
    const start = ctx.currentTime + 0.01;
    freqs.forEach((f, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const t = start + i * step;
      // Soft attack and decay so the tone does not click.
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + step * 1.6);
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + step * 1.7);
    });
  } catch {
    // No audio output available: stay silent.
  }
}

/** Two falling tones: something failed. */
export const playErrorSound = () => tone([660, 440], 0.14, 0.12);

/** Two rising tones: everything was uploaded. */
export const playDoneSound = () => tone([784, 1047], 0.11, 0.08);
