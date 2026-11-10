const $ = (selector) => document.querySelector(selector);
const authPanel = $('#auth-panel');
const workspace = $('#workspace');
const authForm = $('#auth-form');
const authMessage = $('#auth-message');
const targetForm = $('#target-form');
const targetList = $('#target-list');
const startButton = $('#start-run');
const activityList = $('#activity-list');
const runList = $('#run-list');
const journalList = $('#journal-list');
const toast = $('#toast');

let currentUser = null;
let serverInfo = null;
let targets = [];
let selectedIds = new Set();
let editingId = null;
let runActive = false;
let refreshTimer = null;
let toastTimer = null;
let deferredInstallPrompt = null;
let loadingActivity = false;

/* ------------------------------- utilitaires ------------------------------ */

function setConnection(online) {
  const state = $('#connection-state');
  state.classList.toggle('online', Boolean(online));
  state.lastChild.textContent = online ? ' en ligne' : ' hors ligne';
}

function toastMessage(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function setFormMessage(element, message, kind = '') {
  element.textContent = message;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

function displayError(error, fallback = 'Une erreur est survenue.') {
  return error?.message || fallback;
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

/* --------------------------------- session -------------------------------- */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#auth-submit').textContent = mode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#signup-code-field').classList.toggle('hidden', mode === 'login' || !serverInfo?.signupCodeRequired);
  setFormMessage(authMessage, '');
}

function showAuth(message = '') {
  authPanel.classList.remove('hidden');
  workspace.classList.add('hidden');
  $('#logout-button').classList.add('hidden');
  if (message) setFormMessage(authMessage, message, 'error');
}

function showWorkspace() {
  authPanel.classList.add('hidden');
  workspace.classList.remove('hidden');
  $('#logout-button').classList.remove('hidden');
  $('#user-email').textContent = currentUser?.email || 'votre compte';
}

/** Toutes les requêtes passent par le cookie de session HttpOnly. */
async function apiRequest(path, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    setConnection(false);
    throw new Error('Connexion au VPS indisponible. Vérifiez votre accès Internet.');
  }
  setConnection(true);
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && retry && !path.startsWith('/api/auth/')) {
    clearSessionState();
    showAuth('Votre session a expiré. Reconnectez-vous.');
    throw new Error('Votre session a expiré. Reconnectez-vous.');
  }
  if (!response.ok) throw new Error(data.error || 'La requête a échoué.');
  return data;
}

function clearSessionState() {
  currentUser = null;
  targets = [];
  selectedIds.clear();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

async function verifySession() {
  try {
    const data = await apiRequest('/api/auth/me', {}, false);
    currentUser = data.user;
    return Boolean(currentUser?.id);
  } catch {
    return false;
  }
}

async function handleAuth(event) {
  event.preventDefault();
  const button = $('#auth-submit');
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const signupCode = $('#signup-code').value.trim();
  button.disabled = true;
  setFormMessage(authMessage, authMode === 'login' ? 'Connexion…' : 'Création du compte…');
  try {
    if (authMode === 'login') {
      const data = await apiRequest('/api/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }, false);
      currentUser = data.user;
    } else {
      const data = await apiRequest('/api/auth/register', {
        method: 'POST', body: JSON.stringify({ email, password, signupCode }),
      }, false);
      currentUser = data.user;
    }
    $('#auth-password').value = '';
    $('#signup-code').value = '';
    await enterWorkspace();
    setConnection(true);
  } catch (error) {
    setFormMessage(authMessage, displayError(error, 'Authentification impossible.'), 'error');
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  try { await apiRequest('/api/auth/logout', { method: 'POST' }, false); } catch { /* déjà déconnecté */ }
  clearSessionState();
  currentUser = null;
  showAuth('Vous êtes déconnecté.');
}

/* ---------------------------------- cibles -------------------------------- */

function describeTargetLocally(target) {
  if (target.mode === 'goal') return `Objectif : ${target.execution_target} clics en série continue.`;
  const parts = [`${target.duration_days} jour(s)`, `${target.effective_total} clics`];
  if (target.effective_total > target.execution_target) parts.push(`relevé (min. 100/jour)`);
  if (target.effective_total < target.execution_target) parts.push(`plafonné à 288/jour`);
  return `Intervalle : ${parts.join(' · ')}`;
}

function renderTargets() {
  targetList.replaceChildren();
  if (!targets.length) {
    targetList.append(node('div', 'empty-state', 'Aucune cible pour le moment. Ajoutez-en une ci-dessus.'));
    updateSelectionState();
    return;
  }
  targets.forEach((target) => {
    const item = node('article', 'target-item');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedIds.has(target.id);
    checkbox.setAttribute('aria-label', `Sélectionner ${target.pseudo}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(target.id);
      else selectedIds.delete(target.id);
      updateSelectionState();
    });
    const main = node('div', 'target-main');
    const title = node('div', 'target-title');
    title.append(node('strong', '', target.pseudo));
    title.append(node('span', '', target.mode === 'goal'
      ? `Objectif · ${target.execution_target} clics`
      : `${target.duration_days} j · ${target.effective_total} clics`));
    main.append(title);
    main.append(node('p', 'target-detail', target.url));
    const label = node('p', 'target-detail');
    label.append(node('b', '', target.link_label ? 'Lien/bouton : ' : 'Clic : '),
      document.createTextNode(target.link_label ? `« ${target.link_label} »` : 'élément principal automatique'));
    main.append(label, node('p', 'target-detail target-plan', target.description || describeTargetLocally(target)));

    const actions = node('div', 'target-actions');
    const edit = node('button', 'button button-quiet', 'Modifier');
    edit.type = 'button';
    edit.addEventListener('click', () => editTarget(target));
    const remove = node('button', 'button button-quiet', 'Supprimer');
    remove.type = 'button';
    remove.addEventListener('click', () => deleteTarget(target));
    actions.append(edit, remove);
    item.append(checkbox, main, actions);
    targetList.append(item);
  });
  updateSelectionState();
}

function updateSelectionState() {
  selectedIds = new Set([...selectedIds].filter((id) => targets.some((target) => target.id === id)));
  const count = selectedIds.size;
  startButton.disabled = count === 0 || runActive;
  startButton.textContent = runActive
    ? 'Une session est déjà en cours'
    : count ? `Lancer ${count} cible${count > 1 ? 's' : ''}` : 'Lancer les cibles sélectionnées';
  const selectAll = $('#select-all');
  selectAll.checked = Boolean(targets.length && count === targets.length);
  selectAll.indeterminate = count > 0 && count < targets.length;
  selectAll.disabled = targets.length === 0;
}

async function loadTargets() {
  const data = await apiRequest('/api/targets');
  targets = Array.isArray(data.targets) ? data.targets : [];
  renderTargets();
}

function editTarget(target) {
  editingId = target.id;
  $('#target-pseudo').value = target.pseudo;
  $('#target-url').value = target.url;
  $('#target-label').value = target.link_label || '';
  $('#target-mode').value = target.mode;
  $('#target-count').value = target.execution_target;
  $('#target-duration').value = target.duration_days;
  $('#target-form-title').textContent = `Modifier · ${target.pseudo}`;
  $('#save-target').textContent = 'Enregistrer les changements';
  $('#cancel-edit').classList.remove('hidden');
  syncModeFields();
  updatePlanPreview();
  $('#target-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetTargetForm() {
  editingId = null;
  targetForm.reset();
  $('#target-count').value = '300';
  $('#target-duration').value = '7';
  $('#target-form-title').textContent = 'Nouvelle cible';
  $('#save-target').textContent = 'Enregistrer la cible';
  $('#cancel-edit').classList.add('hidden');
  syncModeFields();
  updatePlanPreview();
}

function syncModeFields() {
  const interval = $('#target-mode').value === 'interval';
  $('#duration-field').classList.toggle('hidden', !interval);
  $('#target-duration').required = interval;
}

/** Aperçu local du total réel : mêmes règles que le serveur (100 min, 288 max). */
function updatePlanPreview() {
  const preview = $('#plan-preview');
  const mode = $('#target-mode').value;
  const requested = Number($('#target-count').value);
  const days = Math.max(1, Math.min(365, Number($('#target-duration').value) || 1));
  if (!Number.isFinite(requested) || requested < 1) {
    preview.textContent = 'Indiquez un nombre de clics.';
    return;
  }
  if (mode === 'goal') {
    preview.textContent = `Objectif : ${requested} clics en série continue, sans durée.`;
    return;
  }
  const minimum = 100 * days;
  const maximum = 288 * days;
  const total = Math.min(Math.max(requested, minimum), maximum);
  const notes = [];
  if (total > requested) notes.push(`relevé à ${total} pour tenir 100 clics/jour`);
  if (requested > maximum) notes.push(`ramené à ${total} : 288 clics/jour maximum`);
  preview.textContent = `Sur ${days} jour${days > 1 ? 's' : ''} : ${total} clics au total, soit environ ${Math.round(total / days)} par jour.${notes.length ? ` (${notes.join('; ')})` : ''}`;
}

async function deleteTarget(target) {
  if (!window.confirm(`Supprimer la cible « ${target.pseudo} » ? Les visites associées seront aussi supprimées.`)) return;
  try {
    await apiRequest(`/api/targets?id=${encodeURIComponent(target.id)}`, { method: 'DELETE' });
    selectedIds.delete(target.id);
    if (editingId === target.id) resetTargetForm();
    await loadTargets();
    toastMessage('Cible supprimée.');
  } catch (error) { toastMessage(displayError(error), true); }
}

async function saveTarget(event) {
  event.preventDefault();
  const payload = {
    pseudo: $('#target-pseudo').value.trim(),
    url: $('#target-url').value.trim(),
    linkLabel: $('#target-label').value.trim(),
    mode: $('#target-mode').value,
    executionTarget: Number($('#target-count').value),
    durationDays: Number($('#target-duration').value) || 1,
  };
  const button = $('#save-target');
  const wasEditing = Boolean(editingId);
  button.disabled = true;
  button.textContent = 'Enregistrement…';
  try {
    await apiRequest('/api/targets', {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(editingId ? { ...payload, id: editingId } : payload),
    });
    resetTargetForm();
    await loadTargets();
    toastMessage(wasEditing ? 'Cible mise à jour.' : 'Cible enregistrée.');
  } catch (error) {
    toastMessage(displayError(error), true);
  } finally {
    button.disabled = false;
    button.textContent = editingId ? 'Enregistrer les changements' : 'Enregistrer la cible';
  }
}

/* -------------------------------- activité -------------------------------- */

function statusLabel(status) {
  return ({
    scheduled: 'Planifiée', running: 'En cours', completed: 'Terminée', stopped: 'Arrêtée', failed: 'Échec',
    pending: 'En attente', success: 'Réussi', approval_required: 'Confirmation requise', cancelled: 'Annulé',
  })[status] || status || 'Inconnu';
}

function badgeClass(status) {
  if (['success', 'completed'].includes(status)) return 'status-badge status-success';
  if (['approval_required', 'scheduled', 'running', 'pending'].includes(status)) return 'status-badge status-warning';
  if (['failed'].includes(status)) return 'status-badge status-error';
  return 'status-badge status-neutral';
}

function renderRuns(runs) {
  runList.replaceChildren();
  const activeRuns = runs.filter((run) => ['scheduled', 'running'].includes(run.status));
  runActive = activeRuns.length > 0;
  if (!activeRuns.length) {
    updateSelectionState();
    return;
  }
  activeRuns.forEach((run) => {
    const item = node('div', 'run-card');
    const main = node('div', 'run-card-main');
    main.append(node('strong', '', `Session ${run.id.slice(0, 8)} · ${statusLabel(run.status)}`));
    main.append(node('small', '', `Créée ${formatDate(run.created_at)}${run.confirm_clicks ? ' · confirmation demandée' : ''}`));
    const stop = node('button', 'button button-quiet button-small', 'Arrêter');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      if (!window.confirm('Arrêter la session et annuler les visites en attente ?')) return;
      stop.disabled = true;
      try {
        const data = await apiRequest('/api/stop', { method: 'POST', body: JSON.stringify({ runId: run.id }) });
        toastMessage(data.message || 'Visites annulées.');
        await loadActivity();
      } catch (error) {
        toastMessage(displayError(error), true);
        stop.disabled = false;
      }
    });
    item.append(main, stop);
    runList.append(item);
  });
  updateSelectionState();
}

function renderJournal(clicksByTarget, todayTotal) {
  const badge = $('#today-total');
  badge.textContent = `${todayTotal} clic${todayTotal > 1 ? 's' : ''}`;
  badge.className = todayTotal >= 100 ? 'status-badge status-success' : 'status-badge status-neutral';
  journalList.replaceChildren();
  const withHistory = (clicksByTarget || []).filter((item) => item.today > 0 || item.history.some((day) => day.clicks > 0));
  if (!withHistory.length) {
    journalList.append(node('div', 'empty-state', 'Aucun clic enregistré aujourd’hui.'));
    return;
  }
  withHistory.forEach((item) => {
    const row = node('div', 'journal-row');
    const head = node('div', 'journal-head');
    head.append(node('strong', '', item.pseudo), node('span', 'journal-count', `${item.today} / 100 aujourd’hui`));
    const bars = node('div', 'journal-bars');
    const history = [...item.history].reverse().slice(-14);
    const max = Math.max(100, ...history.map((day) => day.clicks));
    history.forEach((day) => {
      const bar = node('span', 'journal-bar', '');
      bar.style.height = `${Math.max(3, Math.round((day.clicks / max) * 34))}px`;
      bar.title = `${day.day} : ${day.clicks} clic(s)`;
      bar.dataset.met = String(day.clicks >= 100);
      bars.append(bar);
    });
    row.append(head, bars);
    journalList.append(row);
  });
}

function renderActivity(visits) {
  activityList.replaceChildren();
  if (!visits.length) {
    activityList.append(node('div', 'empty-state', 'Aucun cycle lancé.'));
    return;
  }
  const sorted = [...visits].sort((a, b) => {
    const aTime = new Date(a.completed_at || a.started_at || a.scheduled_at).valueOf();
    const bTime = new Date(b.completed_at || b.started_at || b.scheduled_at).valueOf();
    return bTime - aTime;
  }).slice(0, 40);
  sorted.forEach((visit) => {
    const item = node('div', 'activity-item');
    item.append(node('span', `activity-dot ${visit.status}`, ''));
    const body = node('div', 'activity-body');
    body.append(node('strong', '', `${visit.pseudo} · visite ${visit.visit_number} · ${statusLabel(visit.status)}`));
    const message = visit.result?.message || (visit.status === 'pending'
      ? `Prévue ${formatDate(visit.scheduled_at)}`
      : visit.status === 'success'
        ? `Clic ${visit.result?.click_kind || 'effectué'}${visit.result?.click_label ? ` « ${visit.result.click_label} »` : ''}${visit.result?.title ? ` · ${visit.result.title}` : ''}`
        : visit.status === 'running' ? 'Le navigateur du VPS exécute le cycle.' : '');
    if (message) body.append(node('p', '', message));
    const finalUrl = safeHttpUrl(visit.result?.final_url);
    if (finalUrl) {
      const link = node('a', 'result-link', finalUrl.length > 66 ? `${finalUrl.slice(0, 63)}…` : finalUrl);
      link.href = finalUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      body.append(link);
    }
    const meta = node('span', 'activity-meta', formatDate(visit.completed_at || visit.started_at || visit.scheduled_at));
    const actions = node('div', 'activity-actions');
    if (visit.status === 'approval_required') {
      const approve = node('button', 'button button-primary', 'Confirmer & cliquer');
      approve.type = 'button';
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        approve.textContent = 'En cours…';
        try {
          await apiRequest('/api/approve', { method: 'POST', body: JSON.stringify({ visitId: visit.id }) });
          toastMessage('Confirmation enregistrée, le clic part dans quelques secondes.');
          await loadActivity();
        } catch (error) {
          toastMessage(displayError(error), true);
          approve.disabled = false;
          approve.textContent = 'Confirmer & cliquer';
        }
      });
      actions.append(approve);
    }
    item.append(body, meta, actions);
    activityList.append(item);
  });
}

async function loadActivity() {
  if (loadingActivity || workspace.classList.contains('hidden')) return;
  loadingActivity = true;
  try {
    const data = await apiRequest('/api/visits');
    renderRuns(Array.isArray(data.runs) ? data.runs : []);
    renderJournal(Array.isArray(data.clicksByTarget) ? data.clicksByTarget : [], Number(data.todayTotal || 0));
    renderActivity(Array.isArray(data.visits) ? data.visits : []);
  } catch (error) {
    if (!/expiré|Connectez-vous/.test(error.message || '')) toastMessage(displayError(error), true);
  } finally { loadingActivity = false; }
}

async function startRun() {
  const targetIds = [...selectedIds].filter((id) => targets.some((target) => target.id === id));
  if (!targetIds.length) return;
  const oldText = startButton.textContent;
  startButton.disabled = true;
  startButton.innerHTML = '<span class="spinner" aria-hidden="true"></span> Programmation…';
  try {
    const data = await apiRequest('/api/start', {
      method: 'POST',
      body: JSON.stringify({ targetIds, confirmClicks: $('#confirm-clicks').checked }),
    });
    const notice = $('#notice');
    const detail = data.targets.map((item) => `${item.pseudo} : ${item.visits} visite(s)`).join(' · ');
    notice.textContent = `Session créée : ${data.plannedVisits} visite(s) planifiée(s). ${detail}. Le bot commence dans environ une minute.`;
    notice.classList.remove('hidden', 'error');
    selectedIds.clear();
    renderTargets();
    await loadActivity();
    toastMessage('Session lancée sur le VPS.');
  } catch (error) {
    toastMessage(displayError(error, 'Le lancement a échoué.'), true);
  } finally {
    startButton.innerHTML = '';
    startButton.textContent = oldText;
    updateSelectionState();
  }
}

/* ---------------------------------- proxys -------------------------------- */

const proxyList = $('#proxy-list');
let proxyRecords = [];
let proxyState = null;
let proxyTesting = false;

function formatRelative(value) {
  if (!value) return 'jamais utilisé';
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff) || diff < 0) return formatDate(value);
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'à l’instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

function proxyPercent(proxy) {
  if (!proxy.cycles) return null;
  return Math.round((proxy.successes / proxy.cycles) * 100);
}

function renderProxies() {
  const badge = $('#proxy-badge');
  const enabledCount = proxyRecords.filter((proxy) => proxy.enabled).length;
  if (!proxyRecords.length) {
    badge.textContent = 'Aucun proxy';
    badge.className = 'status-badge status-neutral';
  } else if (!proxyState?.enabled) {
    badge.textContent = `${proxyRecords.length} importé(s) · rotation arrêtée`;
    badge.className = 'status-badge status-warning';
  } else if (!enabledCount) {
    badge.textContent = 'Tous désactivés';
    badge.className = 'status-badge status-error';
  } else {
    badge.textContent = `${enabledCount} actif(s) sur ${proxyRecords.length}`;
    badge.className = 'status-badge status-success';
  }

  const cycles = proxyRecords.reduce((sum, proxy) => sum + proxy.cycles, 0);
  const order = proxyState?.rotation === 'random' ? 'au hasard' : 'dans l’ordre';
  $('#proxy-summary').textContent = proxyRecords.length
    ? `${proxyRecords.length} proxy(s) · ${cycles} cycle(s) effectué(s) · rotation ${order}${proxyState?.rotation === 'order' && proxyRecords.length ? ` · prochain : n°${(Number(proxyState.cursor || 0) % proxyRecords.length) + 1}` : ''}`
    : 'Aucun proxy importé. Le bot sortira par l’IP du VPS.';
  $('#proxy-enabled').checked = Boolean(proxyState?.enabled);
  $('#proxy-rotation').value = proxyState?.rotation === 'random' ? 'random' : 'order';
  $('#remove-proxy').classList.toggle('hidden', !proxyRecords.some((proxy) => !proxy.enabled));

  proxyList.replaceChildren();
  if (!proxyRecords.length) {
    proxyList.append(node('div', 'empty-state', 'Collez votre liste ci-dessus pour ajouter vos proxys.'));
    return;
  }
  proxyRecords.forEach((proxy) => {
    const row = node('div', 'proxy-row');
    if (!proxy.enabled) row.classList.add('is-off');

    const main = node('div', 'proxy-main');
    const title = node('div', 'proxy-row-head');
    title.append(node('strong', '', `${proxy.host}:${proxy.port}`));
    const dot = node('span', `proxy-dot${proxy.last_error ? ' is-bad' : proxy.cycles ? ' is-good' : ''}`, '');
    title.append(dot);
    const tags = node('div', 'proxy-tags');
    tags.append(node('span', 'proxy-tag', proxy.scheme.toUpperCase()));
    if (proxy.username) tags.append(node('span', 'proxy-tag', proxy.username));
    if (!proxy.enabled) tags.append(node('span', 'proxy-tag is-off', 'désactivé'));
    else if (proxy.consecutive_failures) tags.append(node('span', 'proxy-tag is-warn', `${proxy.consecutive_failures} échec(s) de suite`));
    const rate = proxyPercent(proxy);
    if (rate !== null) tags.append(node('span', 'proxy-tag', `${rate}% de réussite · ${proxy.cycles} cycle(s)`));
    tags.append(node('span', 'proxy-tag is-muted', formatRelative(proxy.last_used_at)));
    main.append(title, tags);
    if (proxy.last_error) main.append(node('p', 'proxy-error', `Dernière erreur : ${proxy.last_error}`));

    const actions = node('div', 'proxy-actions');
    actions.append(
      buildToggle(proxy),
      buildTestButton(proxy),
      buildDeleteButton(proxy),
    );
    row.append(main, actions);
    proxyList.append(row);
  });
}

function buildToggle(proxy) {
  const label = node('label', 'check-row proxy-toggle');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = proxy.enabled;
  input.addEventListener('change', async () => {
    input.disabled = true;
    try {
      await apiRequest('/api/proxies', { method: 'PATCH', body: JSON.stringify({ id: proxy.id, enabled: input.checked }) });
      await loadProxyStatus();
    } catch (error) {
      setFormMessage($('#proxy-message'), displayError(error), 'error');
      input.checked = !input.checked;
    } finally { input.disabled = false; }
  });
  label.append(input, node('span', '', 'Actif'));
  return label;
}

function buildTestButton(proxy) {
  const button = node('button', 'button button-quiet proxy-action', 'Tester');
  button.type = 'button';
  button.disabled = proxyTesting;
  button.addEventListener('click', () => testProxies([proxy.id], button));
  return button;
}

function buildDeleteButton(proxy) {
  const button = node('button', 'button button-quiet proxy-action', 'Supprimer');
  button.type = 'button';
  button.addEventListener('click', async () => {
    if (!window.confirm(`Supprimer ${proxy.host}:${proxy.port} de la liste ?`)) return;
    button.disabled = true;
    try {
      await apiRequest(`/api/proxies?id=${encodeURIComponent(proxy.id)}`, { method: 'DELETE' });
      setFormMessage($('#proxy-message'), 'Proxy supprimé.', 'success');
      await loadProxyStatus();
    } catch (error) { setFormMessage($('#proxy-message'), displayError(error), 'error'); }
    finally { button.disabled = false; }
  });
  return button;
}

async function loadProxyStatus() {
  try {
    const data = await apiRequest('/api/proxies');
    proxyRecords = data.proxies || [];
    proxyState = data.state || null;
    renderProxies();
  } catch (error) {
    setFormMessage($('#proxy-message'), displayError(error), 'error');
  }
}

/* ------------------------------ import fichier ----------------------------- */

const MAX_PROXY_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Décode un fichier de proxys. Les exports Webshare sont en UTF-8, mais un
 * fichier récupéré sur Windows peut être en UTF-16 ou porter un BOM : sans ça,
 * la première ligne contiendrait des caractères invisibles et serait rejetée.
 */
async function decodeProxyFile(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  if (!buffer.length) throw new Error('Le fichier est vide.');
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    // Fichier dans un autre encodage : le latin-1 ne perd jamais d'octet.
    return new TextDecoder('latin1').decode(buffer);
  }
}

async function readProxyFile(file) {
  if (!file) return;
  if (file.size > MAX_PROXY_FILE_BYTES) {
    setFileMessage(`Fichier trop volumineux (${Math.round(file.size / 1024)} Ko). Limite : 2 Mo.`, true);
    return;
  }
  try {
    const content = await decodeProxyFile(file);
    // Fins de ligne Windows, tabs, espaces insécables : on normalise avant import.
    const cleaned = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
    if (!cleaned) { setFileMessage('Le fichier ne contient aucune ligne exploitable.', true); return; }
    $('#proxy-text').value = cleaned;
    const lines = cleaned.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#')).length;
    setFileMessage(`${file.name} — ${lines} ligne(s) prête(s). Vérifie, puis clique sur « Importer la liste ».`);
    setFormMessage($('#proxy-message'), '');
    $('#proxy-file-clear').classList.remove('hidden');
    $('#proxy-text').scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  } catch (error) {
    setFileMessage(displayError(error, 'Lecture du fichier impossible.'), true);
  }
}

function setFileMessage(message, isError = false) {
  const target = $('#proxy-file-name');
  target.textContent = message;
  target.classList.toggle('hidden', !message);
  target.classList.toggle('is-error', Boolean(isError));
}

function clearProxyFile() {
  $('#proxy-file').value = '';
  $('#proxy-text').value = '';
  $('#proxy-file-clear').classList.add('hidden');
  setFileMessage('');
  $('#proxy-text').focus();
}

async function saveProxy(event) {
  event.preventDefault();
  const button = $('#save-proxy');
  const text = $('#proxy-text').value.trim();
  if (!text) {
    setFormMessage($('#proxy-message'), 'Collez au moins une ligne de proxy.', 'error');
    return;
  }
  button.disabled = true;
  setFormMessage($('#proxy-message'), 'Import en cours…');
  try {
    const data = await apiRequest('/api/proxies', {
      method: 'POST',
      body: JSON.stringify({
        text,
        defaultScheme: $('#proxy-scheme').value,
        defaultUsername: $('#proxy-username').value,
        defaultPassword: $('#proxy-password').value,
      }),
    });
    // Les champs sensibles sont effacés dès que le serveur les a chiffrés.
    $('#proxy-text').value = '';
    $('#proxy-username').value = '';
    $('#proxy-password').value = '';
    $('#proxy-file').value = '';
    $('#proxy-file-clear').classList.add('hidden');
    setFileMessage('');
    const details = Array.isArray(data.errors) && data.errors.length
      ? ` Premières lignes rejetées : ${data.errors.slice(0, 3).map((error) => `ligne ${error.line || '?'} (${error.message})`).join(' ; ')}.`
      : '';
    // Un import partiel est signalé comme tel, même si une partie est passée.
    const kind = data.rejected ? 'error' : 'success';
    setFormMessage($('#proxy-message'), `${data.message}${details}`, kind);
    await loadProxyStatus();
  } catch (error) {
    setFormMessage($('#proxy-message'), displayError(error), 'error');
  } finally { button.disabled = false; }
}

async function testProxies(ids, button) {
  const target = button || $('#test-proxies');
  proxyTesting = true;
  const oldText = target.textContent;
  target.disabled = true;
  target.textContent = 'Test en cours…';
  setFormMessage($('#proxy-message'), 'Test des proxys : un aller-retour par proxy, cela peut prendre quelques secondes.');
  document.querySelectorAll('.proxy-action').forEach((item) => { item.disabled = true; });
  try {
    const data = await apiRequest('/api/proxies/test', {
      method: 'POST',
      body: JSON.stringify(ids && ids.length ? { ids } : {}),
    });
    const results = data.results || [];
    const ok = results.filter((item) => item.ok).length;
    const failures = results.filter((item) => !item.ok).slice(0, 3)
      .map((item) => `${item.host}:${item.port} (${item.message})`).join(' ; ');
    setFormMessage(
      $('#proxy-message'),
      `${ok} proxy(s) sur ${results.length} répondent.${failures ? ` Échecs : ${failures}.` : ''}`,
      ok === results.length ? 'success' : 'error',
    );
    await loadProxyStatus();
  } catch (error) {
    setFormMessage($('#proxy-message'), displayError(error), 'error');
  } finally {
    proxyTesting = false;
    target.textContent = oldText;
    target.disabled = false;
    document.querySelectorAll('.proxy-action').forEach((item) => { item.disabled = false; });
  }
}

async function saveProxyState() {
  try {
    const data = await apiRequest('/api/proxies', {
      method: 'PATCH',
      body: JSON.stringify({ state: { enabled: $('#proxy-enabled').checked, rotation: $('#proxy-rotation').value } }),
    });
    proxyState = data.state;
    renderProxies();
    setFormMessage($('#proxy-message'), 'Réglages de rotation enregistrés.', 'success');
  } catch (error) {
    setFormMessage($('#proxy-message'), displayError(error), 'error');
  }
}

async function removeProxy() {
  if (!window.confirm('Supprimer définitivement les proxys désactivés ?')) return;
  const button = $('#remove-proxy');
  button.disabled = true;
  try {
    const data = await apiRequest('/api/proxies?id=disabled', { method: 'DELETE' });
    setFormMessage($('#proxy-message'), data.message || 'Proxys supprimés.', 'success');
    await loadProxyStatus();
  } catch (error) { setFormMessage($('#proxy-message'), displayError(error), 'error'); }
  finally { button.disabled = false; }
}

function showNotice(message, isError = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.classList.remove('hidden');
}

async function enterWorkspace() {
  showWorkspace();
  await Promise.all([loadTargets(), loadProxyStatus(), loadActivity()]);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') loadActivity();
  }, 15000);
}

/* ---------------------------------- boot ---------------------------------- */

async function boot() {
  setConnection(navigator.onLine);
  window.addEventListener('online', () => setConnection(true));
  window.addEventListener('offline', () => setConnection(false));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  authForm.addEventListener('submit', handleAuth);
  targetForm.addEventListener('submit', saveTarget);
  $('#cancel-edit').addEventListener('click', resetTargetForm);
  $('#target-mode').addEventListener('change', () => { syncModeFields(); updatePlanPreview(); });
  $('#target-count').addEventListener('input', updatePlanPreview);
  $('#target-duration').addEventListener('input', updatePlanPreview);
  $('#select-all').addEventListener('change', (event) => {
    selectedIds = event.target.checked ? new Set(targets.map((target) => target.id)) : new Set();
    renderTargets();
  });
  startButton.addEventListener('click', startRun);
  $('#proxy-form').addEventListener('submit', saveProxy);
  $('#remove-proxy').addEventListener('click', removeProxy);
  $('#test-proxies').addEventListener('click', () => testProxies(null, $('#test-proxies')));
  $('#proxy-enabled').addEventListener('change', saveProxyState);
  $('#proxy-rotation').addEventListener('change', saveProxyState);

  // Import depuis un fichier texte : bouton, sélection, ou glisser-déposer.
  const fileInput = $('#proxy-file');
  const dropZone = $('#proxy-drop');
  $('#proxy-file-button').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) readProxyFile(fileInput.files[0]);
  });
  $('#proxy-file-clear').addEventListener('click', clearProxyFile);
  ['dragenter', 'dragover'].forEach((type) => dropZone.addEventListener(type, (event) => {
    event.preventDefault();
    dropZone.classList.add('is-over');
  }));
  ['dragleave', 'dragend'].forEach((type) => dropZone.addEventListener(type, () => dropZone.classList.remove('is-over')));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) readProxyFile(file);
  });
  $('#refresh-activity').addEventListener('click', loadActivity);
  $('#logout-button').addEventListener('click', logout);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#install-button').classList.remove('hidden');
  });
  $('#install-button').addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $('#install-button').classList.add('hidden');
  });

  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    serverInfo = response.ok ? await response.json() : null;
  } catch { serverInfo = null; }
  if (!serverInfo?.ok) {
    showAuth('Le serveur du VPS ne répond pas. Vérifiez qu’il est démarré.');
    return;
  }
  setAuthMode(serverInfo.firstRun ? 'signup' : 'login');
  if (serverInfo.firstRun) {
    setFormMessage(authMessage, 'Premier démarrage : créez le compte propriétaire de ce serveur.', 'success');
  }
  if (await verifySession()) {
    await enterWorkspace();
    setConnection(true);
  } else {
    showAuth();
  }
}

boot().catch((error) => showNotice(displayError(error), true));
