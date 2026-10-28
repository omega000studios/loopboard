const itemTypes = ['Mixed e-waste', 'Phones and tablets', 'Computers', 'Home appliances', 'Batteries and chargers'];
const maxBytes = 8192;

export async function handleRequest(request, env, fetchDatabase = fetch) {
  const origin = request.headers.get('origin');
  const origins = (env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim());
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  const reply = (status, body, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

  if (!origin || !origins.includes(origin)) return reply(403, { error: 'This website is not allowed to submit requests.' });
  headers['Access-Control-Allow-Origin'] = origin;
  headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'apikey, content-type';
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return reply(405, { error: 'Use POST to submit a pickup request.' }, { Allow: 'POST, OPTIONS' });

  try {
    const publicKeys = Object.values(JSON.parse(env.SUPABASE_PUBLISHABLE_KEYS || '{}'));
    const secret = JSON.parse(env.SUPABASE_SECRET_KEYS || '{}').default;
    if (!env.SUPABASE_URL || !secret || publicKeys.length === 0) return reply(503, { error: 'Pickup requests are temporarily unavailable.' });
    if (!publicKeys.includes(request.headers.get('apikey'))) return reply(401, { error: 'The website connection is not configured correctly.' });
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return reply(415, { error: 'Send a JSON request.' });
    if (Number(request.headers.get('content-length')) > maxBytes) return reply(413, { error: 'The request is too large.' });

    const reader = request.body?.getReader();
    if (!reader) return reply(400, { error: 'The request body is missing.' });
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        return reply(413, { error: 'The request is too large.' });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return reply(400, { error: 'The request contains invalid JSON.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'Send a pickup request object.' });
    if (body.website) return reply(400, { error: 'Unable to submit this request.' });

    const text = key => typeof body[key] === 'string' ? body[key].trim() : '';
    const name = text('name');
    const phone = text('phone').replace(/[\s-]/g, '');
    const address = text('address');
    const itemType = text('item_type');
    const date = text('preferred_date');
    const notes = text('notes');
    const tomorrow = new Date(Date.now() + 19_800_000 + 86_400_000).toISOString().slice(0, 10);
    const errors = {};
    if (name.length < 2 || name.length > 100) errors.name = 'Enter a name between 2 and 100 characters.';
    if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = 'Enter a valid 10-digit Indian mobile number.';
    if (address.length < 8 || address.length > 1000) errors.address = 'Enter an address between 8 and 1,000 characters.';
    if (!itemTypes.includes(itemType)) errors.item_type = 'Choose one of the listed item types.';
    const parsedDate = new Date(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || date < tomorrow) errors.preferred_date = 'Choose a valid date from tomorrow onwards (India time).';
    if ((body.notes !== undefined && typeof body.notes !== 'string') || notes.length > 1000) errors.notes = 'Keep notes to 1,000 characters.';
    if (Object.keys(errors).length) return reply(422, { error: 'Please check the highlighted fields.', errors });
    if (typeof body.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) return reply(400, { error: 'The request identifier is invalid. Refresh the page and try again.' });

    // Supabase's proxy supplies this header; raw addresses are never stored.
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
    const hashKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', hashKey, new TextEncoder().encode(ip));
    const ipHash = Array.from(new Uint8Array(signature), value => value.toString(16).padStart(2, '0')).join('');
    const saved = await fetchDatabase(env.SUPABASE_URL + '/rest/v1/rpc/create_pickup', {
      method: 'POST',
      headers: { apikey: secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_request_id: body.request_id, p_name: name, p_phone: phone, p_address: address, p_item_type: itemType, p_preferred_date: date, p_notes: notes, p_ip_hash: ipHash }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!saved.ok) {
      const failure = await saved.json().catch(() => ({}));
      if (failure.code === 'PT429') return reply(429, { error: 'Too many requests. Please wait an hour before trying again.' }, { 'Retry-After': '3600' });
      if (failure.code === '22023') return reply(409, { error: 'This request has changed. Refresh the page before submitting again.' });
      return reply(503, { error: 'We could not confirm your request. Your details are still in the form; please retry.' });
    }
    const result = await saved.json();
    if (typeof result.reference !== 'string' || !/^LB-[A-F0-9]{12}$/.test(result.reference) || result.preferred_date !== date) return reply(503, { error: 'We could not confirm your request. Please retry using the same form.' });
    return reply(200, { reference: result.reference, preferred_date: result.preferred_date, status: 'requested' });
  } catch {
    // Keep contact details, credentials and database errors out of responses and logs.
    return reply(503, { error: 'We could not confirm your request. Your details are still in the form; please retry.' });
  }
}
