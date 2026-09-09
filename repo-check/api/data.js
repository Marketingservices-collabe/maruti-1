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
async function nextTicketNo(){
  const result = await rest('rpc/next_ticket_no', {method: 'POST', body: '{}'});
  return result;
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

function jsonOut(res, obj){
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(obj));
}

export default async function handler(req, res){
  try{
    if(req.method === 'GET'){
      const {action, sheet, id, billingId, serviceId, jobTicketId, q, token} = req.query;

      const runQuery = async () => {
        if(action === 'list'){
          let rows = await selectAll(sheet);
          if(billingId) rows = rows.filter(r => String(r.billingId) === String(billingId));
          if(serviceId) rows = rows.filter(r => String(r.serviceId) === String(serviceId));
          if(jobTicketId) rows = rows.filter(r => String(r.jobTicketId) === String(jobTicketId));
          return {ok:true, rows};
        }
        if(action === 'get'){
          const row = await selectById(sheet, id);
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
        const row = await insertRow(sheet, data);
        return jsonOut(res, {ok:true, id: row.id, ticketNo: row.ticketNo});
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
