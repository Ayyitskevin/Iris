/**
 * Devices are the unit the sync gate counts (ADR-007). Registering a device is where
 * the plan limit is enforced. Sync endpoints accept only an explicitly registered
 * device, so read-only agents cannot allocate billable workspace state.
 */
import { and, eq } from 'drizzle-orm';
import { devices, workspaces } from '../db/schema';
import type { Ctx } from '../context';
import { forbidden, paymentRequired } from '../lib/errors';
import { countDevices, deviceLimit, getSubscription } from './billing';

async function findDevice(ctx: Ctx, id: string) {
  const rows = await ctx.db
    .select()
    .from(devices)
    .where(and(eq(devices.id, id), eq(devices.workspaceId, ctx.workspaceId)));
  return rows[0];
}

async function touchDevice(
  ctx: Ctx,
  id: string,
  meta?: { name?: string; platform?: string },
): Promise<void> {
  await ctx.db
    .update(devices)
    .set({
      lastSeenAt: new Date(),
      ...(meta?.name ? { name: meta.name } : {}),
      ...(meta?.platform ? { platform: meta.platform } : {}),
    })
    .where(and(eq(devices.id, id), eq(devices.workspaceId, ctx.workspaceId)));
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
    await touchDevice(ctx, id, meta);
    return;
  }

  // Every request already runs in one workspace transaction. Locking its durable
  // workspace row serializes count + insert for all device ids in that workspace.
  await ctx.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.id, ctx.workspaceId))
    .for('update');

  // A concurrent registration of this same workspace/device may have committed while
  // this transaction waited for the workspace lock. It is an update, not another slot.
  const afterLock = await findDevice(ctx, id);
  if (afterLock) {
    await touchDevice(ctx, id, meta);
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

/** Gate for sync endpoints: only a signed-in user may create the device beforehand. */
export async function requireRegisteredDevice(ctx: Ctx, deviceId: string): Promise<void> {
  const existing = await findDevice(ctx, deviceId);
  if (!existing) {
    throw forbidden('This device must be registered by a signed-in user before syncing');
  }
  await touchDevice(ctx, deviceId);
}
