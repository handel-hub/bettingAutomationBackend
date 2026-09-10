// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch the authoritative PlatformRegistrySnapshot.
 * Conforms to Contract Section 12.1 #6 and Section 19.2 (CNT-PLAT-REG-01).
 * 
 * @returns {Promise<Object>}
 */
export async function getPlatformRegistrySnapshot() {
  const pool = getPool();
  const res = await pool.query(
    'SELECT * FROM platform_registry ORDER BY sort_order ASC, created_at ASC'
  );

  let defaultPlatformId = 'sportybet';

  const platforms = res.rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    iconUrl: row.icon_url || null,
    status: row.status,
    isAvailable: Boolean(row.is_available)
  }));

  if (platforms.length > 0 && !platforms.find(p => p.id === defaultPlatformId)) {
    defaultPlatformId = platforms[0].id;
  }

  return {
    defaultPlatformId,
    platforms,
    totalCount: platforms.length
  };
}

/**
 * Fetch a single platform by its ID.
 * @param {string} id 
 * @returns {Promise<Object|null>}
 */
export async function getPlatformById(id) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT * FROM platform_registry WHERE lower(id) = lower($1)',
    [id]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    displayName: row.display_name,
    iconUrl: row.icon_url,
    status: row.status,
    isAvailable: Boolean(row.is_available)
  };
}

/**
 * Register or update a platform dynamically (Supports TEST-RES-04).
 * @param {Object} platform 
 * @returns {Promise<Object>}
 */
export async function upsertPlatform(platform) {
  const pool = getPool();
  const id = (platform.platformKey || platform.id || platform.displayName).toLowerCase().replace(/\s+/g, '');
  const displayName = platform.displayName || platform.name || id;
  const iconUrl = platform.iconUrl || `https://assets.betting-automation.internal/platforms/${id}.svg`;
  const status = platform.status || 'ONLINE';
  const isAvailable = platform.isAvailable !== undefined ? Boolean(platform.isAvailable) : true;
  const sortOrder = Number(platform.sortOrder || 99);

  const res = await pool.query(`
    INSERT INTO platform_registry (id, display_name, icon_url, status, is_available, sort_order)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (id) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      icon_url = EXCLUDED.icon_url,
      status = EXCLUDED.status,
      is_available = EXCLUDED.is_available,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING *
  `, [id, displayName, iconUrl, status, isAvailable, sortOrder]);

  return {
    id: res.rows[0].id,
    displayName: res.rows[0].display_name,
    iconUrl: res.rows[0].icon_url,
    status: res.rows[0].status,
    isAvailable: res.rows[0].is_available
  };
}

/**
 * Update the status of a betting platform.
 * @param {string} id 
 * @param {'ONLINE' | 'DEGRADED' | 'MAINTENANCE'} status 
 * @param {boolean} [isAvailable] 
 * @returns {Promise<boolean>}
 */
export async function updatePlatformStatus(id, status, isAvailable) {
  const pool = getPool();
  const res = await pool.query(`
    UPDATE platform_registry
    SET status = $2,
        is_available = COALESCE($3, is_available),
        updated_at = now()
    WHERE lower(id) = lower($1)
  `, [id, status, isAvailable !== undefined ? isAvailable : null]);

  return (res.rowCount || 0) > 0;
}
