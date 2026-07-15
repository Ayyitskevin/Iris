/**
 * Devices are the unit the sync gate counts (ADR-007). Registering a device is where
 * the plan limit is enforced; syncing from an unregistered device auto-registers it,
 * so the 402 lands exactly when a free workspace reaches for a second device.
 */
import { and, eq } from 'drizzle-orm';
import { devices } from '../db/schema';
import type { Ctx } from '../context';
import { paymentRequired } from '../lib/errors';
import { countDevices, deviceLimit, getSubscription } from './billing';

async function findDevice(ctx: Ctx, id: string) {
  const rows = await ctx.db
    .select()
    .from(devices)
    .where(and(eq(devices.id, id), eq(devices.workspaceId, ctx.workspaceId)));
  return rows[0];
}

/**
 * Ensure a device exists in this workspace, enforcing the plan's device limit on the
 * FIRST registration of a new device. Existing devices always pass (they just get a
 * fresh lastSeenAt), so paying customers who downgrade keep their already-synced
 * devices working.
 */
export async function ensureDevice(
  ctx: Ctx,
  id: string,
  meta?: { name?: string; platform?: string },
): Promise<void> {
  const existing = await findDevice(ctx, id);
  if (existing) {
    await ctx.db
      .update(devices)
      .set({
        lastSeenAt: new Date(),
        ...(meta?.name ? { name: meta.name } : {}),
        ...(meta?.platform ? { platform: meta.platform } : {}),
      })
      .where(and(eq(devices.id, id), eq(devices.workspaceId, ctx.workspaceId)));
    return;
  }

  const { plan, status } = await getSubscription(ctx);
  const limit = deviceLimit(plan, status);
  const active = await countDevices(ctx);
  if (active >= limit) {
    throw paymentRequired(
      'Your plan allows syncing one device. Subscribe to Iris Sync to add more.',
    );
  }

  await ctx.db.insert(devices).values({
    id,
    workspaceId: ctx.workspaceId,
    name: meta?.name ?? 'Unnamed device',
    platform: meta?.platform ?? 'unknown',
  });
}

export async function registerDevice(
  ctx: Ctx,
  input: { id: string; name: string; platform: string },
): Promise<{ activeDevices: number }> {
  await ensureDevice(ctx, input.id, { name: input.name, platform: input.platform });
  return { activeDevices: await countDevices(ctx) };
}

/** Gate for the sync endpoints: the device must be (or become) a registered device. */
export async function requireRegisteredDevice(ctx: Ctx, deviceId: string): Promise<void> {
  await ensureDevice(ctx, deviceId);
}
