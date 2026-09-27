/**
 * Reading sprite animations as the editor saves them.
 *
 * An object type's `animations` is a folder tree: `{ "items": [...],
 * "subfolders": [...] }`, where each item is an animation with its `frames`
 * and each subfolder is again `{ items, subfolders }` (plus its name).
 * Every animation in every subfolder counts. A bare array of animations is
 * accepted as well.
 */

import type { Animation } from '../types.js';

const MAX_DEPTH = 50;

/** Every animation in an object type's `animations` tree, subfolders included. */
export function listAnimations(animations: unknown): Animation[] {
  const out: Animation[] = [];
  const walk = (container: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || !container || typeof container !== 'object') return;
    if (Array.isArray(container)) {
      for (const anim of container) {
        if (anim && typeof anim === 'object' && !Array.isArray(anim)) out.push(anim as Animation);
      }
      return;
    }
    const { items, subfolders } = container as { items?: unknown; subfolders?: unknown };
    if (Array.isArray(items)) walk(items, depth);
    if (Array.isArray(subfolders)) {
      for (const sub of subfolders) walk(sub, depth + 1);
    }
  };
  walk(animations, 0);
  return out;
}

/** Number of frames of one animation (0 when `frames` is missing or malformed). */
export function animationFrameCount(animation: Animation): number {
  return Array.isArray(animation.frames) ? animation.frames.length : 0;
}

/** Total frames and animations in an object type's `animations` tree. */
export function countAnimationFrames(animations: unknown): { animations: number; frames: number } {
  const list = listAnimations(animations);
  return {
    animations: list.length,
    frames: list.reduce((sum, anim) => sum + animationFrameCount(anim), 0),
  };
}
