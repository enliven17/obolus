// @ts-check
// requireDashboard middleware — looks up the dashboard for req.user.
// Must be used after requireAuth. Attaches req.dashboard on success.

const db = require('../db');

const DUP_CHECK_LIMIT = 2;

module.exports = async function requireDashboard(req, res, next) {
  if (!req.user || typeof req.user.id !== 'string' || req.user.id.length === 0) {
    return res.status(401).json({
      error: 'unauthenticated',
      message: 'This endpoint requires an authenticated user session.',
    });
  }

  const rows = /** @type {any[]} */ (
    await db
      .prepare(
        `SELECT * FROM dashboards
         WHERE user_id = ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(req.user.id, DUP_CHECK_LIMIT)
  );

  if (rows.length === 0) {
    return res
      .status(404)
      .json({ error: 'no_dashboard', message: 'No dashboard found. Please contact support.' });
  }

  if (rows.length > 1) {
    console.warn(
      `[requireDashboard] user ${req.user.id} has multiple dashboard rows ` +
        `(detected ${rows.length}+). Using earliest: id=${rows[0].id}. ` +
        `Ops: investigate duplicates in dashboards table.`,
    );
  }

  req.dashboard = rows[0];
  next();
};
