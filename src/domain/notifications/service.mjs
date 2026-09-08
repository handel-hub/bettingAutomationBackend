// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import crypto from 'crypto';

/**
 * Fetch notifications feed for an account.
 * @param {string} accountId 
 * @param {Object} [options]
 * @param {boolean} [options.unreadOnly]
 * @param {string} [options.severity]
 * @returns {Promise<{ notifications: Object[], unreadCount: number }>}
 */
export async function listNotifications(accountId, options = {}) {
  const pool = getPool();
  const { unreadOnly = false, severity = 'ALL' } = options;

  let query = 'SELECT * FROM notifications WHERE account_id = $1';
  const params = [accountId];
  let paramIdx = 2;

  if (unreadOnly) {
    query += ' AND is_read = false';
  }

  if (severity && severity !== 'ALL') {
    query += ` AND severity = $${paramIdx++}`;
    params.push(severity);
  }

  query += ' ORDER BY created_at DESC LIMIT 100';

  const res = await pool.query(query, params);
  const unreadRes = await pool.query('SELECT COUNT(*) FROM notifications WHERE account_id = $1 AND is_read = false', [accountId]);

  const notifications = res.rows.map(r => ({
    id: r.id,
    timestamp: r.created_at,
    severity: r.severity,
    category: r.category,
    title: r.title,
    message: r.message,
    read: r.is_read,
    metadata: r.metadata
  }));

  return {
    notifications,
    unreadCount: Number(unreadRes.rows[0]?.count || 0)
  };
}

/**
 * Mark a single notification as read.
 * @param {string} accountId 
 * @param {string} notificationId 
 * @returns {Promise<{ success: boolean, id: string }>}
 */
export async function markAsRead(accountId, notificationId) {
  const pool = getPool();
  await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND account_id = $2', [notificationId, accountId]);
  return { success: true, id: notificationId };
}

/**
 * Mark all notifications for an account as read.
 * @param {string} accountId 
 * @returns {Promise<{ success: boolean, markedCount: number }>}
 */
export async function markAllAsRead(accountId) {
  const pool = getPool();
  const res = await pool.query('UPDATE notifications SET is_read = true WHERE account_id = $1 AND is_read = false RETURNING id', [accountId]);
  return { success: true, markedCount: res.rowCount || 0 };
}

/**
 * Delete a single notification.
 * @param {string} accountId 
 * @param {string} notificationId 
 * @returns {Promise<{ success: boolean, id: string }>}
 */
export async function deleteNotification(accountId, notificationId) {
  const pool = getPool();
  await pool.query('DELETE FROM notifications WHERE id = $1 AND account_id = $2', [notificationId, accountId]);
  return { success: true, id: notificationId };
}

/**
 * Clear all notifications for an account.
 * @param {string} accountId 
 * @returns {Promise<{ success: boolean }>}
 */
export async function clearAllNotifications(accountId) {
  const pool = getPool();
  await pool.query('DELETE FROM notifications WHERE account_id = $1', [accountId]);
  return { success: true };
}

/**
 * Ingest / create a new notification record and return it.
 * @param {string} accountId 
 * @param {Object} data 
 * @returns {Promise<Object>}
 */
export async function createNotification(accountId, data) {
  const pool = getPool();
  const id = data.id || `notif-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const { severity = 'INFO', category = 'SYSTEM', title, message, metadata = {} } = data;

  const res = await pool.query(`
    INSERT INTO notifications (id, account_id, severity, category, title, message, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [id, accountId, severity, category, title, message, JSON.stringify(metadata)]);

  const r = res.rows[0];
  return {
    id: r.id,
    timestamp: r.created_at,
    severity: r.severity,
    category: r.category,
    title: r.title,
    message: r.message,
    read: r.is_read,
    metadata: r.metadata
  };
}
