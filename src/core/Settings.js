/**
 * Graphics/gameplay settings with localStorage persistence.
 * Quality presets scale the expensive knobs together so the automated capture
 * harness and low-end machines land on sane combinations.
 */
const PRESETS = {
  low: {
    renderScale: 0.75, shadowMapSize: 1024, cascades: 2, ssao: false, ssr: false,
    bloomLevels: 4, motionBlur: false, taa: false, volumetrics: false, dof: false,
    particleBudget: 400, decalBudget: 64, anisotropy: 4,
  },
  medium: {
    renderScale: 0.85, shadowMapSize: 1536, cascades: 3, ssao: true, ssr: false,
    bloomLevels: 5, motionBlur: false, taa: true, volumetrics: false, dof: true,
    particleBudget: 1200, decalBudget: 128, anisotropy: 8,
  },
  high: {
    renderScale: 1.0, shadowMapSize: 2048, cascades: 4, ssao: true, ssr: true,
    bloomLevels: 6, motionBlur: true, taa: true, volumetrics: true, dof: true,
    particleBudget: 3000, decalBudget: 256, anisotropy: 16,
  },
  ultra: {
    renderScale: 1.0, shadowMapSize: 3072, cascades: 4, ssao: true, ssr: true,
    bloomLevels: 7, motionBlur: true, taa: true, volumetrics: true, dof: true,
    particleBudget: 6000, decalBudget: 512, anisotropy: 16,
  },
};

export class Settings {
  constructor() {
    this.preset = 'ultra';
    Object.assign(this, PRESETS.ultra);

    // Player-facing knobs, independent of preset.
    this.fov = 90;
    this.sensitivity = 1.0;
    this.invertY = false;
    this.exposure = 1.0;
    this.filmGrain = 0.5;
    this.chromaticAberration = 0.45;
    this.vignette = 0.6;
    this.sharpen = 0.35;
    this.viewmodelFov = 60;
    this.showFps = false;
    this.masterVolume = 0.9;

    this.load();
  }

  applyPreset(name) {
    if (!PRESETS[name]) return;
    this.preset = name;
    Object.assign(this, PRESETS[name]);
    this.save();
  }

  load() {
    try {
      const raw = localStorage.getItem('blackout.settings');
      if (raw) Object.assign(this, JSON.parse(raw));
    } catch { /* first run or private mode */ }
  }

  save() {
    try {
      localStorage.setItem('blackout.settings', JSON.stringify(this));
    } catch { /* quota or private mode: settings stay session-local */ }
  }
}

export { PRESETS };
