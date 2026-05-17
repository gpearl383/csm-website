// Retell post-call webhook → HubSpot CRM + email (Resend) + SMS (Twilio)
// Secrets: Netlify environment variables only — never hardcode keys.

const crypto = require('crypto');

const HUBSPOT_PORTAL_ID = process.env.HUBSPOT_PORTAL_ID || '245793065';
const LEAD_SOURCE = 'Inbound Call — AI Secretary';
const CALENDLY_DEFAULT =
  'https://calendly.com/gpearl383/free-ai-strategy-discovery-call';

function verifyRetellSignature(rawBody, apiKey, signature) {
  if (!apiKey || !signature || typeof signature !== 'string') return false;
  try {
    const expected = crypto.createHmac('sha256', apiKey).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function normalizePhone(input) {
  if (!input || typeof input !== 'string') return '';
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (input.trim().startsWith('+')) return '+' + digits;
  return digits.length >= 10 ? '+' + digits : '';
}

function extractAnalysis(call) {
  const custom = call?.call_analysis?.custom_analysis_data || {};
  const fromNumber = call?.from_number || '';
  const vars = call?.retell_llm_dynamic_variables || {};

  const merged = { ...vars, ...custom };

  const callback =
    normalizePhone(merged.callback_phone) ||
    normalizePhone(merged.phone) ||
    normalizePhone(fromNumber);

  return {
    caller_type: (merged.caller_type || 'unknown').toLowerCase(),
    first_name: (merged.first_name || merged.firstname || '').trim(),
    last_name: (merged.last_name || merged.lastname || '').trim(),
    company: (merged.company || merged.company_name || '').trim(),
    job_title: (merged.job_title || merged.jobtitle || '').trim(),
    address_street: (merged.address_street || merged.street || '').trim(),
    address_city: (merged.address_city || merged.city || '').trim(),
    address_state: (merged.address_state || merged.state || '').trim(),
    address_zip: (merged.address_zip || merged.zip || '').trim(),
    company_phone: normalizePhone(merged.company_phone || merged.company_main_phone),
    callback_phone: callback,
    email: (merged.email || '').trim().toLowerCase(),
    call_reason: (merged.call_reason || merged.reason || '').trim(),
    company_size: (merged.company_size || '').trim(),
    industry: (merged.industry || '').trim(),
    timeline: (merged.timeline || merged.buying_timeline || '').trim(),
    lead_source_detail: (merged.lead_source_detail || merged.how_heard || '').trim(),
    budget_range: (merged.budget_range || '').trim(),
    wants_calendly_sms:
      merged.wants_calendly_sms === true ||
      merged.wants_calendly_sms === 'true' ||
      merged.wants_calendly_sms === 'yes',
    ai_tier_suggested: (merged.ai_tier_suggested || merged.ai_tier || '').trim(),
    urgency_score: String(merged.urgency_score || '').trim(),
    summary:
      (merged.summary || call?.call_analysis?.call_summary || '').trim() ||
      'Inbound call — see transcript in HubSpot note.',
    incomplete: merged.incomplete === true || merged.incomplete === 'true',
    escalation_requested:
      merged.escalation_requested === true || merged.escalation_requested === 'true',
  };
}

function callDurationSec(call) {
  const start = call?.start_timestamp;
  const end = call?.end_timestamp;
  if (!start || !end) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function buildNoteBody(call, data) {
  const lines = [
    `Inbound AI Secretary — ${new Date().toISOString()}`,
    `Retell call ID: ${call.call_id || 'n/a'}`,
    `Caller type: ${data.caller_type}`,
    `From: ${call.from_number || 'n/a'} → ${call.to_number || 'n/a'}`,
    `Duration: ${callDurationSec(call)}s | Disconnect: ${call.disconnection_reason || 'n/a'}`,
    '',
    `Summary: ${data.summary}`,
    '',
    `Name: ${data.first_name} ${data.last_name}`.trim(),
    `Company: ${data.company}`,
    `Title: ${data.job_title}`,
    `Email: ${data.email}`,
    `Callback: ${data.callback_phone}`,
    `Company phone: ${data.company_phone}`,
    `Reason: ${data.call_reason}`,
    `Size: ${data.company_size} | Industry: ${data.industry}`,
    `Timeline: ${data.timeline} | Urgency: ${data.urgency_score || 'n/a'}`,
    `Heard via: ${data.lead_source_detail} | Budget: ${data.budget_range}`,
    `AI tier (suggested): ${data.ai_tier_suggested}`,
    data.incomplete ? '⚠ Incomplete intake' : '',
    data.escalation_requested ? '⚠ Caller requested human follow-up' : '',
    '',
    `Recording: ${call.recording_url || 'not available'}`,
    '',
    '--- Transcript (excerpt) ---',
    (call.transcript || '').slice(0, 8000),
  ];
  return lines.filter(Boolean).join('\n');
}

async function hubspotRequest(path, method, body) {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('HUBSPOT_PRIVATE_APP_TOKEN not configured');

  const res = await fetch(`https://api.hubapi.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(json?.message || `HubSpot ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function searchContactByEmail(email) {
  if (!email) return null;
  const data = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [
      {
        filters: [{ propertyName: 'email', operator: 'EQ', value: email }],
      },
    ],
    properties: ['email', 'firstname', 'lastname', 'phone'],
    limit: 1,
  });
  return data.results?.[0] || null;
}

async function searchContactByPhone(phone) {
  if (!phone) return null;
  const data = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
    filterGroups: [
      {
        filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }],
      },
    ],
    properties: ['email', 'firstname', 'lastname', 'phone'],
    limit: 1,
  });
  return data.results?.[0] || null;
}

async function searchContactByRetellCallId(callId) {
  if (!callId) return null;
  try {
    const data = await hubspotRequest('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [
        {
          filters: [{ propertyName: 'retell_call_id', operator: 'EQ', value: callId }],
        },
      ],
      properties: ['email', 'firstname', 'lastname', 'phone', 'retell_call_id'],
      limit: 1,
    });
    return data.results?.[0] || null;
  } catch {
    return null;
  }
}

function buildContactProperties(data, callId) {
  const props = {
    firstname: data.first_name || undefined,
    lastname: data.last_name || undefined,
    email: data.email || undefined,
    phone: data.callback_phone || data.company_phone || undefined,
    company: data.company || undefined,
    jobtitle: data.job_title || undefined,
    address: data.address_street || undefined,
    city: data.address_city || undefined,
    state: data.address_state || undefined,
    zip: data.address_zip || undefined,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
  };

  const custom = {
    lead_source_inbound: LEAD_SOURCE,
    inbound_call_reason: data.call_reason || undefined,
    company_main_phone: data.company_phone || undefined,
    buying_timeline: data.timeline || undefined,
    budget_range: data.budget_range || undefined,
    company_size: data.company_size || undefined,
    last_inbound_call_date: new Date().toISOString().split('T')[0],
  };

  if (data.ai_tier_suggested) custom.ai_tier = data.ai_tier_suggested;
  if (data.industry) props.industry = data.industry;

  Object.assign(props, custom);
  Object.keys(props).forEach((k) => props[k] === undefined && delete props[k]);
  return props;
}

async function upsertContact(data, callId) {
  const existing =
    (await searchContactByRetellCallId(callId)) ||
    (data.email ? await searchContactByEmail(data.email) : null) ||
    (data.callback_phone ? await searchContactByPhone(data.callback_phone) : null) ||
    (data.company_phone ? await searchContactByPhone(data.company_phone) : null);

  const properties = buildContactProperties(data, callId);

  if (existing) {
    const updated = await hubspotRequest(
      `/crm/v3/objects/contacts/${existing.id}`,
      'PATCH',
      { properties }
    );
    return { id: existing.id, created: false, contact: updated };
  }

  if (!data.email && !data.callback_phone && !data.company_phone) {
    return { id: null, created: false, skipped: true };
  }

  try {
    const created = await hubspotRequest('/crm/v3/objects/contacts', 'POST', {
      properties,
    });
    return { id: created.id, created: true, contact: created };
  } catch (err) {
    if (err.status === 400 && err.body?.category === 'VALIDATION_ERROR') {
      const core = buildContactProperties(data, callId);
      ['lead_source_inbound', 'inbound_call_reason', 'company_main_phone', 'buying_timeline', 'budget_range', 'company_size', 'retell_call_id', 'last_inbound_call_date', 'ai_tier'].forEach(
        (k) => delete core[k]
      );
      const created = await hubspotRequest('/crm/v3/objects/contacts', 'POST', {
        properties: core,
      });
      return { id: created.id, created: true, contact: created, customPropsSkipped: true };
    }
    throw err;
  }
}

async function createContactNote(contactId, noteBody) {
  const timestamp = new Date().toISOString();
  return hubspotRequest('/crm/v3/objects/notes', 'POST', {
    properties: {
      hs_timestamp: timestamp,
      hs_note_body: noteBody,
    },
    associations: [
      {
        to: { id: contactId },
        types: [
          {
            associationCategory: 'HUBSPOT_DEFINED',
            associationTypeId: 202,
          },
        ],
      },
    ],
  });
}

async function sendResendEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL || 'geoff@csmintegrated.com';
  const from =
    process.env.RESEND_FROM || 'CSM Integrated Solutions <info@csmintegrated.com>';

  if (!apiKey) {
    console.warn('RESEND_API_KEY missing — skipping email');
    return { skipped: true };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend ${res.status}: ${t}`);
  }
  return res.json();
}

async function sendTwilioSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_SMS_FROM;

  if (!sid || !token || !from) {
    console.warn('Twilio env missing — skipping SMS');
    return { skipped: true };
  }

  const normalized = normalizePhone(to);
  if (!normalized) return { skipped: true, reason: 'invalid_to' };

  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: normalized, From: from, Body: body }),
    }
  );

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Twilio ${res.status}: ${t}`);
  }
  return res.json();
}

function buildAlertSms(data) {
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || 'Unknown';
  const lines = [
    `CSM inbound call`,
    `${name}${data.company ? ' — ' + data.company : ''}`,
    data.callback_phone ? `Call back: ${data.callback_phone}` : '',
    data.email ? `Email: ${data.email}` : '',
    data.call_reason ? `Reason: ${data.call_reason.slice(0, 120)}` : '',
    data.escalation_requested ? '⚠ Wants human callback' : '',
  ];
  return lines.filter(Boolean).join('\n').slice(0, 1500);
}

function buildEmailHtml(call, data, contactId) {
  const hubspotUrl = contactId
    ? `https://app.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/contact/${contactId}`
    : null;
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || '(not provided)';

  return `
    <h2>Inbound AI Secretary Call</h2>
    <p><strong>${name}</strong>${data.company ? ` · ${data.company}` : ''}</p>
    <table cellpadding="6" style="font-family:sans-serif;font-size:14px;">
      <tr><td><strong>Caller type</strong></td><td>${data.caller_type}</td></tr>
      <tr><td><strong>Email</strong></td><td>${data.email || '—'}</td></tr>
      <tr><td><strong>Callback</strong></td><td>${data.callback_phone || call.from_number || '—'}</td></tr>
      <tr><td><strong>Company phone</strong></td><td>${data.company_phone || '—'}</td></tr>
      <tr><td><strong>Title</strong></td><td>${data.job_title || '—'}</td></tr>
      <tr><td><strong>Reason</strong></td><td>${data.call_reason || '—'}</td></tr>
      <tr><td><strong>Timeline</strong></td><td>${data.timeline || '—'}</td></tr>
      <tr><td><strong>Urgency</strong></td><td>${data.urgency_score || '—'}</td></tr>
      <tr><td><strong>Retell call ID</strong></td><td>${call.call_id || '—'}</td></tr>
    </table>
    <p><strong>Summary</strong><br/>${data.summary.replace(/\n/g, '<br/>')}</p>
    ${hubspotUrl ? `<p><a href="${hubspotUrl}">Open contact in HubSpot →</a></p>` : '<p><em>Contact not created (missing email/phone).</em></p>'}
    ${call.recording_url ? `<p><a href="${call.recording_url}">Recording (10 min link)</a></p>` : ''}
  `;
}

async function markCallProcessed(contactId, callId) {
  if (!contactId || !callId) return;
  try {
    await hubspotRequest(`/crm/v3/objects/contacts/${contactId}`, 'PATCH', {
      properties: { retell_call_id: callId },
    });
  } catch {
    /* custom property may not exist yet */
  }
}

async function processCallAnalyzed(call) {
  const callId = call.call_id;
  const existingByCall = await searchContactByRetellCallId(callId);
  if (existingByCall) {
    return { ok: true, duplicate: true, contactId: existingByCall.id };
  }

  const duration = callDurationSec(call);
  if (duration > 0 && duration < 15) {
    return { ok: true, skipped: true, reason: 'short_call' };
  }

  const data = extractAnalysis(call);
  const noteBody = buildNoteBody(call, data);

  let contactResult = { id: null };
  const hasIdentity = data.email || data.callback_phone || data.company_phone;

  if (hasIdentity && data.caller_type !== 'spam') {
    contactResult = await upsertContact(data, callId);
    if (contactResult.id) {
      await createContactNote(contactResult.id, noteBody);
    }
  }

  const subject = `[CSM] Inbound call: ${[data.first_name, data.last_name].filter(Boolean).join(' ') || call.from_number || 'Unknown'}`;
  await sendResendEmail(subject, buildEmailHtml(call, data, contactResult.id));

  const geoffPhone = process.env.GEOFF_ALERT_PHONE || '+15165079380';
  await sendTwilioSms(geoffPhone, buildAlertSms(data));

  const calendlyUrl = process.env.CALENDLY_DISCOVERY_URL || CALENDLY_DEFAULT;
  if (data.wants_calendly_sms && data.callback_phone) {
    await sendTwilioSms(
      data.callback_phone,
      `Thanks for calling CSM Integrated Solutions. Book a free 30-min discovery call: ${calendlyUrl}`
    );
  }

  if (contactResult.id) {
    await markCallProcessed(contactResult.id, callId);
  }

  return {
    ok: true,
    contactId: contactResult.id,
    contactCreated: contactResult.created,
    customPropsSkipped: contactResult.customPropsSkipped,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body || '';

  const skipVerify = process.env.RETELL_SKIP_VERIFY === 'true';
  const apiKey = process.env.RETELL_API_KEY;
  const signature =
    event.headers['x-retell-signature'] ||
    event.headers['X-Retell-Signature'];

  if (!skipVerify) {
    if (!verifyRetellSignature(rawBody, apiKey, signature)) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const eventType = payload.event;
  if (eventType !== 'call_analyzed') {
    return { statusCode: 204, body: '' };
  }

  try {
    const result = await processCallAnalyzed(payload.call || {});
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('retell-webhook error:', err.message, err.body || '');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
