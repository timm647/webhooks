import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} from 'discord.js';

function logFatalError(label, error) {
  const message = error?.stack || error?.message || String(error);
  console.error(`[ANTI-CRASH] ${label}:`, message);
}

process.on('uncaughtException', error => {
  logFatalError('uncaughtException', error);
});

process.on('unhandledRejection', error => {
  logFatalError('unhandledRejection', error);
});

const required = ['DISCORD_TOKEN', 'GUILD_ID'];

let hasMissingRequiredConfig = false;
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Variable manquante dans .env : ${key}`);
    hasMissingRequiredConfig = true;
  }
}

const CONFIG = {
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID,
  checkIntervalSeconds: parseInt(process.env.CHECK_INTERVAL_SECONDS || '30', 10),
  allowTestPaypal: String(process.env.ALLOW_TEST_PAYPAL || 'false').toLowerCase() === 'true',
  paypalAllowedSenders: (process.env.PAYPAL_ALLOWED_SENDERS || 'paypal.com,paypal.fr')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(Boolean),
  formSubmitKeyword: (process.env.FORM_SUBMIT_KEYWORD || 'CHEAPMEAL').toLowerCase(),
  dataRetentionDays: parseInt(process.env.DATA_RETENTION_DAYS || '90', 10),
  dashboardChannelId: process.env.DASHBOARD_CHANNEL_ID || '',
  archiveChannelId: process.env.ARCHIVE_CHANNEL_ID || '',
  ticketCategoryId: process.env.TICKET_CATEGORY_ID || '',
  initialDashboardTtlMinutes: parseInt(process.env.INITIAL_DASHBOARD_TTL_MINUTES || '10', 10),
  deliveredAutoArchiveMinutes: parseInt(process.env.DELIVERED_AUTO_ARCHIVE_MINUTES || '10', 10),
  mailMaxNewPerCycle: parseInt(process.env.MAIL_MAX_NEW_PER_CYCLE || '10', 10),
  imapLimitBackoffMinutes: parseInt(process.env.IMAP_LIMIT_BACKOFF_MINUTES || '10', 10),
  webhookPort: parseInt(process.env.PORT || process.env.WEBHOOK_PORT || '3000', 10),
  webhookAllowedOrigin: process.env.WEBHOOK_ALLOWED_ORIGIN || '',
  paypalWebhookSecret: process.env.PAYPAL_WEBHOOK_SECRET || ''
};

const DATA_DIR = './data';
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const VALIDATED_FILE = path.join(DATA_DIR, 'validated.json');
const SEEN_FILE = path.join(DATA_DIR, 'seen.json');
const PAYMENTS_FILE = path.join(DATA_DIR, 'payments.json');
const ISSUES_FILE = path.join(DATA_DIR, 'issues.json');
const DASHBOARD_FILE = path.join(DATA_DIR, 'dashboard.csv');
const DASHBOARD_MESSAGES_FILE = path.join(DATA_DIR, 'dashboard_messages.json');
const DELIVERIES_FILE = path.join(DATA_DIR, 'deliveries.json');
const ARCHIVES_FILE = path.join(DATA_DIR, 'archives.json');
const SUPPRESSED_FILE = path.join(DATA_DIR, 'suppressed.json');
const MAIL_STATE_FILE = path.join(DATA_DIR, 'mail_state.json');

function ensureFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  for (const file of [ORDERS_FILE, VALIDATED_FILE, SEEN_FILE, PAYMENTS_FILE, ISSUES_FILE, DASHBOARD_MESSAGES_FILE, DELIVERIES_FILE, ARCHIVES_FILE, SUPPRESSED_FILE, MAIL_STATE_FILE]) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
  }
  if (!fs.existsSync(DASHBOARD_FILE)) {
    fs.writeFileSync(DASHBOARD_FILE, 'code,site_order,ticket_order,paypal_total,status,error,updated_at\n');
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isSuppressed(code) {
  const suppressed = readJson(SUPPRESSED_FILE);
  return Boolean(suppressed[code]);
}

function suppressOrder(code, reason = 'manual', userId = null) {
  const suppressed = readJson(SUPPRESSED_FILE);
  suppressed[code] = {
    reason,
    userId,
    suppressedAt: new Date().toISOString()
  };
  writeJson(SUPPRESSED_FILE, suppressed);
}

function removeCodeFromJsonMap(file, code) {
  const data = readJson(file);
  if (Object.prototype.hasOwnProperty.call(data, code)) {
    delete data[code];
    writeJson(file, data);
  }
}

function cleanupOrderData(code) {
  for (const file of [ORDERS_FILE, VALIDATED_FILE, PAYMENTS_FILE, ISSUES_FILE, DELIVERIES_FILE]) {
    removeCodeFromJsonMap(file, code);
  }
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeProduct(text) {
  return normalizeText(text)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCode(text) {
  const match = normalizeText(text).match(/\bCM[-\s]?\d{4,6}\b/i);
  if (!match) return null;
  return match[0].toUpperCase().replace(/\s+/g, '-');
}

function parseAmount(value) {
  if (!value) return null;
  const cleaned = String(value)
    .replace(/\s/g, '')
    .replace(',', '.')
    .replace(/[^\d.]/g, '');

  const num = parseFloat(cleaned);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100) / 100;
}

function money(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return Number(value).toFixed(2) + '€';
}

function extractAmounts(text) {
  const normalized = normalizeText(text);
  const matches = normalized.match(/(\d+[,.]\d{2}|\d+)\s?€/g) || [];
  return matches.map(parseAmount).filter(v => v !== null);
}

function amountEquals(a, b) {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < 0.01;
}

function extractField(text, names) {
  const raw = String(text || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/tr>/gi, '\n');
  const clean = raw.replace(/<[^>]+>/g, ' ');
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    for (const name of names) {
      const re = new RegExp(`^${name}\\s*[:|]\\s*(.+)$`, 'i');
      const match = line.match(re);
      if (match) return match[1].trim();
    }
  }

  const flat = normalizeText(clean);

  for (const name of names) {
    const re = new RegExp(`${name}\\s*[:|]\\s*([^|\\n\\r]+)`, 'i');
    const match = flat.match(re);
    if (match) return match[1].trim();
  }

  return null;
}

function parseFormSubmitMail(mail) {
  const subject = mail.subject || '';
  const body = `${mail.text || ''}\n${mail.html || ''}`;
  const all = `${subject}\n${body}`;
  const code = extractCode(all);
  if (!code) return null;

  let amount =
    parseAmount(extractField(body, ['Montant', 'Total_A_Payer', 'Amount'])) ||
    parseAmount((subject.match(/\|\s*([\d,.]+)\s?€/) || [])[1]);

  const amounts = extractAmounts(all);
  if (amount === null && amounts.length > 0) amount = amounts[0];

  return {
    code,
    amount,
    discord: extractField(body, ['Discord']) || null,
    product: extractField(body, ['Produit']) || null,
    quantity: parseInt(extractField(body, ['Quantite', 'Quantité']) || '1', 10),
    name: extractField(body, ['Nom']) || null,
    firstName: extractField(body, ['Prenom', 'Prénom']) || null,
    receivedAt: new Date().toISOString(),
    subject
  };
}

function isOfficialPaypal(mail) {
  const from = (mail.from?.text || '').toLowerCase();

  if (CONFIG.allowTestPaypal) {
    const subject = (mail.subject || '').toLowerCase();
    if (subject.includes('paypal')) return true;
  }

  return CONFIG.paypalAllowedSenders.some(domain => from.includes(domain));
}

function parsePaypalMail(mail) {
  if (!isOfficialPaypal(mail)) return null;

  const subject = mail.subject || '';
  const body = `${mail.text || ''}\n${mail.html || ''}`;
  const all = `${subject}\n${body}`;

  const code = extractCode(all);
  if (!code) return null;

  const amounts = extractAmounts(all);

  return {
    code,
    amounts,
    subject,
    from: mail.from?.text || '',
    receivedAt: new Date().toISOString()
  };
}

async function connectImap() {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: CONFIG.emailUser,
      pass: CONFIG.emailPass
    }
  });

  client.on('error', error => {
    console.error('Erreur IMAP non bloquante :', error?.message || error);
  });

  await client.connect();
  return client;
}

function readMailState() {
  const state = readJson(MAIL_STATE_FILE);
  return {
    lastUid: Number(state.lastUid || 0),
    initializedAt: state.initializedAt || null
  };
}

function writeMailStatePatch(patch) {
  const state = readJson(MAIL_STATE_FILE);
  writeJson(MAIL_STATE_FILE, {
    ...state,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function envelopeText(envelope) {
  const parts = [];
  if (envelope?.subject) parts.push(envelope.subject);
  for (const group of [envelope?.from, envelope?.sender, envelope?.replyTo]) {
    if (Array.isArray(group)) {
      for (const addr of group) {
        parts.push(addr.name || '', addr.address || '');
      }
    }
  }
  return parts.join(' ').toLowerCase();
}

function isLikelyUsefulEnvelope(envelope) {
  const text = envelopeText(envelope);
  if (!text) return false;
  // Les commandes site arrivent maintenant par webhook, plus par FormSubmit/Gmail.
  if (text.includes('paypal')) return true;
  if (CONFIG.paypalAllowedSenders.some(domain => text.includes(domain))) return true;
  if (/\bcm[-\s]?\d{4,6}\b/i.test(text)) return true;
  return false;
}

async function fetchNewEmails() {
  const mails = [];
  let imap = null;

  try {
    imap = await connectImap();
  } catch (error) {
    if (isImapLimitError(error)) activateImapBackoff(error);
    else console.error('Connexion IMAP impossible :', error?.stack || error?.message || error);
    return mails;
  }
  const state = readMailState();
  let maxUid = state.lastUid || 0;

  try {
    const lock = await imap.getMailboxLock('INBOX');

    try {
      let uids = [];

      if (state.lastUid > 0) {
        uids = await imap.search({ uid: `${state.lastUid + 1}:*` }, { uid: true });
      } else {
        const messages = await imap.search({ since: new Date(Date.now() - 24 * 60 * 60 * 1000) }, { uid: true });
        uids = messages.slice(-Math.max(10, CONFIG.mailMaxNewPerCycle));
      }

      uids = [...new Set(uids.map(Number).filter(Boolean))].sort((a, b) => a - b);

      if (uids.length === 0) return mails;

      // Sécurité HeavenCloud : on limite le nombre de nouveaux mails traités par cycle
      // pour éviter les pics mémoire si Gmail renvoie beaucoup de messages d'un coup.
      const limitedUids = uids.slice(-Math.max(1, CONFIG.mailMaxNewPerCycle));
      const candidateUids = [];

      // Étape 1 légère : on lit uniquement les en-têtes/enveloppes.
      // On ne télécharge PAS le contenu complet des mails inutiles.
      for await (const msg of imap.fetch(limitedUids, { uid: true, envelope: true }, { uid: true })) {
        const uid = Number(msg.uid || 0);
        maxUid = Math.max(maxUid, uid);
        if (isLikelyUsefulEnvelope(msg.envelope)) candidateUids.push(uid);
      }

      if (candidateUids.length === 0) return mails;

      // Étape 2 lourde : on télécharge seulement les mails candidats
      // FormSubmit/PayPal/CM-XXXX, un par un.
      for (const uid of candidateUids) {
        try {
          for await (const msg of imap.fetch([uid], { uid: true, envelope: true, source: true }, { uid: true })) {
            maxUid = Math.max(maxUid, Number(msg.uid || 0));
            const parsed = await simpleParser(msg.source, {
              skipImageLinks: true,
              skipHtmlToText: true
            });

            mails.push({
              uid: msg.uid,
              subject: parsed.subject || msg.envelope?.subject || '',
              from: parsed.from,
              text: parsed.text || '',
              html: parsed.html || '',
              date: parsed.date || null
            });
          }
        } catch (error) {
          console.error(`Mail UID ${uid} ignoré après erreur parsing :`, error?.message || error);
        }
      }
    } finally {
      try {
        lock.release();
      } catch (error) {
        console.error('Libération verrou IMAP impossible :', error?.message || error);
      }
    }
  } catch (error) {
    if (isImapLimitError(error)) activateImapBackoff(error);
    else console.error('Erreur IMAP non bloquante :', error?.stack || error?.message || error);
  } finally {
    if (imap) {
      try {
        await imap.logout();
      } catch (error) {
        if (!isImapLimitError(error)) {
          console.error('Fermeture IMAP impossible :', error?.message || error);
        }
      }
    }
  }

  if (maxUid > state.lastUid) {
    writeMailStatePatch({
      lastUid: maxUid,
      initializedAt: state.initializedAt || new Date().toISOString()
    });
  }

  return mails;
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ]
});

async function findTicketChannel(code) {
  const guild = await discord.guilds.fetch(CONFIG.guildId);
  const channels = await guild.channels.fetch();
  const codeLower = code.toLowerCase();

  return channels.find(channel => {
    if (!channel || !channel.isTextBased()) return false;
    const name = channel.name?.toLowerCase() || '';
    const topic = channel.topic?.toLowerCase() || '';
    return name.includes(codeLower) || topic.includes(codeLower);
  });
}

function parseTicketFromEmbedText(text) {
  return {
    code: extractCode(text),
    product: extractField(text, ['Produit']),
    quantity: parseInt(extractField(text, ['Quantité', 'Quantite']) || '1', 10),
    amount: parseAmount(extractField(text, ['Total', 'Montant']))
  };
}

async function getTicketOrder(code) {
  const channel = await findTicketChannel(code);
  if (!channel) return { channel: null, ticket: null };

  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return { channel, ticket: null };

  for (const [, message] of messages) {
    for (const embed of message.embeds) {
      const title = embed.title || '';
      const description = embed.description || '';
      const text = [
        title,
        description,
        ...(embed.fields || []).map(f => `${f.name}: ${f.value}`)
      ].join('\n');

      const isOriginalTicket =
        title.toLowerCase().startsWith('ticket ') &&
        text.toLowerCase().includes(code.toLowerCase()) &&
        text.toLowerCase().includes('produit') &&
        text.toLowerCase().includes('total');

      if (isOriginalTicket) {
        return { channel, ticket: parseTicketFromEmbedText(text) };
      }
    }
  }

  return { channel, ticket: null };
}

function compareTicketAndSite(ticket, order) {
  if (!ticket) return 'Ticket introuvable ou infos ticket illisibles';
  if (!order) return 'Commande site introuvable';

  if (ticket.code && order.code && ticket.code !== order.code) {
    return `Code différent: ticket ${ticket.code}, site ${order.code}`;
  }

  if (ticket.product && order.product && normalizeProduct(ticket.product) !== normalizeProduct(order.product)) {
    return `Produit différent: ticket "${ticket.product}", site "${order.product}"`;
  }

  if (ticket.quantity && order.quantity && Number(ticket.quantity) !== Number(order.quantity)) {
    return `Quantité différente: ticket ${ticket.quantity}, site ${order.quantity}`;
  }

  if (ticket.amount !== null && order.amount !== null && !amountEquals(ticket.amount, order.amount)) {
    return `Montant différent: ticket ${money(ticket.amount)}, site ${money(order.amount)}`;
  }

  return null;
}

function getPaymentsTotal(code) {
  const payments = readJson(PAYMENTS_FILE);
  const list = payments[code] || [];
  return Math.round(list.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100) / 100;
}

function addPaypalPayment(paypal) {
  const payments = readJson(PAYMENTS_FILE);
  if (!payments[paypal.code]) payments[paypal.code] = [];

  for (const amount of paypal.amounts) {
    const already = payments[paypal.code].some(p =>
      p.subject === paypal.subject &&
      p.from === paypal.from &&
      amountEquals(p.amount, amount)
    );

    if (!already) {
      payments[paypal.code].push({
        amount,
        subject: paypal.subject,
        from: paypal.from,
        receivedAt: paypal.receivedAt
      });
    }
  }

  writeJson(PAYMENTS_FILE, payments);
}

async function sendTicketMessage(code, embed) {
  const { channel } = await getTicketOrder(code);
  if (!channel) {
    console.log(`Ticket introuvable pour ${code}`);
    return false;
  }

  await channel.send({ embeds: [embed] });
  return true;
}

async function notifyIssue(code, title, description) {
  const issues = readJson(ISSUES_FILE);
  const fingerprint = `${title}:${description}`;

  if (issues[code]?.lastFingerprint === fingerprint) return;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xff9900)
    .setDescription(description);

  const sent = await sendTicketMessage(code, embed);
  if (sent) {
    issues[code] = {
      lastFingerprint: fingerprint,
      updatedAt: new Date().toISOString()
    };
    writeJson(ISSUES_FILE, issues);
  }
}

async function notifyTicketValidated(order, ticket, paypalTotal) {
  const validated = readJson(VALIDATED_FILE);
  const code = order?.code || ticket?.code;

  if (!code || validated[code]) return;

  const embed = new EmbedBuilder()
    .setTitle('Paiement validé')
    .setColor(0x2ecc71)
    .setDescription(
      `✅ Paiement confirmé pour **${code}**

` +
      `Produit : **${ticket?.product || order?.product || 'Non précisé'}**
` +
      `Quantité : **${ticket?.quantity || order?.quantity || 1}**
` +
      `Montant attendu : **${money(ticket?.amount ?? order?.amount)}**
` +
      `Montant reçu : **${money(paypalTotal)}**

` +
      `Votre paiement est bien validé ✅

` +
      `Votre commande sera livrée d’ici quelques instants dans ce ticket.
` +
      `Merci de patienter pendant que le staff prépare la livraison.

` +
      `🙏 Après réception, n’hésitez pas à laisser un avis sur le serveur, ça nous aide énormément.`
    );

  // Si un ticket Discord existe, on le prévient. Sinon la commande reste validée dans le dashboard.
  await sendTicketMessage(code, embed).catch(() => false);

  validated[code] = {
    validatedAt: new Date().toISOString(),
    order,
    ticket,
    paypalTotal
  };

  writeJson(VALIDATED_FILE, validated);
  console.log(`Paiement validé : ${code}`);
}

function buildOrderState(code, order, ticket, paypalTotal) {
  const expected = order?.amount ?? ticket?.amount ?? null;
  const product = order?.product || ticket?.product || 'Non précisé';
  const quantity = order?.quantity || ticket?.quantity || 1;
  const hasSite = Boolean(order);
  const hasPaypal = paypalTotal > 0;
  const hasDiscord = Boolean(ticket);

  let status = 'EN_ATTENTE';
  let label = '⏳ EN ATTENTE DE PAIEMENT';
  let color = 0xff9900;
  let detail = 'PayPal manquant';

  if (!hasSite && hasPaypal) {
    status = 'PAYPAL_SANS_COMMANDE';
    label = '⚠️ PAIEMENT REÇU SANS COMMANDE SITE';
    color = 0xff9900;
    detail = 'PayPal trouvé, commande site introuvable';
  } else if (hasSite && !hasPaypal) {
    status = 'COMMANDE_SITE';
    label = '🛒 COMMANDE SITE REÇUE — PayPal manquant';
    color = 0xff9900;
    detail = 'Commande site trouvée, PayPal manquant';
  } else if (hasSite && hasPaypal && expected !== null && paypalTotal < expected) {
    const missing = Math.round((expected - paypalTotal) * 100) / 100;
    status = 'PARTIEL';
    label = `⚠️ PAIEMENT PARTIEL — reste ${money(missing)}`;
    color = 0xff9900;
    detail = `Reste ${money(missing)}`;
  } else if (hasSite && hasPaypal) {
    status = 'PAYE';
    label = hasDiscord ? '✅ PAYÉ — ticket Discord lié' : '✅ PAYÉ — commande site';
    color = 0x2ecc71;
    detail = '-';
  } else if (hasDiscord && !hasSite && !hasPaypal) {
    status = 'DISCORD_SEUL';
    label = 'ℹ️ TICKET DISCORD TROUVÉ';
    color = 0x999999;
    detail = 'Aucune commande site/PayPal liée pour le moment';
  }

  return { code, expected, product, quantity, hasSite, hasPaypal, hasDiscord, status, label, color, detail };
}


function getPaymentEmoji(status, code = null) {
  if (code && getDeliveryStatus(code)) return '✅';
  if (status === 'PAYE') return '✅';
  if (status === 'PARTIEL') return '🟠';
  if (status === 'PAYPAL_SANS_COMMANDE') return '💰';
  if (status === 'COMMANDE_SITE') return '🛒';
  return '❌';
}

function getDeliveryRecord(code) {
  const deliveries = readJson(DELIVERIES_FILE);
  return deliveries[code] || {};
}

function getDeliveryStatus(code) {
  return getDeliveryRecord(code).delivered === true;
}

function isArchived(code) {
  return getDeliveryRecord(code).archived === true;
}

function setDeliveryStatus(code, delivered, userId = null) {
  const deliveries = readJson(DELIVERIES_FILE);
  const previous = deliveries[code] || {};
  deliveries[code] = {
    ...previous,
    delivered,
    updatedAt: new Date().toISOString(),
    updatedBy: userId
  };

  if (delivered && !previous.deliveredAt) {
    deliveries[code].deliveredAt = new Date().toISOString();
  }

  if (!delivered) {
    deliveries[code].archived = false;
    deliveries[code].archivedAt = null;
    deliveries[code].archivedBy = null;
    deliveries[code].archiveMessageId = null;
    deliveries[code].deliveredAt = null;
  }

  writeJson(DELIVERIES_FILE, deliveries);
}

function setArchivedStatus(code, archived, userId = null, archiveMessageId = null) {
  const deliveries = readJson(DELIVERIES_FILE);
  deliveries[code] = {
    ...(deliveries[code] || {}),
    delivered: true,
    archived,
    archivedAt: archived ? new Date().toISOString() : null,
    archivedBy: userId,
    archiveMessageId
  };
  writeJson(DELIVERIES_FILE, deliveries);
}

function getDeliveryEmoji(code) {
  return getDeliveryStatus(code) ? '📦' : '⏳';
}

function cleanChannelNameForStatus(name) {
  return String(name || '')
    .replace(/[-_\s]*(✅|❌|🟠|💰|🛒)[-_\s]*(⏳|📦)\s*$/u, '')
    .replace(/[-_\s]*(✅|❌|🟠|💰|🛒)\s*$/u, '')
    .replace(/[-_\s]*(⏳|📦)\s*$/u, '')
    .replace(/[-_\s]+$/u, '');
}

async function updateTicketChannelName(ticketChannel, state) {
  if (!ticketChannel || typeof ticketChannel.setName !== 'function') return;

  const paymentEmoji = getPaymentEmoji(state.status, state.code);
  const deliveryEmoji = getDeliveryEmoji(state.code);
  const base = cleanChannelNameForStatus(ticketChannel.name || `cm-${state.code.toLowerCase()}`);
  const nextName = `${base}-${paymentEmoji}-${deliveryEmoji}`
    .toLowerCase()
    .replace(/\s+/g, '-');

  if (ticketChannel.name === nextName) return;

  await ticketChannel.setName(nextName).catch(error => {
    console.error(`Renommage ticket impossible pour ${state.code} :`, error.message);
  });
}

function buildDeliveryButtons(code) {
  const delivered = getDeliveryStatus(code);
  const buttons = [];

  if (!delivered) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`delivery:done:${code}`)
        .setLabel('Marquer livré')
        .setStyle(ButtonStyle.Success)
        .setEmoji('📦')
    );
  } else {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`delivery:undone:${code}`)
        .setLabel('Remettre non livré')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('⏳')
    );

    buttons.push(
      new ButtonBuilder()
        .setCustomId(`delivery:archive:${code}`)
        .setLabel('Archiver')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🗄️')
    );
  }

  buttons.push(
    new ButtonBuilder()
      .setCustomId(`delivery:delete:${code}`)
      .setLabel('Supprimer suivi + ticket')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️')
  );

  return new ActionRowBuilder().addComponents(...buttons);
}

async function evaluateOrder(code) {
  if (isSuppressed(code)) return;
  const orders = readJson(ORDERS_FILE);
  let order = orders[code];

  // Sécurité Render : si le fichier data/orders.json est perdu après un redémarrage
  // mais que le suivi dashboard avait déjà reçu la commande webhook, on garde le snapshot.
  if (!order) {
    const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
    if (dashboardMessages[code]?.orderSnapshot) {
      order = dashboardMessages[code].orderSnapshot;
      orders[code] = order;
      writeJson(ORDERS_FILE, orders);
    }
  }

  const { channel: ticketChannel, ticket } = await getTicketOrder(code);
  const paypalTotal = getPaymentsTotal(code);
  const state = buildOrderState(code, order, ticket, paypalTotal);

  updateDashboard(code, order, ticket, paypalTotal, state.status, state.detail);
  await updateTicketChannelName(ticketChannel, state);
  await notifyDashboardChannel(code, order, ticket, paypalTotal, state, ticketChannel);

  if (state.status === 'PARTIEL') {
    await notifyIssue(
      code,
      '⚠️ Paiement partiel détecté',
      `Code : **${code}**
Montant attendu : **${money(state.expected)}**
Montant reçu : **${money(paypalTotal)}**
${state.detail}`
    );
    return;
  }

  if (state.status === 'PAYE') {
    await notifyTicketValidated(order, ticket, paypalTotal);
  }
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function updateDashboard(code, order, ticket, paypalTotal, status, error) {
  const rows = fs.existsSync(DASHBOARD_FILE)
    ? fs.readFileSync(DASHBOARD_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    : ['code,site_order,ticket_order,paypal_total,status,error,updated_at'];

  const header = rows[0];
  const others = rows.slice(1).filter(row => !row.startsWith(`${code},`));

  const siteOrder = order ? `${order.product || '?'} x${order.quantity || 1} ${money(order.amount)}` : '-';
  const ticketOrder = ticket ? `${ticket.product || '?'} x${ticket.quantity || 1} ${money(ticket.amount)}` : '-';

  const row = [
    code,
    siteOrder,
    ticketOrder,
    money(paypalTotal),
    status,
    error || '-',
    new Date().toISOString()
  ].map(csvEscape).join(',');

  fs.writeFileSync(DASHBOARD_FILE, [header, ...others, row].join('\n') + '\n');
}

async function findExistingDashboardMessage(channel, code, dashboardMessages) {
  const savedMessageId = dashboardMessages[code]?.messageId;

  if (savedMessageId) {
    const saved = await channel.messages.fetch(savedMessageId).catch(() => null);
    if (saved) return saved;
  }

  const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recent) return null;

  return recent.find(message => {
    const text = [
      message.content || '',
      ...message.embeds.map(embed => [
        embed.title || '',
        embed.description || '',
        ...(embed.fields || []).map(field => `${field.name} ${field.value}`)
      ].join(' '))
    ].join(' ');
    return text.includes(code);
  }) || null;
}

function formatOrderLine(source, fallback) {
  if (!source && !fallback) return '❌ introuvable';

  const product = source?.product || fallback?.product || null;
  const quantity = source?.quantity || fallback?.quantity || 1;
  const amount = source?.amount ?? fallback?.amount ?? null;
  const parts = [];

  if (product) parts.push(product);
  parts.push(`x${quantity}`);
  if (amount !== null && amount !== undefined) parts.push(money(amount));

  return `✅ ${parts.join(' • ')}`;
}

function getInitialExpiryText(code, state, dashboardMessages) {
  if (state.status !== 'DISCORD_SEUL' || CONFIG.initialDashboardTtlMinutes <= 0) return null;

  const createdAt = new Date(dashboardMessages[code]?.createdAt || Date.now()).getTime();
  const expiresAt = createdAt + CONFIG.initialDashboardTtlMinutes * 60 * 1000;
  const remainingMs = Math.max(0, expiresAt - Date.now());
  const remainingMinutes = Math.ceil(remainingMs / 60000);

  return `⏱️ Auto-suppression dans environ **${remainingMinutes} min** si aucune commande site/PayPal n’arrive.`;
}

async function notifyDashboardChannel(code, order, ticket, paypalTotal, stateOrStatus, ticketChannel = null, options = {}) {
  if (!CONFIG.dashboardChannelId) return;
  if (isSuppressed(code)) return;
  if (isArchived(code)) return;

  try {
    const channel = await discord.channels.fetch(CONFIG.dashboardChannelId);
    if (!channel || !channel.isTextBased()) return;

    const state = typeof stateOrStatus === 'object'
      ? stateOrStatus
      : buildOrderState(code, order, ticket, paypalTotal);

    const mainProduct = order?.product || ticket?.product || 'Produit non précisé';
    const mainQuantity = order?.quantity || ticket?.quantity || 1;
    const siteLine = order
      ? formatOrderLine(order, ticket)
      : '❌ introuvable';
    const paypalLine = paypalTotal > 0
      ? `✅ ${money(paypalTotal)}`
      : '❌ non reçu';
    const discordLine = ticket
      ? `✅ ${formatOrderLine(ticket, order).replace(/^✅ /, '')}${ticketChannel ? `
Salon : <#${ticketChannel.id}>` : ''}`
      : 'Non lié';
    const delivered = getDeliveryStatus(code);
    const deliveryLine = delivered ? '📦 LIVRÉ' : '⏳ NON LIVRÉ';
    const paymentEmoji = getPaymentEmoji(state.status, code);
    const deliveryEmoji = getDeliveryEmoji(code);
    const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
    const timerLine = getInitialExpiryText(code, state, dashboardMessages);

    const needsDelivery = state.status === 'PAYE' && !delivered;
    const embedColor = needsDelivery ? 0xff0000 : (delivered && state.status === 'PAYE' ? 0x3498db : state.color);
    const urgentLine = needsDelivery
      ? `

🚨 **À LIVRER MAINTENANT**
Paiement validé, commande en attente de livraison.`
      : '';

    const embed = new EmbedBuilder()
      .setTitle(needsDelivery ? `🚨 À LIVRER — ${code}` : `Suivi commande — ${code}`)
      .setColor(embedColor)
      .setDescription(
        `**Paiement : ${paymentEmoji} ${state.label.replace(/^[^ ]+\s*/, '')}**
` +
        `**Livraison : ${deliveryEmoji} ${deliveryLine.replace(/^[^ ]+\s*/, '')}**` +
        urgentLine +
        (timerLine ? `

${timerLine}` : '')
      )
      .addFields(
        {
          name: '📦 Commande',
          value: `Produit : **${mainProduct}**
Quantité : **x${mainQuantity}**`,
          inline: false
        },
        {
          name: '👤 Client',
          value: order?.identification
            ? `${order.network ? `Réseau : **${order.network}**\n` : ''}Identification : **${order.identification}**`
            : (order?.discord ? `Réseau : **Discord**\nIdentification : **${order.discord}**` : 'Non précisé'),
          inline: false
        },
        {
          name: '🛒 Site internet',
          value: siteLine,
          inline: false
        },
        {
          name: '💳 PayPal reçu',
          value: paypalLine,
          inline: true
        },
        {
          name: '🎫 Discord',
          value: discordLine,
          inline: true
        }
      )
      .setFooter({ text: `Dernière mise à jour : ${new Date().toLocaleString('fr-FR')}` });

    const components = [buildDeliveryButtons(code)];

    const existing = await findExistingDashboardMessage(channel, code, dashboardMessages);

    if (existing) {
      const edited = await existing.edit({ embeds: [embed], components }).then(() => true).catch(async error => {
        console.error(`Modification du suivi ${code} impossible, remplacement du message :`, error.message);
        await existing.delete().catch(() => {});
        return false;
      });

      if (edited) {
        dashboardMessages[code] = {
          ...(dashboardMessages[code] || {}),
          messageId: existing.id,
          channelId: CONFIG.dashboardChannelId,
          status: state.status,
          updatedAt: new Date().toISOString(),
          createdAt: dashboardMessages[code]?.createdAt || new Date().toISOString(),
          ...(order ? { orderSnapshot: order } : {})
        };
        writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
        return;
      }
    }

    if (options.allowCreate === true) {
      const sent = await channel.send({ embeds: [embed], components });
      dashboardMessages[code] = {
        ...(dashboardMessages[code] || {}),
        messageId: sent.id,
        channelId: CONFIG.dashboardChannelId,
        status: state.status,
        updatedAt: new Date().toISOString(),
        createdAt: dashboardMessages[code]?.createdAt || new Date().toISOString(),
        ...(order ? { orderSnapshot: order } : {})
      };
      writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
      return;
    }

    // Mode update-only par défaut : le bot Discord crée le suivi dès la création du ticket.
    // Exception : le webhook site peut créer un suivi pour une commande venant directement du site.
    console.log(`Suivi dashboard absent pour ${code} : aucune création par le bot mail hors webhook.`);
  } catch (e) {
    console.error('Dashboard Discord non envoyé :', e.message);
  }
}


async function refreshOrderDisplay(code) {
  const orders = readJson(ORDERS_FILE);
  const order = orders[code];
  const { channel: ticketChannel, ticket } = await getTicketOrder(code);
  const paypalTotal = getPaymentsTotal(code);
  const state = buildOrderState(code, order, ticket, paypalTotal);

  await updateTicketChannelName(ticketChannel, state);
  await notifyDashboardChannel(code, order, ticket, paypalTotal, state, ticketChannel);
}

async function deleteDashboardAndTicket(interaction, code) {
  await interaction.deferUpdate().catch(() => {});

  suppressOrder(code, 'manual_delete', interaction.user?.id || null);

  const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
  const entry = dashboardMessages[code];
  const { channel: ticketChannel } = await getTicketOrder(code);

  if (ticketChannel) {
    await ticketChannel.delete('CheapMeal: suppression manuelle suivi + ticket').catch(error => {
      console.error(`Suppression ticket impossible pour ${code} :`, error.message);
    });
  }

  const dashboardChannel = entry?.channelId
    ? await discord.channels.fetch(entry.channelId).catch(() => null)
    : null;
  const dashboardMessage = dashboardChannel?.isTextBased() && entry?.messageId
    ? await dashboardChannel.messages.fetch(entry.messageId).catch(() => null)
    : null;

  if (dashboardMessage && dashboardMessage.id !== interaction.message.id) {
    await dashboardMessage.delete().catch(() => {});
  }

  delete dashboardMessages[code];
  writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
  cleanupOrderData(code);

  await interaction.message.delete().catch(() => {});
}

async function archiveDashboardOrder(interaction, code) {
  if (!getDeliveryStatus(code)) {
    await interaction.reply({ content: 'Cette commande doit être marquée livrée avant d’être archivée.', ephemeral: true });
    return;
  }

  if (!CONFIG.archiveChannelId) {
    await interaction.reply({ content: 'ARCHIVE_CHANNEL_ID n’est pas configuré dans le .env.', ephemeral: true });
    return;
  }

  const archiveChannel = await discord.channels.fetch(CONFIG.archiveChannelId).catch(() => null);
  if (!archiveChannel || !archiveChannel.isTextBased()) {
    await interaction.reply({ content: 'Salon archive introuvable ou inaccessible.', ephemeral: true });
    return;
  }

  const archives = readJson(ARCHIVES_FILE);
  const archiveNumber = Object.keys(archives).length + 1;
  const sourceEmbed = interaction.message.embeds[0];
  const embed = sourceEmbed
    ? EmbedBuilder.from(sourceEmbed)
    : new EmbedBuilder().setTitle(`Archive commande — ${code}`).setColor(0x3498db);

  embed
    .setTitle(`Archive #${archiveNumber} — ${code}`)
    .setColor(0x3498db)
    .setFooter({ text: `Archivée par ${interaction.user.tag} • ${new Date().toLocaleString('fr-FR')}` });

  const archivedMessage = await archiveChannel.send({ embeds: [embed] });

  archives[code] = {
    archiveNumber,
    archiveMessageId: archivedMessage.id,
    archiveChannelId: CONFIG.archiveChannelId,
    archivedAt: new Date().toISOString(),
    archivedBy: interaction.user?.id || null
  };
  writeJson(ARCHIVES_FILE, archives);

  setArchivedStatus(code, true, interaction.user?.id || null, archivedMessage.id);

  const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
  delete dashboardMessages[code];
  writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);

  await interaction.deferUpdate();
  await interaction.message.delete().catch(() => {});
}

async function archiveDashboardOrderByCode(code) {
  if (!getDeliveryStatus(code) || isArchived(code)) return false;
  if (!CONFIG.archiveChannelId) return false;

  const archiveChannel = await discord.channels.fetch(CONFIG.archiveChannelId).catch(() => null);
  if (!archiveChannel || !archiveChannel.isTextBased()) return false;

  const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
  const entry = dashboardMessages[code];
  if (!entry?.messageId) return false;

  const dashboardChannel = await discord.channels.fetch(entry.channelId || CONFIG.dashboardChannelId).catch(() => null);
  const dashboardMessage = dashboardChannel?.isTextBased()
    ? await dashboardChannel.messages.fetch(entry.messageId).catch(() => null)
    : null;

  if (!dashboardMessage) {
    delete dashboardMessages[code];
    writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
    return false;
  }

  const archives = readJson(ARCHIVES_FILE);
  const archiveNumber = Object.keys(archives).length + 1;
  const sourceEmbed = dashboardMessage.embeds[0];
  const embed = sourceEmbed
    ? EmbedBuilder.from(sourceEmbed)
    : new EmbedBuilder().setTitle(`Archive commande — ${code}`).setColor(0x3498db);

  embed
    .setTitle(`Archive #${archiveNumber} — ${code}`)
    .setColor(0x3498db)
    .setFooter({ text: `Archivée automatiquement • ${new Date().toLocaleString('fr-FR')}` });

  const archivedMessage = await archiveChannel.send({ embeds: [embed] });

  archives[code] = {
    archiveNumber,
    archiveMessageId: archivedMessage.id,
    archiveChannelId: CONFIG.archiveChannelId,
    archivedAt: new Date().toISOString(),
    archivedBy: 'auto'
  };
  writeJson(ARCHIVES_FILE, archives);

  setArchivedStatus(code, true, 'auto', archivedMessage.id);
  delete dashboardMessages[code];
  writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
  await dashboardMessage.delete().catch(() => {});

  return true;
}

async function autoArchiveDeliveredDashboards() {
  if (!CONFIG.archiveChannelId || CONFIG.deliveredAutoArchiveMinutes <= 0) return;

  const deliveries = readJson(DELIVERIES_FILE);
  const now = Date.now();

  for (const [code, record] of Object.entries(deliveries)) {
    if (!record?.delivered || record?.archived) continue;
    const deliveredAt = new Date(record.deliveredAt || record.updatedAt || 0).getTime();
    if (!deliveredAt) continue;
    if (now - deliveredAt < CONFIG.deliveredAutoArchiveMinutes * 60 * 1000) continue;

    await archiveDashboardOrderByCode(code).catch(error => {
      console.error(`Archive auto impossible pour ${code} :`, error.message);
    });
  }
}

async function handleDeliveryInteraction(interaction) {
  if (!interaction.isButton()) return;
  const [scope, action, code] = String(interaction.customId || '').split(':');
  if (scope !== 'delivery' || !code) return;

  if (action === 'archive') {
    await archiveDashboardOrder(interaction, code);
    return;
  }

  if (action === 'delete') {
    await deleteDashboardAndTicket(interaction, code);
    return;
  }

  if (action !== 'done' && action !== 'undone') return;

  // Discord demande une réponse rapide aux boutons. On accuse réception AVANT
  // de modifier les fichiers, renommer le ticket ou rééditer le suivi.
  await interaction.deferUpdate().catch(() => {});

  if (action === 'done') {
    setDeliveryStatus(code, true, interaction.user?.id || null);
  } else if (action === 'undone') {
    setDeliveryStatus(code, false, interaction.user?.id || null);
  }

  await refreshOrderDisplay(code).catch(error => {
    console.error(`Rafraîchissement livraison impossible pour ${code} :`, error?.stack || error?.message || error);
  });
}


async function scanOpenDiscordTickets() {
  if (!CONFIG.dashboardChannelId) return [];

  const guild = await discord.guilds.fetch(CONFIG.guildId).catch(() => null);
  if (!guild) return [];

  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return [];

  const codes = new Set();
  for (const [, channel] of channels) {
    if (!channel || !channel.isTextBased()) continue;
    if (CONFIG.ticketCategoryId && channel.parentId !== CONFIG.ticketCategoryId) continue;

    const text = `${channel.name || ''} ${channel.topic || ''}`;
    const code = extractCode(text);
    if (code && !isArchived(code) && !isSuppressed(code)) codes.add(code);
  }

  for (const code of codes) {
    await evaluateOrder(code).catch(error => {
      console.error(`Erreur suivi ticket ${code} :`, error.message);
    });
  }

  return [...codes];
}

async function cleanupInactiveInitialDashboards() {
  if (!CONFIG.dashboardChannelId || CONFIG.initialDashboardTtlMinutes <= 0) return;

  const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
  const now = Date.now();
  let changed = false;

  for (const [code, entry] of Object.entries(dashboardMessages)) {
    const createdAt = new Date(entry.createdAt || entry.updatedAt || 0).getTime();
    if (!createdAt || now - createdAt < CONFIG.initialDashboardTtlMinutes * 60 * 1000) continue;

    const orders = readJson(ORDERS_FILE);
    const paypalTotal = getPaymentsTotal(code);
    const { channel: ticketChannel, ticket } = await getTicketOrder(code);
    const state = buildOrderState(code, orders[code], ticket, paypalTotal);

    if (state.status !== 'DISCORD_SEUL') continue;

    const channel = await discord.channels.fetch(entry.channelId || CONFIG.dashboardChannelId).catch(() => null);
    const message = channel?.isTextBased() ? await channel.messages.fetch(entry.messageId).catch(() => null) : null;
    if (message) await message.delete().catch(() => {});

    suppressOrder(code, 'initial_timeout', 'auto');

    if (ticketChannel) {
      await ticketChannel.delete('CheapMeal: ticket initial inactif expiré').catch(error => {
        console.error(`Suppression ticket inactif impossible pour ${code} :`, error.message);
      });
    }

    cleanupOrderData(code);

    delete dashboardMessages[code];
    changed = true;
  }

  if (changed) writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);
}

function cleanupOldData() {
  const cutoff = Date.now() - CONFIG.dataRetentionDays * 24 * 60 * 60 * 1000;

  for (const file of [SEEN_FILE, ISSUES_FILE]) {
    const data = readJson(file);
    let changed = false;

    for (const [key, value] of Object.entries(data)) {
      const date = new Date(value.seenAt || value.updatedAt || value.validatedAt || 0).getTime();
      if (date && date < cutoff) {
        delete data[key];
        changed = true;
      }
    }

    if (changed) writeJson(file, data);
  }
}

let mailCheckRunning = false;
let imapBackoffUntil = 0;

function isImapLimitError(error) {
  const text = [
    error?.message,
    error?.reason,
    error?.code,
    error?.stack
  ].filter(Boolean).join(' ').toLowerCase();

  return text.includes('exceeded command') ||
    text.includes('bandwidth limits') ||
    text.includes('account exceeded') ||
    text.includes('noconnection') ||
    text.includes('connection not available');
}

function activateImapBackoff(error) {
  const minutes = Math.max(1, CONFIG.imapLimitBackoffMinutes);
  imapBackoffUntil = Date.now() + minutes * 60 * 1000;
  console.error(`Limite Gmail/IMAP détectée : pause automatique ${minutes} minute(s). Détail : ${error?.reason || error?.message || error}`);
}

function imapBackoffRemainingSeconds() {
  return Math.max(0, Math.ceil((imapBackoffUntil - Date.now()) / 1000));
}

async function processEmails() {
  const remaining = imapBackoffRemainingSeconds();
  if (remaining > 0) {
    console.log(`Pause Gmail/IMAP active, prochain essai dans ${remaining}s.`);
    return;
  }

  if (mailCheckRunning) {
    console.log('Vérification des mails déjà en cours, cycle ignoré.');
    return;
  }

  mailCheckRunning = true;
  try {
    console.log('Vérification des mails...');
      const seen = readJson(SEEN_FILE);
      const orders = readJson(ORDERS_FILE);

      const mails = await fetchNewEmails();
      const codesToEvaluate = new Set();
      if (mails.length > 0) console.log(`${mails.length} nouveau(x) mail(s) à traiter.`);

      for (const mail of mails) {
        try {
          const key = String(mail.uid);
          if (seen[key]) continue;

          // Les commandes site ne sont plus lues via Gmail/FormSubmit.
          // Elles arrivent directement par POST /order pour éviter les délais et les limites IMAP.
          const paypal = parsePaypalMail(mail);
          if (paypal?.code) {
            if (!isSuppressed(paypal.code)) {
              addPaypalPayment(paypal);
              codesToEvaluate.add(paypal.code);
              console.log(`PayPal détecté : ${paypal.code} / montants ${paypal.amounts.map(money).join(', ')}`);
            }
          }

          seen[key] = {
            subject: mail.subject,
            from: mail.from?.text || '',
            uid: mail.uid,
            seenAt: new Date().toISOString()
          };
        } catch (error) {
          console.error(`Mail UID ${mail?.uid || '?'} ignoré après erreur :`, error?.stack || error?.message || error);
        }
      }

      writeJson(SEEN_FILE, seen);
      writeJson(ORDERS_FILE, orders);

      for (const code of codesToEvaluate) {
        await evaluateOrder(code).catch(error => {
          console.error(`Erreur évaluation commande ${code} :`, error?.stack || error?.message || error);
        });
      }

      await scanOpenDiscordTickets();
      await cleanupInactiveInitialDashboards();
      await autoArchiveDeliveredDashboards();

      cleanupOldData();

  } catch (error) {
    console.error('Erreur vérification mails capturée sans arrêt du bot :', error?.stack || error?.message || error);
  } finally {
    mailCheckRunning = false;
    if (global.gc) global.gc();
  }
}


function sanitizeWebhookOrder(body) {
  const code = extractCode(body?.code || body?.Code_Commande || body?.orderCode || '');
  if (!code) throw new Error('Code commande manquant ou invalide');

  const product = normalizeText(body?.product || body?.Produit || '').trim();
  if (!product) throw new Error('Produit manquant');

  const quantity = Math.max(1, parseInt(body?.quantity || body?.Quantite || body?.['Quantité'] || '1', 10) || 1);
  const amount = parseAmount(body?.amount || body?.Montant || body?.Total_A_Payer || body?.total);
  if (amount === null) throw new Error('Montant manquant ou invalide');

  return {
    code,
    amount,
    discord: body?.discord || body?.Discord || null,
    identification: normalizeText(body?.identification || body?.Identification || body?.client || body?.Client || '').trim() || null,
    network: normalizeText(body?.network || body?.Network || body?.reseau || body?.Réseau || '').trim() || null,
    product,
    quantity,
    name: body?.name || body?.Nom || null,
    firstName: body?.firstName || body?.Prenom || body?.['Prénom'] || null,
    category: body?.category || body?.cat || body?.Categorie || null,
    ticketUrl: body?.ticketUrl || null,
    receivedAt: new Date().toISOString(),
    subject: `[WEBHOOK CHEAPMEAL] ${code} | ${Number(amount).toFixed(2)}€`,
    source: 'webhook'
  };
}

async function processWebhookOrder(order) {
  if (isSuppressed(order.code)) {
    return { ignored: true, reason: 'Commande supprimée manuellement' };
  }

  const orders = readJson(ORDERS_FILE);
  orders[order.code] = order;
  writeJson(ORDERS_FILE, orders);

  const dashboardMessages = readJson(DASHBOARD_MESSAGES_FILE);
  dashboardMessages[order.code] = {
    ...(dashboardMessages[order.code] || {}),
    orderSnapshot: order,
    webhookReceivedAt: new Date().toISOString()
  };
  writeJson(DASHBOARD_MESSAGES_FILE, dashboardMessages);

  const { channel: ticketChannel, ticket } = await getTicketOrder(order.code);
  const paypalTotal = getPaymentsTotal(order.code);
  const state = buildOrderState(order.code, order, ticket, paypalTotal);

  updateDashboard(order.code, order, ticket, paypalTotal, state.status, state.detail);
  await updateTicketChannelName(ticketChannel, state);
  await notifyDashboardChannel(order.code, order, ticket, paypalTotal, state, ticketChannel, { allowCreate: true });

  if (state.status === 'PAYE') {
    await notifyTicketValidated(order, ticket, paypalTotal);
  }

  return { ok: true, code: order.code, status: state.status };
}


async function processPaypalWebhookPayment(payload) {
  const code = extractCode(payload?.code || payload?.orderCode || payload?.Code_Commande || '');
  if (!code) throw new Error('Code commande PayPal manquant ou invalide');
  if (isSuppressed(code)) return { ignored: true, reason: 'Commande supprimée' };

  const rawAmounts = Array.isArray(payload?.amounts) ? payload.amounts : [payload?.amount ?? payload?.Montant ?? payload?.total];
  const amounts = rawAmounts.map(parseAmount).filter(v => v !== null);
  if (amounts.length === 0) throw new Error('Montant PayPal manquant ou invalide');

  const paypal = {
    code,
    amounts,
    subject: payload?.subject || `[PAYPAL WEBHOOK] ${code}`,
    from: payload?.from || 'paypal-forwarder',
    receivedAt: payload?.receivedAt || new Date().toISOString()
  };

  addPaypalPayment(paypal);
  await evaluateOrder(code);
  return { ok: true, code, amounts };
}

function startWebhookServer() {
  const app = express();

  app.use(cors({
    origin(origin, callback) {
      if (!CONFIG.webhookAllowedOrigin || !origin) return callback(null, true);
      return callback(null, origin === CONFIG.webhookAllowedOrigin);
    }
  }));
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false, limit: '50kb' }));

  app.get('/', (_req, res) => {
    res.json({ ok: true, service: 'cheapmeal-webhook', time: new Date().toISOString() });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/order', async (req, res) => {
    try {
      const order = sanitizeWebhookOrder(req.body || {});
      const result = await processWebhookOrder(order);
      res.json(result);
    } catch (error) {
      console.error('Webhook commande refusé :', error?.stack || error?.message || error);
      res.status(400).json({ ok: false, error: error?.message || 'Commande invalide' });
    }
  });

  app.post('/paypal', async (req, res) => {
    try {
      if (CONFIG.paypalWebhookSecret && req.headers['x-cheapmeal-secret'] !== CONFIG.paypalWebhookSecret) {
        return res.status(401).json({ ok: false, error: 'Secret invalide' });
      }
      const result = await processPaypalWebhookPayment(req.body || {});
      res.json(result);
    } catch (error) {
      console.error('Webhook PayPal refusé :', error?.stack || error?.message || error);
      res.status(400).json({ ok: false, error: error?.message || 'Paiement invalide' });
    }
  });

  app.listen(CONFIG.webhookPort, '0.0.0.0', () => {
    console.log(`Webhook commandes actif sur le port ${CONFIG.webhookPort}. Endpoint : POST /order`);
  });
}

async function start() {
  ensureFiles();

  if (hasMissingRequiredConfig) {
    console.error('Configuration incomplète : le bot reste en ligne mais ne peut pas démarrer correctement. Vérifie le .env.');
    return;
  }

  discord.once('ready', () => {
    console.log(`Bot mail connecté à Discord en tant que ${discord.user.tag}`);
  });

  discord.on(Events.InteractionCreate, interaction => {
    handleDeliveryInteraction(interaction).catch(error => {
      console.error('Erreur bouton livraison :', error);
    });
  });

  await discord.login(CONFIG.discordToken);
  startWebhookServer();

  console.log('Mode Render webhook-only : commandes site uniquement. Gmail/PayPal désactivé ici.');
}

start().catch(error => {
  logFatalError('start', error);
  console.error('Le bot ne quitte pas automatiquement. Corrige l’erreur ci-dessus puis redémarre le serveur si besoin.');
});
