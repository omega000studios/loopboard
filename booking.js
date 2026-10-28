'use strict';

const form = document.getElementById('pf');
const dateInput = document.getElementById('dt');
const submitButton = document.getElementById('submit-pickup');
const submitError = document.getElementById('submit-error');
const successPanel = document.getElementById('pickup-success');
const fields = { name: 'nm', phone: 'ph', address: 'ad', item_type: 'it', preferred_date: 'dt', notes: 'nt' };
let lastPayload = '';
let requestId = '';

function updateDateMin() {
  dateInput.min = new Date(Date.now() + 19_800_000 + 86_400_000).toISOString().slice(0, 10);
}

function showErrors(errors) {
  Object.entries(fields).forEach(([key, id]) => {
    document.getElementById('e-' + id).textContent = errors[key] || '';
    document.getElementById(id).setAttribute('aria-invalid', String(Boolean(errors[key])));
  });
  const first = Object.keys(fields).find(key => errors[key]);
  if (first) document.getElementById(fields[first]).focus();
}

updateDateMin();
form.onsubmit = async event => {
  event.preventDefault();
  if (submitButton.disabled) return;
  submitError.textContent = '';
  updateDateMin();
  document.getElementById('ph').value = document.getElementById('ph').value.replace(/[\s-]/g, '');
  const payload = {};
  const errors = {};
  Object.entries(fields).forEach(([key, id]) => {
    const input = document.getElementById(id);
    input.value = input.value.trim();
    payload[key] = input.value;
    if (!input.checkValidity()) errors[key] = input.validationMessage;
  });
  showErrors(errors);
  if (Object.keys(errors).length) return;
  const config = window.LOOPBOARD || {};
  if (!config.supabaseUrl || !config.publishableKey) {
    submitError.textContent = 'Online pickup requests are not connected yet. Please try again later.';
    return;
  }
  const fingerprint = JSON.stringify(payload);
  if (fingerprint !== lastPayload) {
    requestId = crypto.randomUUID();
    lastPayload = fingerprint;
  }
  payload.request_id = requestId;
  payload.website = document.getElementById('website').value;
  submitButton.disabled = true;
  submitButton.textContent = 'Sending request…';
  form.setAttribute('aria-busy', 'true');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(config.supabaseUrl.replace(/\/$/, '') + '/functions/v1/create-pickup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.publishableKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.errors) showErrors(result.errors);
      throw new Error(result.error || 'We could not confirm your request. Please retry.');
    }
    if (!/^LB-[A-F0-9]{12}$/.test(result.reference) || result.preferred_date !== payload.preferred_date || result.status !== 'requested') {
      throw new Error('We could not confirm your request. Please retry using the same form.');
    }
    document.getElementById('pickup-name').textContent = payload.name;
    document.getElementById('pickup-date').textContent = new Date(result.preferred_date + 'T00:00:00+05:30').toLocaleDateString('en-IN', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
    });
    document.getElementById('pickup-reference').textContent = result.reference;
    form.hidden = true;
    successPanel.hidden = false;
    successPanel.focus();
  } catch (error) {
    submitError.textContent = error.name === 'AbortError' || error instanceof TypeError || error instanceof SyntaxError
      ? 'We could not confirm your request. Your details are still here; retry to check without creating a duplicate.'
      : error.message;
  } finally {
    clearTimeout(timeout);
    submitButton.disabled = false;
    submitButton.textContent = 'Request pickup';
    form.removeAttribute('aria-busy');
  }
};

document.getElementById('again').onclick = () => {
  form.reset();
  lastPayload = '';
  requestId = '';
  showErrors({});
  submitError.textContent = '';
  updateDateMin();
  successPanel.hidden = true;
  form.hidden = false;
  document.getElementById('nm').focus();
};
