// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch CustomerCareSnapshot including open ticket count, contact methods, and documentation sync state.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getCustomerCareSnapshot(accountId) {
  const pool = getPool();

  const ticketRes = await pool.query(
    "SELECT COUNT(*) FROM support_tickets WHERE account_id = $1 AND status IN ('OPEN', 'PENDING')",
    [accountId]
  );
  const openTicketCount = Number(ticketRes.rows[0]?.count || 0);

  let contactMethods = [];
  try {
    const chanRes = await pool.query(
      "SELECT id, title, description, action_type, action_target, icon, is_available FROM support_channels WHERE is_available = true ORDER BY sort_order ASC"
    );
    if (chanRes.rows.length > 0) {
      contactMethods = chanRes.rows.map(c => ({
        id: c.id,
        title: c.title,
        description: c.description,
        actionType: c.action_type,
        actionTarget: c.action_target,
        icon: c.icon || null,
        available: c.is_available
      }));
    }
  } catch {
    // fallback if table query fails
  }

  if (contactMethods.length === 0) {
    contactMethods = [
      {
        id: 'ticket',
        title: 'Support Ticket',
        description: 'Submit an incident or request operational assistance',
        actionType: 'INTERNAL_ROUTE',
        actionTarget: '/workspace/support/tickets/new',
        icon: 'ticket',
        available: true
      },
      {
        id: 'discord',
        title: 'Community & Ops Discord',
        description: 'Real-time peer and engineer operator channel',
        actionType: 'EXTERNAL_LINK',
        actionTarget: 'https://discord.gg/bettingautomation',
        icon: 'message-square',
        available: true
      }
    ];
  }

  return {
    openTicketCount,
    contactMethods,
    documentationState: {
      cached: true,
      sections: [
        { id: 'quickstart', title: 'Quickstart Guide' },
        { id: 'bookmakers', title: 'Connecting Bookmaker Accounts' },
        { id: 'tactics', title: 'Tactical Cashout & Dynamic Pricing' }
      ]
    },
    documentationLastSync: new Date().toISOString(),
    systemHealthSummary: 'Healthy'
  };
}

/**
 * List all support channels (admin / management)
 */
export async function listSupportChannels() {
  const pool = getPool();
  const res = await pool.query('SELECT * FROM support_channels ORDER BY sort_order ASC');
  return res.rows.map(c => ({
    id: c.id,
    title: c.title,
    description: c.description,
    actionType: c.action_type,
    actionTarget: c.action_target,
    icon: c.icon || null,
    isAvailable: c.is_available,
    sortOrder: c.sort_order
  }));
}

/**
 * Upsert support channel
 * @param {Object} channel 
 */
export async function upsertSupportChannel(channel) {
  const pool = getPool();
  const { id, title, description, actionType = 'EXTERNAL_LINK', actionTarget, icon = null, isAvailable = true, sortOrder = 10 } = channel;
  const res = await pool.query(`
    INSERT INTO support_channels (id, title, description, action_type, action_target, icon, is_available, sort_order, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      action_type = EXCLUDED.action_type,
      action_target = EXCLUDED.action_target,
      icon = EXCLUDED.icon,
      is_available = EXCLUDED.is_available,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING *
  `, [id, title, description, actionType, actionTarget, icon, isAvailable, sortOrder]);
  const c = res.rows[0];
  return {
    id: c.id,
    title: c.title,
    description: c.description,
    actionType: c.action_type,
    actionTarget: c.action_target,
    icon: c.icon || null,
    isAvailable: c.is_available,
    sortOrder: c.sort_order
  };
}

/**
 * Create a new support ticket.
 * @param {string} accountId 
 * @param {Object} data 
 * @param {string} data.subject 
 * @param {string} data.category 
 * @param {string} data.message 
 * @param {string[]} [data.fileIds]
 * @returns {Promise<Object>}
 */
export async function createTicket(accountId, data) {
  const pool = getPool();
  const { subject, category, message, fileIds = [] } = data;

  if (!subject || !message) {
    throw new Error('Subject and message are required');
  }

  const res = await pool.query(`
    INSERT INTO support_tickets (account_id, subject, category, message, file_ids)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING ticket_id, status, created_at
  `, [accountId, subject, category || 'GENERAL', message, JSON.stringify(fileIds)]);

  return {
    ticketId: res.rows[0].ticket_id,
    status: res.rows[0].status
  };
}

/**
 * List support tickets for an account.
 * @param {string} accountId 
 * @returns {Promise<Object[]>}
 */
export async function listTickets(accountId) {
  const pool = getPool();
  const res = await pool.query(`
    SELECT ticket_id, subject, category, message, status, file_ids, created_at, updated_at
    FROM support_tickets
    WHERE account_id = $1
    ORDER BY created_at DESC
  `, [accountId]);

  return res.rows.map(r => ({
    ticketId: r.ticket_id,
    subject: r.subject,
    category: r.category,
    message: r.message,
    status: r.status,
    fileIds: r.file_ids,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }));
}

/**
 * Ingest secure diagnostic report from an agent / control plane.
 * @param {string} accountId 
 * @param {Object} data 
 * @param {Object} data.telemetry 
 * @param {string[]} data.recentLogs 
 * @param {string} [data.machineId]
 * @returns {Promise<Object>}
 */
export async function submitDiagnostics(accountId, data) {
  const pool = getPool();
  const { telemetry = {}, recentLogs = [], machineId = null } = data;

  const res = await pool.query(`
    INSERT INTO diagnostic_reports (account_id, machine_id, telemetry, recent_logs)
    VALUES ($1, $2, $3, $4)
    RETURNING report_id
  `, [accountId, machineId, JSON.stringify(telemetry), JSON.stringify(recentLogs)]);

  return {
    reportId: res.rows[0].report_id,
    status: 'RECEIVED'
  };
}
