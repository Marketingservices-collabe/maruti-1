// /api/data
// Same-origin backend for the app, backed by Supabase (Postgres + Storage) instead of
// a Google Sheet. The browser only ever talks to this endpoint — it never sees the
// Supabase URL or the service-role key, which stays server-side here.
//
// Required environment variables (set these in the Vercel project settings):
//   SUPABASE_URL              e.g. https://xxxx.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY the "service_role" secret key (Project Settings → API)
//     — NOT the anon/publishable key. This key bypasses Row Level Security, which is
//     exactly what's wanted here since every table has RLS enabled with no policies:
//     the only way in is through this server-side function, never directly from a
//     browser with the anon key.
//
// Table names mirror the original Sheets: BillingLocations, ServiceLocations, Notes,
// Attachments, JobTickets, ReportTypes, Reports, Users, Sessions. Ticket numbers come
// from a Postgres sequence exposed as the next_ticket_no() RPC. Attachments are stored
// in the public "attachments" Storage bucket instead of Google Drive.

const MASTER_EMAIL = 'support@maruti@zentrades.pro';
const MASTER_PASSWORD = 'Admin@123';
const SESSION_HOURS = 12;

function env(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!url || !key){
    throw new Error('Backend not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Vercel project.');
  }
  return {url, key};
}

async function rest(path, options={}){
  const {url, key} = env();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if(!res.ok) throw new Error((body && (body.message || body.error)) || `Supabase error (${res.status})`);
  return body;
}

async function selectAll(table){
  // Reports has no createdAt column, only savedAt — order by whichever timestamp
  // column the table actually has so listings still come back oldest-first.
  const orderCol = table === 'Reports' ? 'savedAt' : 'createdAt';
  return rest(`${encodeURIComponent(table)}?select=*&order=${orderCol}.asc`);
}
async function selectById(table, id){
  const rows = await rest(`${encodeURIComponent(table)}?select=*&id=eq.${encodeURIComponent(id)}`);
  return rows[0] || null;
}
async function insertRow(table, data){
  const rows = await rest(`${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {'Prefer': 'return=representation'},
    body: JSON.stringify(data)
  });
  return rows[0];
}
async function updateRow(table, id, data){
  if(Object.keys(data).length === 0){
    // Nothing to change (e.g. a Users update with no new password or role) — PATCH
    // with an empty body has no columns to SET, so just confirm the row still exists.
    return selectById(table, id);
  }
  const rows = await rest(`${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {'Prefer': 'return=representation'},
    body: JSON.stringify(data)
  });
  return rows[0] || null;
}
async function deleteRow(table, id){
  await rest(`${encodeURIComponent(table)}?id=eq.${encodeURIComponent(id)}`, {method: 'DELETE'});
}
async function insertRows(table, dataArray){
  return rest(`${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {'Prefer': 'return=representation'},
    body: JSON.stringify(dataArray)
  });
}
async function nextTicketNo(){
  const result = await rest('rpc/next_ticket_no', {method: 'POST', body: '{}'});
  return result;
}
async function nextTicketNos(n){
  // One RPC call reserves n sequential ticket numbers at once — used by recurring
  // tickets (multi-month/multi-year schedules) instead of n separate round trips.
  return rest('rpc/next_ticket_nos', {method: 'POST', body: JSON.stringify({n})});
}
async function nextEstimateNo(){
  return rest('rpc/next_estimate_no', {method: 'POST', body: '{}'});
}
async function nextInvoiceNo(){
  return rest('rpc/next_invoice_no', {method: 'POST', body: '{}'});
}
async function getCompanySettings_(){
  const rows = await selectAll('CompanySettings');
  return rows[0] || null;
}

async function getUserByEmail_(email, users){
  // Plain equality is case-sensitive and ilike treats "_" (common in real emails) as a
  // single-char wildcard, so match the same way the original Sheets backend did: fetch
  // and compare case-insensitively in JS. The Users table is small, so this is cheap.
  // Pass an already-fetched `users` array (e.g. from login) to skip a redundant round
  // trip to Supabase — every one of those costs a Singapore hop.
  const rows = users || await selectAll('Users');
  return rows.find(u => String(u.email).toLowerCase() === String(email).toLowerCase()) || null;
}

async function makeSession_(user){
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_HOURS*3600*1000).toISOString();
  const row = await insertRow('Sessions', {userId: user.id, email: user.email, role: user.role, expiresAt});
  return {token: row.id, expiresAt: row.expiresAt};
}
async function getSession_(token){
  if(!token) return null;
  const row = await selectById('Sessions', token);
  if(!row) return null;
  if(new Date(row.expiresAt) < new Date()) return null;
  return row;
}
async function cleanupExpiredSessions_(){
  try{ await rest(`Sessions?expiresAt=lt.${encodeURIComponent(new Date().toISOString())}`, {method: 'DELETE'}); }
  catch(e){ /* best effort */ }
}

async function uploadAttachment_(data){
  const {url, key} = env();
  const bytes = Buffer.from(data.base64, 'base64');
  const safeName = String(data.name || 'attachment').replace(/[^\w.\-]+/g, '_');
  const path = `${data.serviceId || 'unfiled'}/${Date.now()}-${safeName}`;
  const upRes = await fetch(`${url}/storage/v1/object/attachments/${path}`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': data.mimeType || 'application/octet-stream'
    },
    body: bytes
  });
  if(!upRes.ok){
    const errText = await upRes.text().catch(()=> '');
    throw new Error(`Storage upload failed (${upRes.status}): ${errText}`);
  }
  const fileUrl = `${url}/storage/v1/object/public/attachments/${path}`;
  const rec = await insertRow('Attachments', {
    serviceId: data.serviceId, name: data.name, mimeType: data.mimeType, fileUrl
  });
  return {id: rec.id, url: fileUrl};
}

async function renderHtmlToPdf_(html){
  // Server-side PDF rendering for email attachments — separate from the client-side
  // html2pdf() export button, which needs a live browser DOM this serverless function
  // doesn't have. Uses PDFShift (https://pdfshift.io) as a plain REST API, same "no
  // SDK" pattern as Resend for email. Required env var: PDFSHIFT_API_KEY.
  const apiKey = process.env.PDFSHIFT_API_KEY;
  if(!apiKey) return {ok:false, error:'PDF attachments are not configured yet — set PDFSHIFT_API_KEY in the Vercel project.'};
  try{
    const res = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from('api:' + apiKey).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({source: html, format: 'Letter', use_print: false})
    });
    if(!res.ok){
      const errText = await res.text().catch(()=> '');
      return {ok:false, error:`PDF render failed (${res.status}): ${errText.slice(0,200)}`};
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {ok:true, base64: buf.toString('base64')};
  }catch(e){ return {ok:false, error:String(e && e.message || e)}; }
}

async function sendEmail_(data, session){
  // Doc §4 — reusable email sending: general customer communication today, Estimates/
  // Invoices later. Uses Resend (https://resend.com) as the provider — a Vercel-friendly
  // REST API, no SDK needed. Required env vars:
  //   RESEND_API_KEY  the account's API key (Resend dashboard → API Keys)
  //   EMAIL_FROM      a verified sender, e.g. "Maruti <notifications@yourdomain.com>" —
  //                   falls back to Resend's sandbox address, which only delivers to the
  //                   account owner's own verified email (fine for testing, not for
  //                   real customers) until a sending domain is verified.
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const to = Array.isArray(data.to) ? data.to.filter(Boolean) : [];
  const cc = Array.isArray(data.cc) ? data.cc.filter(Boolean) : [];
  const bcc = Array.isArray(data.bcc) ? data.bcc.filter(Boolean) : [];
  const subject = String(data.subject || '').trim();

  if(!to.length) return {ok:false, error:'At least one recipient is required.'};
  if(!subject) return {ok:false, error:'Subject is required.'};
  if(!apiKey) return {ok:false, error:'Email sending is not configured yet — set RESEND_API_KEY (and ideally EMAIL_FROM) in the Vercel project.'};

  // Attachments reference files already uploaded to Supabase Storage (e.g. a service
  // location's existing Attachments) — fetch and inline each as base64. A single bad
  // attachment link shouldn't sink the whole send, so skip it rather than throw.
  const attachments = [];
  if(Array.isArray(data.attachments) && data.attachments.length){
    for(const att of data.attachments){
      try{
        const fileRes = await fetch(att.url);
        if(!fileRes.ok) continue;
        const buf = Buffer.from(await fileRes.arrayBuffer());
        attachments.push({filename: att.name || 'attachment', content: buf.toString('base64')});
      }catch(e){ /* skip a broken attachment rather than failing the whole send */ }
    }
  }

  // Estimates/Invoices pass their rendered document as standalone HTML (the doc's own
  // markup + the page's live stylesheet) here to attach a PDF copy alongside the link
  // in the email — a nice-to-have, so a render failure (or PDFSHIFT_API_KEY not being
  // set yet) never blocks the send itself, just skips the attachment.
  let pdfWarning = null;
  if(data.pdfHtml){
    const pdf = await renderHtmlToPdf_(data.pdfHtml);
    if(pdf.ok) attachments.push({filename: data.pdfFilename || 'document.pdf', content: pdf.base64});
    else pdfWarning = pdf.error;
  }

  const payload = {
    from, to, subject,
    html: data.html || '<p></p>',
    ...(cc.length ? {cc} : {}),
    ...(bcc.length ? {bcc} : {}),
    ...(attachments.length ? {attachments} : {})
  };

  let sendOk = true, errorMessage = null;
  try{
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const sendBody = await sendRes.json().catch(()=> ({}));
    if(!sendRes.ok){ sendOk = false; errorMessage = sendBody.message || `Email provider error (${sendRes.status})`; }
  }catch(e){ sendOk = false; errorMessage = String(e && e.message || e); }

  // Log regardless of outcome — a failed send should still show up in history, not
  // vanish, so the office can see it needs a resend.
  try{
    await insertRow('EmailLog', {
      billingId: data.billingId || null,
      toEmails: to.join(', '),
      ccEmails: cc.join(', '),
      bccEmails: bcc.join(', '),
      subject,
      documentRef: data.documentRef || 'General communication',
      sentBy: session.email,
      status: sendOk ? 'sent' : 'failed',
      errorMessage: sendOk ? pdfWarning : errorMessage
    });
  }catch(e){ /* logging failure shouldn't mask the send result */ }

  return sendOk ? {ok:true, pdfWarning} : {ok:false, error: errorMessage};
}

async function autoExpireEstimate_(est){
  // Lazy expiry — there's no cron here, so a Sent/Viewed estimate past its expiration
  // date is corrected to 'Expired' the moment anything actually reads it (the internal
  // detail view, or the customer's own public link), rather than staying stale forever.
  if(!est || !est.expirationDate) return est;
  if(est.status !== 'Sent' && est.status !== 'Viewed') return est;
  const today = new Date().toISOString().slice(0,10);
  if(est.expirationDate >= today) return est;
  const updated = await updateRow('Estimates', est.id, {status: 'Expired'});
  if(updated){
    try{ await insertRow('EstimateActivity', {estimateId: est.id, action: 'Expired', actorName: 'System'}); }catch(e){}
    return updated;
  }
  return est;
}

async function getPublicEstimate_(id){
  // No session required — this is the link a customer opens from their email.
  // Deliberately hands back only what a customer should see: the estimate, its line
  // items, the billing/service names, and the company profile for branding.
  if(!id) return {ok:false, error:'Missing estimate id.'};
  let est = await selectById('Estimates', id);
  if(!est) return {ok:false, error:'Estimate not found.'};
  est = await autoExpireEstimate_(est);

  const [lineItems, billing, service, company] = await Promise.all([
    rest(`EstimateLineItems?estimateId=eq.${encodeURIComponent(id)}&select=*&order=sortOrder.asc`),
    est.billingId ? selectById('BillingLocations', est.billingId) : null,
    est.serviceId ? selectById('ServiceLocations', est.serviceId) : null,
    getCompanySettings_()
  ]);

  // First time the customer actually opens it: Sent -> Viewed.
  if(est.status === 'Sent'){
    const updated = await updateRow('Estimates', id, {status: 'Viewed', viewedAt: new Date().toISOString()});
    if(updated){
      try{ await insertRow('EstimateActivity', {estimateId: id, action: 'Viewed', actorName: 'Customer'}); }catch(e){}
      est = updated;
    }
  }

  return {ok:true, estimate: est, lineItems, billing, service, company};
}

async function respondToEstimate_(data){
  // No session required — this is the customer clicking Approve/Reject on their own
  // estimate link. Scoped tightly: it can only move THIS estimate from Sent/Viewed to
  // Approved/Rejected, nothing else.
  const id = data.id;
  const response = data.response;
  if(!id || (response !== 'approve' && response !== 'reject')){
    return {ok:false, error:'Invalid request.'};
  }
  let est = await selectById('Estimates', id);
  if(!est) return {ok:false, error:'Estimate not found.'};
  est = await autoExpireEstimate_(est);
  if(est.status !== 'Sent' && est.status !== 'Viewed'){
    return {ok:false, error: est.status === 'Expired'
      ? 'This estimate has expired — please contact us for an updated one.'
      : `This estimate has already been ${String(est.status).toLowerCase()} and can't be changed.`};
  }
  const now = new Date().toISOString();
  if(response === 'approve'){
    const approverName = String(data.approverName || '').trim() || 'Customer';
    await updateRow('Estimates', id, {status: 'Approved', approvedAt: now, approvedByName: approverName});
    try{ await insertRow('EstimateActivity', {estimateId: id, action: 'Approved', actorName: approverName}); }catch(e){}
  } else {
    const reason = String(data.rejectionReason || '').trim();
    await updateRow('Estimates', id, {status: 'Rejected', rejectedAt: now, rejectionReason: reason});
    try{ await insertRow('EstimateActivity', {estimateId: id, action: 'Rejected', detail: reason, actorName: 'Customer'}); }catch(e){}
  }
  return {ok:true};
}

async function recalcInvoiceTotals_(invoiceId){
  // Single source of truth for amountPaid/balanceDue/status after any payment is
  // recorded or removed — recomputed from the actual InvoicePayments rows rather than
  // incrementally adjusted, so it can never drift out of sync.
  const [inv, payments] = await Promise.all([
    selectById('Invoices', invoiceId),
    rest(`InvoicePayments?invoiceId=eq.${encodeURIComponent(invoiceId)}&select=amount`)
  ]);
  if(!inv) return null;
  const amountPaid = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const total = parseFloat(inv.total) || 0;
  const balanceDue = Math.max(0, total - amountPaid);
  let status = inv.status;
  if(status !== 'Void'){
    if(balanceDue <= 0.005 && total > 0) status = 'Paid';
    else if(amountPaid > 0) status = 'Partially Paid';
    else if(status === 'Paid' || status === 'Partially Paid') status = inv.sentAt ? 'Sent' : 'Draft';
  }
  const patch = {amountPaid, balanceDue, status};
  if(status === 'Paid' && !inv.paidAt) patch.paidAt = new Date().toISOString();
  if(status !== 'Paid') patch.paidAt = null;
  return updateRow('Invoices', invoiceId, patch);
}

async function recordInvoicePayment_(data, session){
  const invoiceId = data.invoiceId;
  const amount = parseFloat(data.amount);
  if(!invoiceId || !(amount > 0)) return {ok:false, error:'A valid invoice and payment amount are required.'};
  const inv = await selectById('Invoices', invoiceId);
  if(!inv) return {ok:false, error:'Invoice not found.'};
  if(inv.status === 'Void') return {ok:false, error:'This invoice is void and cannot receive payments.'};
  await insertRow('InvoicePayments', {
    invoiceId, amount, method: data.method || 'other',
    reference: data.reference || null, notes: data.notes || null,
    receivedBy: session.email, paymentDate: data.paymentDate || new Date().toISOString().slice(0,10)
  });
  const updated = await recalcInvoiceTotals_(invoiceId);
  try{
    await insertRow('InvoiceActivity', {
      invoiceId, action: 'Payment recorded',
      detail: `${data.method || 'other'} · $${amount.toFixed(2)}${data.reference ? ' · Ref '+data.reference : ''}`,
      actorName: session.email
    });
  }catch(e){}
  return {ok:true, invoice: updated};
}

async function autoOverdueInvoice_(inv){
  // Lazy status correction mirroring autoExpireEstimate_ — a Sent/Viewed/Partially Paid
  // invoice past its due date with a balance still owed flips to Overdue the moment
  // anything actually reads it, rather than needing a cron job.
  if(!inv || !inv.dueDate) return inv;
  if(!['Sent','Viewed','Partially Paid'].includes(inv.status)) return inv;
  if((parseFloat(inv.balanceDue) || 0) <= 0) return inv;
  const today = new Date().toISOString().slice(0,10);
  if(inv.dueDate >= today) return inv;
  const updated = await updateRow('Invoices', inv.id, {status: 'Overdue'});
  if(updated){
    try{ await insertRow('InvoiceActivity', {invoiceId: inv.id, action: 'Overdue', actorName: 'System'}); }catch(e){}
    return updated;
  }
  return inv;
}

async function getPublicInvoice_(id){
  // No session required — the link a customer opens from their invoice email. Read-only:
  // payments are recorded by staff, there is no online payment collection here.
  if(!id) return {ok:false, error:'Missing invoice id.'};
  let inv = await selectById('Invoices', id);
  if(!inv) return {ok:false, error:'Invoice not found.'};
  inv = await autoOverdueInvoice_(inv);

  const [lineItems, payments, billing, service, company] = await Promise.all([
    rest(`InvoiceLineItems?invoiceId=eq.${encodeURIComponent(id)}&select=*&order=sortOrder.asc`),
    rest(`InvoicePayments?invoiceId=eq.${encodeURIComponent(id)}&select=*&order=createdAt.asc`),
    inv.billingId ? selectById('BillingLocations', inv.billingId) : null,
    inv.serviceId ? selectById('ServiceLocations', inv.serviceId) : null,
    getCompanySettings_()
  ]);

  if(inv.status === 'Sent'){
    const updated = await updateRow('Invoices', id, {status: 'Viewed', viewedAt: new Date().toISOString()});
    if(updated){
      try{ await insertRow('InvoiceActivity', {invoiceId: id, action: 'Viewed', actorName: 'Customer'}); }catch(e){}
      inv = updated;
    }
  }

  return {ok:true, invoice: inv, lineItems, payments, billing, service, company};
}

async function convertEstimateToInvoice_(data, session){
  // Doc §11/§12 bridge — turns an Approved estimate into a new Draft invoice, copying
  // its line items exactly (never re-pricing from the Price Book) and marking the
  // estimate as Converted so it can't be converted twice.
  const estimateId = data.estimateId;
  if(!estimateId) return {ok:false, error:'Missing estimate id.'};
  const est = await selectById('Estimates', estimateId);
  if(!est) return {ok:false, error:'Estimate not found.'};
  if(est.convertedInvoiceId) return {ok:false, error:'This estimate has already been converted to an invoice.'};
  if(est.status !== 'Approved') return {ok:false, error:'Only an Approved estimate can be converted to an invoice.'};

  const lineItems = await rest(`EstimateLineItems?estimateId=eq.${encodeURIComponent(estimateId)}&select=*&order=sortOrder.asc`);
  const today = new Date();
  const dueDate = new Date(today.getTime() + 30*24*3600*1000); // net-30 default

  const invoice = await insertRow('Invoices', {
    invoiceNo: await nextInvoiceNo(),
    billingId: est.billingId, serviceId: est.serviceId, jobTicketId: est.jobTicketId,
    estimateId: est.id, status: 'Draft',
    invoiceDate: today.toISOString().slice(0,10), dueDate: dueDate.toISOString().slice(0,10),
    preparedBy: est.preparedBy, notes: est.notes, termsConditions: est.termsConditions,
    discountType: est.discountType, discountValue: est.discountValue, taxRate: est.taxRate,
    subtotal: est.subtotal, taxAmount: est.taxAmount, total: est.total,
    amountPaid: 0, balanceDue: est.total
  });

  if(lineItems.length){
    await insertRows('InvoiceLineItems', lineItems.map((li,i)=>({
      invoiceId: invoice.id, priceBookItemId: li.priceBookItemId,
      name: li.name, description: li.description, quantity: li.quantity, unitPrice: li.unitPrice,
      discount: li.discount, taxable: li.taxable, sortOrder: i
    })));
  }

  await updateRow('Estimates', est.id, {convertedInvoiceId: invoice.id, status: 'Converted'});
  try{
    await insertRow('EstimateActivity', {estimateId: est.id, action: 'Converted', detail: `Invoice ${invoice.invoiceNo}`, actorName: session.email});
    await insertRow('InvoiceActivity', {invoiceId: invoice.id, action: 'Created', detail: `Converted from ${est.estimateNo}`, actorName: session.email});
  }catch(e){}

  return {ok:true, id: invoice.id, invoiceNo: invoice.invoiceNo};
}

function jsonOut(res, obj){
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(obj));
}

export default async function handler(req, res){
  try{
    if(req.method === 'GET'){
      const {action, sheet, id, billingId, serviceId, jobTicketId, estimateId, invoiceId, q, token} = req.query;

      if(action === 'publicEstimate'){
        // No session — the customer's own emailed link.
        return jsonOut(res, await getPublicEstimate_(id));
      }
      if(action === 'publicInvoice'){
        return jsonOut(res, await getPublicInvoice_(id));
      }

      const runQuery = async () => {
        if(action === 'list'){
          let rows = await selectAll(sheet);
          if(billingId) rows = rows.filter(r => String(r.billingId) === String(billingId));
          if(serviceId) rows = rows.filter(r => String(r.serviceId) === String(serviceId));
          if(jobTicketId) rows = rows.filter(r => String(r.jobTicketId) === String(jobTicketId));
          if(estimateId) rows = rows.filter(r => String(r.estimateId) === String(estimateId));
          if(invoiceId) rows = rows.filter(r => String(r.invoiceId) === String(invoiceId));
          return {ok:true, rows};
        }
        if(action === 'get'){
          let row = await selectById(sheet, id);
          if(sheet === 'Estimates' && row) row = await autoExpireEstimate_(row);
          if(sheet === 'Invoices' && row) row = await autoOverdueInvoice_(row);
          return {ok:true, row};
        }
        if(action === 'search'){
          const query = (q || '').toLowerCase();
          const [allBilling, allServices] = await Promise.all([selectAll('BillingLocations'), selectAll('ServiceLocations')]);
          const billing = allBilling.filter(r => !query || String(r.name).toLowerCase().includes(query) || String(r.cityState).toLowerCase().includes(query));
          const services = allServices.filter(r => !query || String(r.name).toLowerCase().includes(query) || String(r.cityState).toLowerCase().includes(query));
          return {ok:true, billing, services};
        }
        return {ok:false, error:'Unknown action: ' + action};
      };

      if(sheet === 'Users'){
        // Needs the role check before it's safe to hand back rows, so this stays
        // sequential: verify session, then query.
        const session = await getSession_(token);
        if(!session) return jsonOut(res, {ok:false, error:'Not authenticated — please log in.', authRequired:true});
        if(session.role !== 'admin') return jsonOut(res, {ok:false, error:'Admin access required.'});
        return jsonOut(res, await runQuery());
      }

      // Everything else doesn't gate on role, so run the session check and the actual
      // query concurrently instead of one after another — each is its own round trip
      // to Supabase, and overlapping them roughly halves the visible latency.
      const [session, result] = await Promise.all([getSession_(token), runQuery()]);
      if(!session) return jsonOut(res, {ok:false, error:'Not authenticated — please log in.', authRequired:true});
      return jsonOut(res, result);
    }

    if(req.method === 'POST'){
      // Frontend sends Content-Type: text/plain with a JSON string body — Vercel puts
      // that raw string straight into req.body since it isn't application/json.
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const action = body.action;

      if(action === 'login'){
        const email = String(body.email || '').trim();
        const password = String(body.password || '');
        // One fetch of Users covers both the "seed the master admin" check and the
        // actual lookup — this used to be two separate round trips to Supabase.
        let users = await selectAll('Users');
        if(!users.length){
          const seeded = await insertRow('Users', {email: MASTER_EMAIL, password: MASTER_PASSWORD, role: 'admin'});
          users = [seeded];
        }
        const user = await getUserByEmail_(email, users);
        if(!user || String(user.password) !== password){
          return jsonOut(res, {ok:false, error:'Incorrect email or password.'});
        }
        // Session cleanup doesn't need to happen before creating the new session —
        // run them concurrently instead of one after another.
        const [session] = await Promise.all([makeSession_(user), cleanupExpiredSessions_()]);
        return jsonOut(res, {ok:true, token: session.token, expiresAt: session.expiresAt, user:{id:user.id, email:user.email, role:user.role}});
      }

      if(action === 'publicEstimateRespond'){
        // No session — the customer clicking Approve/Reject on their own estimate link.
        return jsonOut(res, await respondToEstimate_(body.data || {}));
      }

      const session = await getSession_(body.token);

      if(action === 'logout'){
        if(body.token){ try{ await deleteRow('Sessions', body.token); }catch(e){ /* best effort */ } }
        return jsonOut(res, {ok:true});
      }
      if(!session) return jsonOut(res, {ok:false, error:'Not authenticated — please log in.', authRequired:true});

      if(action === 'uploadAttachment'){
        const result = await uploadAttachment_(body.data || {});
        return jsonOut(res, {ok:true, ...result});
      }

      if(action === 'sendEmail'){
        const result = await sendEmail_(body.data || {}, session);
        return jsonOut(res, result);
      }

      if(action === 'recordInvoicePayment'){
        return jsonOut(res, await recordInvoicePayment_(body.data || {}, session));
      }
      if(action === 'convertEstimateToInvoice'){
        return jsonOut(res, await convertEstimateToInvoice_(body.data || {}, session));
      }

      const sheet = body.sheet;
      if(sheet === 'Users' && session.role !== 'admin'){
        return jsonOut(res, {ok:false, error:'Admin access required.'});
      }

      if(action === 'create'){
        const data = Object.assign({}, body.data);
        if(sheet === 'Users'){
          if(!data.email || !data.password) return jsonOut(res, {ok:false, error:'Email and password are required.'});
          const dupe = await getUserByEmail_(data.email);
          if(dupe) return jsonOut(res, {ok:false, error:'A user with that email already exists.'});
          data.role = data.role === 'admin' ? 'admin' : 'user';
        }
        if(sheet === 'JobTickets' && !data.ticketNo){
          data.ticketNo = await nextTicketNo();
        }
        if(sheet === 'Reports' && !data.savedAt){
          data.savedAt = new Date().toISOString();
        }
        if(sheet === 'Estimates'){
          if(!data.estimateNo) data.estimateNo = await nextEstimateNo();
          if(!data.estimateDate) data.estimateDate = new Date().toISOString().slice(0,10);
        }
        if(sheet === 'Invoices'){
          if(!data.invoiceNo) data.invoiceNo = await nextInvoiceNo();
          if(!data.invoiceDate) data.invoiceDate = new Date().toISOString().slice(0,10);
        }
        const row = await insertRow(sheet, data);
        return jsonOut(res, {ok:true, id: row.id, ticketNo: row.ticketNo, estimateNo: row.estimateNo, invoiceNo: row.invoiceNo});
      }
      if(action === 'createMany'){
        // Used for recurring tickets (multi-month/multi-year schedules) — creates
        // several rows in one round trip instead of one create call per occurrence.
        if(sheet === 'Users') return jsonOut(res, {ok:false, error:'Not supported for Users.'});
        let dataList = Array.isArray(body.dataList) ? body.dataList.map(d => Object.assign({}, d)) : [];
        if(dataList.length > 60) return jsonOut(res, {ok:false, error:'Too many tickets at once (max 60).'});
        if(!dataList.length) return jsonOut(res, {ok:true, rows:[]});
        if(sheet === 'JobTickets'){
          const missing = dataList.filter(d => !d.ticketNo).length;
          if(missing){
            const nums = await nextTicketNos(missing);
            let i = 0;
            dataList = dataList.map(d => d.ticketNo ? d : Object.assign({}, d, {ticketNo: nums[i++]}));
          }
        }
        if(sheet === 'Reports'){
          dataList = dataList.map(d => d.savedAt ? d : Object.assign({}, d, {savedAt: new Date().toISOString()}));
        }
        const rows = await insertRows(sheet, dataList);
        return jsonOut(res, {ok:true, rows});
      }
      if(action === 'update'){
        const incoming = Object.assign({}, body.data);
        if(sheet === 'Users'){
          if(!incoming.password) delete incoming.password; // don't blank out an existing password by accident
          if(incoming.role) incoming.role = incoming.role === 'admin' ? 'admin' : 'user';
        }
        delete incoming.id;
        const row = await updateRow(sheet, body.id, incoming);
        if(!row) return jsonOut(res, {ok:false, error:'Row not found'});
        return jsonOut(res, {ok:true});
      }
      if(action === 'delete'){
        if(sheet === 'Users'){
          const target = await selectById('Users', body.id);
          if(target && String(target.email).toLowerCase() === MASTER_EMAIL.toLowerCase()){
            return jsonOut(res, {ok:false, error:'The master admin account cannot be deleted.'});
          }
        }
        await deleteRow(sheet, body.id);
        return jsonOut(res, {ok:true});
      }
      return jsonOut(res, {ok:false, error:'Unknown action: ' + action});
    }

    res.status(405).json({ok:false, error:'Method not allowed'});
  } catch(err){
    res.status(200).send(JSON.stringify({ok:false, error:String(err && err.message || err)}));
  }
}
