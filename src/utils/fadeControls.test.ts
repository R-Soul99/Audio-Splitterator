import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTestFadeControls, isFadeCurveVisible, FadeControlGeometry } from './fadeControls';

const control: FadeControlGeometry = { target: 'fadeIn', enabled: true, durationMs: 1000,
  anchorX: 0, lengthX: 100, curveX: 50, curveY: 100 };
test('curve visibility requires both duration and displayed width', () => {
  assert.equal(isFadeCurveVisible(999, 100), false);
  assert.equal(isFadeCurveVisible(1000, 47), false);
  assert.equal(isFadeCurveVisible(1000, 48), true);
  assert.equal(isFadeCurveVisible(1000, -48), true);
});
test('length wins when its invisible target overlaps a curve target', () => {
  assert.equal(hitTestFadeControls(100, 10, [{ ...control, curveX: 100, curveY: 10 }]), 'fadeIn');
  assert.equal(hitTestFadeControls(112, 10, [control]), 'fadeIn');
});
test('curve targets are distinct and hidden curve targets cannot capture drags', () => {
  assert.equal(hitTestFadeControls(50, 100, [control]), 'fadeInCurve');
  assert.equal(hitTestFadeControls(50, 100, [{ ...control, target: 'fadeOut' }]), 'fadeOutCurve');
  assert.equal(hitTestFadeControls(50, 100, [{ ...control, durationMs: 999 }]), null);
  assert.equal(hitTestFadeControls(50, 100, [{ ...control, lengthX: 47 }]), null);
  assert.equal(hitTestFadeControls(50, 100, [{ ...control, enabled: false }]), null);
});
test('unrelated waveform positions remain available and testing preserves curve geometry', () => {
  const before = { ...control };
  assert.equal(hitTestFadeControls(200, 150, [control]), null);
  hitTestFadeControls(50, 100, [control]);
  assert.deepEqual(control, before);
});
