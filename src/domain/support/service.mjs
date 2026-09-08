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

  const contactMethods = [
    {
      id: 'ticket',
      title: 'Support Ticket',
      description: 'Submit an incident or request operational assistance',
      actionType: 'INTERNAL_ROUTE',
      actionTarget: '/workspace/support/tickets/new',
      available: true
    },
    {
      id: 'live_chat',
      title: 'Live Chat (Discord / Telegram)',
      description: 'Real-time peer and engineer operator channel',
      actionType: 'EXTERNAL_LINK',
      actionTarget: 'https://discord.gg/bettingautomation',
      available: true
    }
  ];

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
