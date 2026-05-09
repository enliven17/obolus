// @ts-check
// VCC callback handler — receives fulfillment results from the VCC service.

const { Router } = require('express');
const db = require('../db');
const { enqueueWebhook, scheduleRefund } = require('../fulfillment');
const { verifyVccSignature } = require('../vcc-client');
const { sealCard } = require('../lib/card-vault');
const { normalizeCardBrand } = require('../lib/normalize-card');
const { event: bizEvent } = require('../lib/logger');
const { recordAudit } = require('../lib/audit');

async function dashboardIdForOrder(orderId) {
  const row = /** @type {any} */ (
    await db
      .prepare(
        `SELECT k.dashboard_id AS dashboard_id
         FROM orders o
         LEFT JOIN api_keys k ON o.api_key_id = k.id
         WHERE o.id = ?`,
      )
      .get(orderId)
  );
  return row?.dashboard_id || null;
}

const router = Router();

router.post('/', async (req, res) => {
  const signature = req.headers['x-vcc-signature'];
  const timestamp = req.headers['x-vcc-timestamp'];
  const headerOrderId = req.headers['x-vcc-order-id'];
  const headerNonce = req.headers['x-vcc-nonce'];
  const upstreamRequestId = req.headers['x-request-id'];

  if (upstreamRequestId && upstreamRequestId !== req.id) {
    bizEvent('callback.received', {
      upstream_request_id: upstreamRequestId,
      local_request_id: req.id,
      order_id: headerOrderId || null,
    });
  }

  if (!signature || !timestamp) return res.status(401).json({ error: 'missing_signature' });

  const WIRE_ERROR = {
    missing_fields: 'missing_signature',
    timestamp_expired: 'timestamp_expired',
    bad_signature: 'invalid_signature',
  };

  let storedNonce = null;
  let perOrderSecret = null;
  let orderHasPerOrderSecret = false;
  let orderExistsForPreCheck = false;

  if (headerOrderId) {
    const row = /** @type {any} */ (
      await db
        .prepare(`SELECT id, callback_nonce, callback_secret FROM orders WHERE id = ?`)
        .get(headerOrderId)
    );
    if (row) {
      orderExistsForPreCheck = true;
      if (row.callback_nonce) storedNonce = row.callback_nonce;
      if (row.callback_secret) {
        orderHasPerOrderSecret = true;
        try {
          const { open } = require('../lib/secret-box');
          perOrderSecret = open(row.callback_secret);
        } catch (err) {
          console.warn(
            `[vcc-callback] per-order callback_secret decrypt failed for ${headerOrderId}: ${err.message}`,
          );
          bizEvent('callback.rejected', {
            reason: 'per_order_secret_unavailable',
            order_id: headerOrderId,
            error: err.message,
          });
          return res.status(401).json({ error: 'invalid_signature' });
        }
      }
    }
    if (storedNonce) {
      if (!headerNonce || headerNonce !== storedNonce) {
        bizEvent('callback.rejected', {
          reason: !headerNonce ? 'nonce_missing' : 'nonce_mismatch',
          order_id: headerOrderId,
        });
        return res.status(401).json({ error: 'invalid_signature' });
      }
    }
  }

  const requireV3 = Boolean(storedNonce) || orderHasPerOrderSecret;
  const rawBody = req.rawBody;
  const verdict = verifyVccSignature(
    rawBody,
    signature,
    timestamp,
    headerOrderId,
    storedNonce,
    perOrderSecret,
    { requireV3 },
  );
  if (!verdict.ok) {
    bizEvent('callback.rejected', {
      reason: verdict.reason,
      order_id: headerOrderId || null,
      require_v3: requireV3,
    });
    return res.status(401).json({ error: WIRE_ERROR[verdict.reason] || 'invalid_signature' });
  }
  void orderExistsForPreCheck;

  const { order_id, status, card, error } = req.body;
  if (!order_id || !status) return res.status(400).json({ error: 'missing_fields' });

  if (headerOrderId && headerOrderId !== order_id) {
    bizEvent('callback.rejected', {
      reason: 'order_id_mismatch',
      header_order_id: headerOrderId,
      body_order_id: order_id,
    });
    return res.status(400).json({ error: 'order_id_mismatch' });
  }

  const order = /** @type {any} */ (
    await db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order_id)
  );
  if (!order) return res.status(404).json({ error: 'order_not_found' });

  const TERMINAL = ['delivered', 'failed', 'refunded', 'refund_pending'];
  if (TERMINAL.includes(order.status)) return res.json({ ok: true, note: 'already_terminal' });

  if (status === 'fulfilled' && card) {
    const sealed = sealCard(card);
    const claimed = await db
      .prepare(
        `UPDATE orders
         SET status = 'delivered', card_number = @num, card_cvv = @cvv,
             card_expiry = @expiry, card_brand = @brand, updated_at = NOW()
         WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')`,
      )
      .run({
        id: order_id,
        num: sealed.number,
        cvv: sealed.cvv,
        expiry: sealed.expiry,
        brand: sealed.brand,
      });

    if (claimed.changes === 0) return res.json({ ok: true, note: 'already_terminal_race' });

    if (order.api_key_id) {
      await db
        .prepare(
          `UPDATE api_keys
         SET total_spent_usdc = ROUND((total_spent_usdc::numeric + @amount::numeric), 2)::text
         WHERE id = @id`,
        )
        .run({ id: order.api_key_id, amount: order.amount_usdc });
    }

    bizEvent('order.fulfilled', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
    });

    const dashId = await dashboardIdForOrder(order_id);
    if (dashId) {
      await recordAudit({
        dashboardId: dashId,
        actor: { id: null, email: 'vcc-callback', role: 'system' },
        action: 'order.fulfilled',
        resourceType: 'order',
        resourceId: order_id,
        details: {
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          card_brand: normalizeCardBrand(card.brand),
          api_key_id: order.api_key_id,
        },
        ip: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null,
      });
    }

    const keyRow = /** @type {any} */ (
      order.api_key_id
        ? await db
            .prepare(`SELECT webhook_secret, default_webhook_url FROM api_keys WHERE id = ?`)
            .get(order.api_key_id)
        : null
    );
    const webhookUrl = order.webhook_url || keyRow?.default_webhook_url || null;
    if (webhookUrl) {
      enqueueWebhook(
        webhookUrl,
        {
          order_id,
          status: 'delivered',
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          card: {
            number: card.number,
            cvv: card.cvv,
            expiry: card.expiry,
            brand: normalizeCardBrand(card.brand),
          },
        },
        keyRow?.webhook_secret || null,
      ).catch(() => {});
    }
  } else if (status === 'failed') {
    const { publicMessage } = require('../lib/sanitize-error');
    const safeError = publicMessage(error || 'fulfillment_failed');
    const claimed = await db
      .prepare(
        `UPDATE orders SET status = 'failed', error = @error, updated_at = NOW() WHERE id = @id AND status NOT IN ('delivered', 'failed', 'refunded', 'refund_pending')`,
      )
      .run({ id: order_id, error: safeError });

    if (claimed.changes === 0) return res.json({ ok: true, note: 'already_terminal_race' });

    const dashId = await dashboardIdForOrder(order_id);
    if (dashId) {
      await recordAudit({
        dashboardId: dashId,
        actor: { id: null, email: 'vcc-callback', role: 'system' },
        action: 'order.failed',
        resourceType: 'order',
        resourceId: order_id,
        details: {
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          api_key_id: order.api_key_id,
          error: safeError,
        },
        ip: req.ip || req.headers?.['x-forwarded-for'] || null,
        userAgent: req.headers?.['user-agent'] || null,
      });
    }

    bizEvent('order.failed', {
      order_id,
      amount_usd: order.amount_usdc,
      payment_asset: order.payment_asset,
      api_key_id: order.api_key_id,
      error,
    });

    const failedOrder = /** @type {any} */ (
      await db
        .prepare(
          `SELECT o.webhook_url, k.webhook_secret, k.default_webhook_url FROM orders o LEFT JOIN api_keys k ON o.api_key_id = k.id WHERE o.id = ?`,
        )
        .get(order_id)
    );
    const failureWebhookUrl = failedOrder?.webhook_url || failedOrder?.default_webhook_url || null;
    if (failureWebhookUrl) {
      enqueueWebhook(
        failureWebhookUrl,
        {
          order_id,
          status: 'failed',
          amount_usdc: order.amount_usdc,
          payment_asset: order.payment_asset,
          error: safeError,
        },
        failedOrder?.webhook_secret || null,
      ).catch(() => {});
    }

    scheduleRefund(order_id).catch(() => {});
  } else {
    return res.status(400).json({ error: 'invalid_status' });
  }

  res.json({ ok: true });
});

module.exports = router;
