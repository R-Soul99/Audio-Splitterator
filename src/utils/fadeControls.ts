export type FadeTarget = 'fadeIn' | 'fadeOut' | 'fadeInCurve' | 'fadeOutCurve';
export const CURVE_MIN_DURATION_MS = 1000;
export const CURVE_MIN_WIDTH_PX = 48;
export const FADE_LENGTH_HIT_RADIUS = 14;
export const FADE_CURVE_HIT_RADIUS = 11;

export function isFadeCurveVisible(durationMs: number, widthPx: number): boolean {
  return durationMs >= CURVE_MIN_DURATION_MS && Math.abs(widthPx) >= CURVE_MIN_WIDTH_PX;
}

export interface FadeControlGeometry {
  target: 'fadeIn' | 'fadeOut'; enabled: boolean; durationMs: number;
  anchorX: number; lengthX: number; curveX: number; curveY: number;
}

export function hitTestFadeControls(x: number, y: number, controls: FadeControlGeometry[]): FadeTarget | null {
  // All length targets take priority over every curve target.
  for (const control of controls) {
    if (!control.enabled) continue;
    if (Math.hypot(x - control.lengthX, y - 10) <= FADE_LENGTH_HIT_RADIUS ||
      (control.durationMs <= 50 && Math.hypot(x - control.anchorX, y - 10) <= FADE_LENGTH_HIT_RADIUS)) return control.target;
  }
  for (const control of controls) {
    if (control.enabled && isFadeCurveVisible(control.durationMs, control.lengthX - control.anchorX) &&
      Math.hypot(x - control.curveX, y - control.curveY) <= FADE_CURVE_HIT_RADIUS) return `${control.target}Curve`;
  }
  return null;
}
