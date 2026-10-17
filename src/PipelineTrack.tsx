import { useEffect, useRef } from 'react';
import type { ActivityState } from './model';
import { shouldAnimateTrack, stepParticle, TRACK_CENTER, trackTarget } from './visual';

export type MotionState = Lowercase<ActivityState>;

function hiddenNow(): boolean {
  return document.hidden || document.documentElement.dataset.hidden === 'true';
}

export function PipelineTrack({ state, disabled }: { state: MotionState; disabled: boolean }) {
  const particle = useRef<SVGCircleElement>(null);
  const x = useRef(TRACK_CENTER);
  useEffect(() => {
    const node = particle.current;
    if (!node) return;
    let frame = 0;
    let last = 0;
    let stopped = false;
    const paint = (time: number) => {
      const scale = state === 'thinking' ? 1 + 0.35 * (0.5 + 0.5 * Math.sin(time / 1300)) : 1;
      node.setAttribute('cx', x.current.toFixed(2));
      node.setAttribute('cy', '10');
      node.setAttribute('r', (2.4 * scale).toFixed(2));
      node.setAttribute('opacity', state === 'idle' ? '0' : state === 'starting' ? '0.5' : '1');
    };
    const loop = (time: number) => {
      if (stopped) return;
      if (!shouldAnimateTrack(state, disabled, hiddenNow())) {
        paint(time);
        return;
      }
      const dt = last === 0 ? 16 : Math.min(48, time - last);
      last = time;
      x.current = stepParticle(x.current, trackTarget(state), dt);
      paint(time);
      frame = requestAnimationFrame(loop);
    };
    paint(0);
    if (shouldAnimateTrack(state, disabled, hiddenNow())) frame = requestAnimationFrame(loop);
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (shouldAnimateTrack(state, disabled, hiddenNow())) frame = requestAnimationFrame(loop);
      else paint(0);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state, disabled]);
  return <svg className="pipeline-track" viewBox="0 0 100 20" aria-hidden="true">
    <line className="track-line" x1="4" y1="10" x2="96" y2="10"/>
    <circle className="track-anchor" cx="50" cy="10" r="3.5"/>
    <circle className="track-particle" ref={particle}/>
  </svg>;
}
