import { LoopPreset } from './loopMemory';
export interface PresetBar { slot: number; lane: number; left: number; right: number; start: number; end: number }
export const PRESET_STRIP_HEIGHT = 22;
export function presetStrip(slots: (LoopPreset | null)[], rate: number, offset: number, span: number, width: number) {
  const lanes = [-Infinity, -Infinity, -Infinity];
  const bars: PresetBar[] = [], overflow: number[] = [];
  if (rate <= 0 || span <= 0 || width <= 0) return { bars, overflow };
  // Assign on stored sample positions (not clipped pixels), stable while zooming.
  slots.map((preset, slot) => ({ preset, slot })).filter(item => item.preset).sort((a, b) => a.preset!.start - b.preset!.start || a.preset!.end - b.preset!.end || a.slot - b.slot).forEach(({ preset: p, slot }) => {
    const lane = lanes.findIndex(end => end <= p!.start);
    if (lane !== -1) lanes[lane] = p!.end;
    const start = p!.start / rate, end = p!.end / rate;
    if (end <= offset || start >= offset + span) return;
    if (lane === -1) { overflow.push(slot); return; }
    bars.push({ slot, lane, start, end, left: Math.max(0, (start - offset) / span * width), right: Math.min(width, (end - offset) / span * width) });
  });
  return { bars, overflow };
}
export function drawPresetStrip(ctx: CanvasRenderingContext2D, layout: ReturnType<typeof presetStrip>, width: number, active: number | null) {
  ctx.save(); ctx.fillStyle = 'rgba(2,6,23,.92)'; ctx.fillRect(0, 0, width, PRESET_STRIP_HEIGHT);
  ctx.font = '7px monospace'; ctx.textBaseline = 'middle';
  for (const bar of layout.bars) {
    ctx.fillStyle = bar.slot === active ? '#38bdf8' : '#475569';
    ctx.fillRect(bar.left, 1 + bar.lane * 7, Math.max(1, bar.right - bar.left), 6);
    if (bar.right - bar.left >= 12) { ctx.fillStyle = bar.slot === active ? '#020617' : '#cbd5e1'; ctx.fillText(String(bar.slot), bar.left + 3, 4 + bar.lane * 7); }
  }
  if (layout.overflow.length) { const label = `+${layout.overflow.length}`; ctx.fillStyle = '#020617'; ctx.fillRect(width - 25, 0, 25, PRESET_STRIP_HEIGHT); ctx.fillStyle = active !== null && layout.overflow.includes(active) ? '#38bdf8' : '#94a3b8'; ctx.fillText(label, width - 22, 11); }
  ctx.restore();
}
