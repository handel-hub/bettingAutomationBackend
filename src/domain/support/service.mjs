// @ts-check
import {
  countOpenTickets,
  findAvailableSupportChannels,
  findAllSupportChannels,
  upsertSupportChannelInDb,
  insertTicket,
  findTicketsByAccount,
  insertDiagnosticReport
} from './repository.mjs';

/**
 * Fetch CustomerCareSnapshot including open ticket count, contact methods, and documentation sync state.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getCustomerCareSnapshot(accountId) {
  const openTicketCount = await countOpenTickets(undefined, accountId);

  let contactMethods = [];
  try {
    const channels = await findAvailableSupportChannels(undefined);
    if (channels.length > 0) {
      contactMethods = channels.map(c => ({
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
  const channels = await findAllSupportChannels(undefined);
  return channels.map(c => ({
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
  const c = await upsertSupportChannelInDb(undefined, channel);
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
  const { subject, category, message, fileIds = [] } = data;

  if (!subject || !message) {
    throw new Error('Subject and message are required');
  }

  const row = await insertTicket(undefined, accountId, { subject, category, message, fileIds });

  return {
    ticketId: row.ticket_id,
    status: row.status
  };
}

/**
 * List support tickets for an account.
 * @param {string} accountId 
 * @returns {Promise<Object[]>}
 */
export async function listTickets(accountId) {
  const rows = await findTicketsByAccount(undefined, accountId);

  return rows.map(r => ({
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
  const row = await insertDiagnosticReport(undefined, accountId, data);

  return {
    reportId: row.report_id,
    status: 'RECEIVED'
  };
}
