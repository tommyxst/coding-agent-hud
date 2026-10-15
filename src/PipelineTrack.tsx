import { useEffect, useRef } from 'react';
import type { ActivityState } from './model';

export type MotionState = Lowercase<ActivityState>;

const FLOW_DURATION_MS = 1200;
const CENTER_DURATION_MS = 180;
const BREATH_DURATION_MS = 2600;

export function PipelineTrack({ state, disabled }: { state: MotionState; disabled: boolean }) {
  const track = useRef<HTMLSpanElement>(null);
  const particle = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const element = particle.current!;
    const rail = track.current!;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let animation: Animation | null = null;
    let revision = 0;
    const freeze = () => {
      const style = getComputedStyle(element);
      element.style.transform = style.transform;
      element.style.opacity = style.opacity;
      if (animation) { animation.onfinish = null; animation.cancel(); animation = null; }
    };
    const update = () => {
      const token = ++revision;
      freeze();
      if (disabled || document.hidden || media.matches || state === 'idle' || state === 'starting') {
        element.style.transform = 'translateX(0px)';
        element.style.opacity = state === 'idle' ? '0' : '0.5';
        return;
      }
      const style = getComputedStyle(element);
      const x = style.transform === 'none' ? 0 : new DOMMatrixReadOnly(style.transform).m41;
      const opacity = Number(style.opacity);
      if (state === 'thinking') {
        animation = element.animate([
          { transform: `translateX(${x}px)`, opacity },
          { transform: 'translateX(0px)', opacity: 0.7 },
        ], { duration: CENTER_DURATION_MS, fill: 'forwards', easing: 'ease-out' });
        animation.onfinish = () => {
          if (revision !== token) return;
          animation?.cancel();
          animation = element.animate([
            { transform: 'translateX(0px) scale(1)', opacity: 0.6 },
            { transform: 'translateX(0px) scale(1.4)', opacity: 1 },
            { transform: 'translateX(0px) scale(1)', opacity: 0.6 },
          ], { duration: BREATH_DURATION_MS, iterations: Infinity });
        };
        return;
      }
      const limit = Math.max(0, rail.getBoundingClientRect().width / 2 - 3);
      if (limit === 0) return;
      const direction = state === 'tool_running' ? 1 : -1;
      const from = Math.max(-limit, Math.min(limit, x));
      const target = direction * limit;
      // State changes retarget the same particle from its current position, never its old start.
      animation = element.animate([
        { transform: `translateX(${from}px)`, opacity },
        { transform: `translateX(${from + (target - from) * 0.15}px)`, opacity: 1, offset: 0.15 },
        { transform: `translateX(${target}px)`, opacity: 0 },
      ], { duration: Math.max(1, Math.abs(target - from) / (2 * limit) * FLOW_DURATION_MS), fill: 'forwards', easing: 'linear' });
      animation.onfinish = () => {
        if (revision !== token) return;
        animation?.cancel();
        const start = -target;
        animation = element.animate([
          { transform: `translateX(${start}px)`, opacity: 0 },
          { transform: `translateX(${start + (target - start) * 0.1}px)`, opacity: 1, offset: 0.1 },
          { transform: `translateX(${start + (target - start) * 0.9}px)`, opacity: 1, offset: 0.9 },
          { transform: `translateX(${target}px)`, opacity: 0 },
        ], { duration: FLOW_DURATION_MS, iterations: Infinity, easing: 'linear' });
      };
    };
    const observer = new ResizeObserver(update);
    observer.observe(rail);
    document.addEventListener('visibilitychange', update);
    media.addEventListener('change', update);
    update();
    return () => {
      revision++;
      observer.disconnect();
      document.removeEventListener('visibilitychange', update);
      media.removeEventListener('change', update);
      freeze();
    };
  }, [state, disabled]);
  return <span className="pipeline-track" ref={track} aria-hidden="true"><span className="track-line"/><span className="track-anchor"/><span className="track-particle" ref={particle}/></span>;
}
