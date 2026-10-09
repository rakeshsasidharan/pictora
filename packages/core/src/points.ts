import type { Aspect, ModelConfig, Quality } from './registry.js';
import { mapAspect } from './size_mapping.js';

/** Points granted to a user each UTC day unless their profile overrides it (LIM-1). */
export const DEFAULT_DAILY_POINTS = 25;

/** One point is worth one US cent of provider list price. */
export const CENTS_PER_POINT = 1;

/** Images per request (GEN-6). */
export const MIN_IMAGE_COUNT = 1;
export const MAX_IMAGE_COUNT = 4;

/** The change to a user's daily usage when a job finishes. */
export interface PointsSettlement {
  /** Points the job finally costs the user. */
  chargedPoints: number;
  /** Amount to `ADD` to `USAGE#<date>.used`: zero or negative, since points were reserved up front. */
  usageDelta: number;
}

/** Provider cost in cents as whole points, rounded up. */
export function pointsForCents(cents: number): number {
  if (!Number.isFinite(cents) || cents < 0) throw new RangeError(`Invalid cost in cents: ${cents}`);
  return Math.ceil(cents / CENTS_PER_POINT);
}

/**
 * Points to reserve for a request (tech design 4.1): the quality's cost per image times the image count.
 * Throws when the model doesn't offer the quality or aspect, or the count is outside 1–4.
 */
export function estimatePoints(
  model: ModelConfig,
  quality: Quality,
  aspect: Aspect,
  count: number,
): number {
  if (!Number.isInteger(count) || count < MIN_IMAGE_COUNT || count > MAX_IMAGE_COUNT) {
    throw new RangeError(
      `Image count must be an integer from ${MIN_IMAGE_COUNT} to ${MAX_IMAGE_COUNT}: ${count}`,
    );
  }
  mapAspect(model, aspect, quality);
  const costPoints = model.qualities[quality]?.costPoints ?? 0;
  return costPoints * count;
}

/**
 * Settles a finished job. The user pays the actual cost rounded up to points, but never more than was reserved;
 * the platform absorbs any overrun.
 */
export function settlePoints(reservedPoints: number, actualCostCents: number): PointsSettlement {
  assertPoints(reservedPoints);
  const chargedPoints = Math.min(reservedPoints, pointsForCents(actualCostCents));
  return { chargedPoints, usageDelta: chargedPoints - reservedPoints };
}

/** Returns every reserved point, for a failed or blocked job (GEN-10). */
export function refundPoints(reservedPoints: number): PointsSettlement {
  assertPoints(reservedPoints);
  return { chargedPoints: 0, usageDelta: -reservedPoints };
}

function assertPoints(points: number): void {
  if (!Number.isInteger(points) || points < 0) throw new RangeError(`Invalid points: ${points}`);
}
