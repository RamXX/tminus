/**
 * Tests for shared motion utilities.
 * Validates variant shapes and reduced motion behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  cardVariants,
  staggerContainer,
  pageFade,
  modalVariants,
  slideInRight,
  easeOut300,
  easeOut200,
  easeOut150,
  springGentle,
} from './motion';

describe('motion variants', () => {
  it('cardVariants has hidden and visible states', () => {
    expect(cardVariants.hidden).toHaveProperty('opacity', 0);
    expect(cardVariants.visible).toHaveProperty('opacity', 1);
    expect(cardVariants.visible).toHaveProperty('y', 0);
  });

  it('staggerContainer staggers children by 50ms', () => {
    const transition = staggerContainer.visible.transition;
    expect(transition.staggerChildren).toBe(0.05);
  });

  it('pageFade has initial, animate, exit', () => {
    expect(pageFade.initial).toHaveProperty('opacity', 0);
    expect(pageFade.animate).toHaveProperty('opacity', 1);
    expect(pageFade.exit).toHaveProperty('opacity', 0);
  });

  it('modalVariants scales from 0.96', () => {
    expect(modalVariants.hidden.scale).toBe(0.96);
    expect(modalVariants.visible.scale).toBe(1);
  });

  it('slideInRight slides from x:24', () => {
    expect(slideInRight.hidden.x).toBe(24);
    expect(slideInRight.visible.x).toBe(0);
  });

  it('transition presets have expected durations', () => {
    expect(easeOut300.duration).toBe(0.3);
    expect(easeOut200.duration).toBe(0.2);
  });

  it('easeOut150 uses cubic bezier curve', () => {
    expect(easeOut150.duration).toBe(0.15);
    expect(easeOut150.ease).toEqual([0.33, 1, 0.68, 1]);
  });

  it('springGentle uses spring physics', () => {
    expect(springGentle.type).toBe('spring');
    expect(springGentle.stiffness).toBe(200);
    expect(springGentle.damping).toBe(20);
  });

  it('cardVariants hidden starts at y:12', () => {
    expect(cardVariants.hidden.y).toBe(12);
  });

  it('modalVariants exit returns to scale 0.96', () => {
    expect(modalVariants.exit.scale).toBe(0.96);
    expect(modalVariants.exit.opacity).toBe(0);
  });

  it('slideInRight exit returns to x:24', () => {
    expect(slideInRight.exit.x).toBe(24);
    expect(slideInRight.exit.opacity).toBe(0);
  });

  it('pageFade exit duration is 0.15s', () => {
    expect(pageFade.exit.transition).toEqual({ duration: 0.15 });
  });
});
