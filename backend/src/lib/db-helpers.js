// @ts-check
// Async wrappers around the PostgreSQL db.prepare() API.
// Centralises the cast so route handlers can be type-clean without annotation noise.

const db = require('../db');

/**
 * Run a SELECT that returns a single row (or undefined).
 * @param {string} sql
 * @param  {...any} params
 * @returns {Promise<any>}
 */
async function getOne(sql, ...params) {
  return db.prepare(sql).get(...params);
}

/**
 * Run a SELECT that returns an array of rows.
 * @param {string} sql
 * @param  {...any} params
 * @returns {Promise<any[]>}
 */
async function getAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/**
 * Run a mutating statement (INSERT/UPDATE/DELETE).
 * @param {string} sql
 * @param  {...any} params
 * @returns {Promise<{changes: number}>}
 */
async function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

/**
 * Return an async iterator for streaming rows (e.g. CSV export).
 * @param {string} sql
 * @param  {...any} params
 * @returns {AsyncIterableIterator<any>}
 */
function iterate(sql, ...params) {
  return db.prepare(sql).iterate(...params);
}

module.exports = { getOne, getAll, run, iterate };
