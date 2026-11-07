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
const toast = $('#toast');
const SESSION_KEY = 'instava.mobile.session.v1';

let config = null;
let authMode = 'login';
let session = readSession();
let currentUser = null;
let targets = [];
let selectedIds = new Set();
let editingId = null;
let proxyConfigured = false;
let runActive = false;
let refreshTimer = null;
let toastTimer = null;
let deferredInstallPrompt = null;
let loadingActivity = false;

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch { return null; }
}

function saveSession(data) {
  session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
    email: data.user?.email || session?.email || '',
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  session = null;
  currentUser = null;
  localStorage.removeItem(SESSION_KEY);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

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
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setFormMessage(element, message, kind = '') {
  element.textContent = message;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

function displayError(error, fallback = 'Une erreur est survenue.') {
  return error?.message || fallback;
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach((button) => {
    const active = button.dataset.authMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('#auth-submit').textContent = mode === 'login' ? 'Se connecter' : 'Créer mon compte';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
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
  $('#user-email').textContent = currentUser?.email || session?.email || 'votre compte';
}

async function authRequest(path, payload) {
  if (!config) throw new Error('Le service cloud n’est pas configuré.');
  const response = await fetch(`${config.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.msg || data.message || data.error_description || data.error || 'Authentification impossible.');
  return data;
}

async function refreshSession(force = false) {
  if (!session?.refreshToken) throw new Error('Votre session a expiré. Reconnectez-vous.');
  if (!force && session.expiresAt && session.expiresAt > Date.now() + 60000) return session.accessToken;
  const previousEmail = session.email;
  const data = await authRequest('token?grant_type=refresh_token', { refresh_token: session.refreshToken });
  if (!data.access_token) throw new Error('Impossible de renouveler votre session.');
  saveSession(data);
  if (!session.email) session.email = previousEmail;
  return session.accessToken;
}

async function apiRequest(path, options = {}, retry = true) {
  if (!session?.accessToken) throw new Error('Connectez-vous pour continuer.');
  if (!session.expiresAt || session.expiresAt <= Date.now() + 60000) await refreshSession();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${session.accessToken}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response;
  try {
    response = await fetch(path, { ...options, headers, cache: 'no-store' });
  } catch {
    setConnection(false);
    throw new Error('Connexion réseau indisponible. Vérifiez votre accès Internet.');
  }
  setConnection(true);
  if (response.status === 401 && retry && session?.refreshToken) {
    try {
      await refreshSession(true);
      return apiRequest(path, options, false);
    } catch {
      clearSession();
      showAuth('Votre session a expiré. Reconnectez-vous.');
      throw new Error('Votre session a expiré. Reconnectez-vous.');
    }
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      showAuth('Votre session a expiré. Reconnectez-vous.');
    }
    throw new Error(data.error || 'La requête a échoué.');
  }
  return data;
}

async function verifySession() {
  if (!session?.accessToken || !config) return false;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!session.expiresAt || session.expiresAt <= Date.now() + 60000) await refreshSession(attempt > 0);
      const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
        headers: { apikey: config.supabaseAnonKey, Authorization: `Bearer ${session.accessToken}` },
        cache: 'no-store',
      });
      if (response.ok) {
        currentUser = await response.json();
        if (currentUser?.email) {
          session.email = currentUser.email;
          localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        }
        return Boolean(currentUser?.id);
      }
      if (attempt === 0 && session.refreshToken) await refreshSession(true);
    }
  } catch {
    clearSession();
    return false;
  }
  clearSession();
  return false;
}

function getExecutionBounds(targetCount) {
  return { min: Math.max(1, Number(targetCount) - 10), max: Number(targetCount) + 10 };
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
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
    title.append(node('span', '', `N=${target.execution_target} · ${target.duration_weeks} sem.`));
    main.append(title);
    const bounds = getExecutionBounds(target.execution_target);
    const url = node('p', 'target-detail');
    url.textContent = target.url;
    const label = node('p', 'target-detail');
    label.append(node('b', '', 'Lien : '), document.createTextNode(`« ${target.link_label} » · tirage ${bounds.min}–${bounds.max}`));
    main.append(url, label);
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
  const count = [...selectedIds].filter((id) => targets.some((target) => target.id === id)).length;
  selectedIds = new Set([...selectedIds].filter((id) => targets.some((target) => target.id === id)));
  startButton.disabled = count === 0 || runActive;
  startButton.textContent = runActive
    ? 'Une session est déjà en cours'
    : count ? `Lancer ${count} cible${count > 1 ? 's' : ''} sélectionnée${count > 1 ? 's' : ''}` : 'Lancer les cibles sélectionnées';
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
  $('#target-label').value = target.link_label;
  $('#target-count').value = target.execution_target;
  $('#target-duration').value = target.duration_weeks;
  $('#target-form-title').textContent = `Modifier · ${target.pseudo}`;
  $('#save-target').textContent = 'Enregistrer les changements';
  $('#cancel-edit').classList.remove('hidden');
  $('#target-pseudo').focus({ preventScroll: true });
  $('#target-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetTargetForm() {
  editingId = null;
  targetForm.reset();
  $('#target-count').value = '10';
  $('#target-duration').value = '2';
  $('#target-form-title').textContent = 'Nouvelle cible';
  $('#save-target').textContent = 'Enregistrer la cible';
  $('#cancel-edit').classList.add('hidden');
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
    executionTarget: Number($('#target-count').value),
    durationWeeks: Number($('#target-duration').value),
  };
  const button = $('#save-target');
  const wasEditing = Boolean(editingId);
  button.disabled = true;
  button.textContent = 'Enregistrement…';
  try {
    const data = await apiRequest('/api/targets', {
      method: editingId ? 'PATCH' : 'POST',
      body: JSON.stringify(editingId ? { ...payload, id: editingId } : payload),
    });
    if (editingId && selectedIds.has(editingId)) selectedIds.add(data.target.id);
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

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
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
      stop.disabled = true;
      try {
        await apiRequest('/api/stop', { method: 'POST', body: JSON.stringify({ runId: run.id }) });
        toastMessage('Les cycles en attente ont été annulés.');
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

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

function renderActivity(visits) {
  activityList.replaceChildren();
  if (!visits.length) {
    activityList.append(node('div', 'empty-state', 'Aucun cycle lancé.'));
    return;
  }
  const sorted = [...visits].sort((a, b) => {
    const aTime = new Date(a.completed_at || a.started_at || a.scheduled_at || a.created_at).valueOf();
    const bTime = new Date(b.completed_at || b.started_at || b.scheduled_at || b.created_at).valueOf();
    return bTime - aTime;
  });
  sorted.forEach((visit) => {
    const item = node('div', 'activity-item');
    item.append(node('span', `activity-dot ${visit.status}`, ''));
    const body = node('div', 'activity-body');
    body.append(node('strong', '', `${visit.pseudo} · visite ${visit.visit_number} · ${statusLabel(visit.status)}`));
    const message = visit.result?.message || (visit.status === 'pending'
      ? `Prévue ${formatDate(visit.scheduled_at)}`
      : visit.status === 'success'
        ? `Redirection terminée${visit.result?.title ? ` · ${visit.result.title}` : ''}`
        : visit.status === 'running' ? 'Le navigateur distant exécute le cycle.' : '');
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
          toastMessage('Confirmation enregistrée.');
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
    renderActivity(Array.isArray(data.visits) ? data.visits : []);
  } catch (error) {
    if (error.message !== 'Connectez-vous pour continuer.') toastMessage(displayError(error), true);
  } finally { loadingActivity = false; }
}

async function startRun() {
  const targetIds = [...selectedIds].filter((id) => targets.some((target) => target.id === id));
  if (!targetIds.length) return;
  const oldText = startButton.textContent;
  startButton.disabled = true;
  startButton.innerHTML = '<span class="spinner" aria-hidden="true"></span> Programmation du premier cycle…';
  try {
    const data = await apiRequest('/api/start', {
      method: 'POST',
      body: JSON.stringify({ targetIds, confirmClicks: $('#confirm-clicks').checked }),
    });
    const message = `Session créée. ${data.plannedVisits} visite(s) planifiée(s); le worker traite immédiatement jusqu’à deux premières visites. Si la confirmation est activée, le clic attend votre approbation; le reste reste en file cloud.`;
    $('#notice').textContent = message;
    $('#notice').classList.remove('hidden', 'error');
    selectedIds.clear();
    renderTargets();
    await loadActivity();
    toastMessage('Session cloud créée.');
  } catch (error) {
    toastMessage(displayError(error, 'Le lancement a échoué.'), true);
  } finally {
    startButton.innerHTML = '';
    startButton.textContent = oldText;
    updateSelectionState();
  }
}

async function loadProxyStatus() {
  try {
    const data = await apiRequest('/api/proxy');
    proxyConfigured = Boolean(data.configured);
    const badge = $('#proxy-badge');
    badge.textContent = proxyConfigured ? 'Configuré · secret masqué' : 'Non configuré';
    badge.className = proxyConfigured ? 'status-badge status-success' : 'status-badge status-neutral';
    $('#remove-proxy').classList.toggle('hidden', !proxyConfigured);
  } catch (error) {
    setFormMessage($('#proxy-message'), displayError(error), 'error');
  }
}

async function saveProxy(event) {
  event.preventDefault();
  const button = $('#save-proxy');
  button.disabled = true;
  try {
    await apiRequest('/api/proxy', {
      method: 'POST',
      body: JSON.stringify({
        scheme: $('#proxy-scheme').value,
        host: $('#proxy-host').value.trim(),
        port: Number($('#proxy-port').value),
        username: $('#proxy-username').value,
        password: $('#proxy-password').value,
      }),
    });
    $('#proxy-username').value = '';
    $('#proxy-password').value = '';
    setFormMessage($('#proxy-message'), 'Identifiants sauvegardés dans le coffre chiffré. Les champs ont été effacés.', 'success');
    await loadProxyStatus();
  } catch (error) { setFormMessage($('#proxy-message'), displayError(error), 'error'); }
  finally { button.disabled = false; }
}

async function removeProxy() {
  if (!window.confirm('Supprimer les identifiants Webshare stockés dans le coffre ?')) return;
  const button = $('#remove-proxy');
  button.disabled = true;
  try {
    await apiRequest('/api/proxy', { method: 'DELETE' });
    proxyConfigured = false;
    $('#proxy-password').value = '';
    $('#proxy-username').value = '';
    $('#proxy-badge').textContent = 'Non configuré';
    $('#proxy-badge').className = 'status-badge status-neutral';
    button.classList.add('hidden');
    setFormMessage($('#proxy-message'), 'Identifiants supprimés.', 'success');
  } catch (error) { setFormMessage($('#proxy-message'), displayError(error), 'error'); }
  finally { button.disabled = false; }
}

async function enterWorkspace() {
  showWorkspace();
  await Promise.all([loadTargets(), loadProxyStatus(), loadActivity()]);
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (document.visibilityState === 'visible') loadActivity(); }, 15000);
}

async function handleAuth(event) {
  event.preventDefault();
  if (!config) {
    setFormMessage(authMessage, 'Le serveur n’est pas encore configuré.', 'error');
    return;
  }
  const button = $('#auth-submit');
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  button.disabled = true;
  setFormMessage(authMessage, authMode === 'login' ? 'Connexion…' : 'Création du compte…');
  try {
    if (authMode === 'login') {
      const data = await authRequest('token?grant_type=password', { email, password });
      if (!data.access_token) throw new Error('Le serveur d’authentification n’a pas fourni de session.');
      saveSession(data);
      currentUser = data.user || { email };
      await enterWorkspace();
      setConnection(true);
    } else {
      const redirectTo = encodeURIComponent(`${location.origin}/`);
      const data = await authRequest(`signup?redirect_to=${redirectTo}`, { email, password });
      if (data.access_token) {
        saveSession(data);
        currentUser = data.user || { email };
        await enterWorkspace();
      } else {
        setFormMessage(authMessage, 'Compte créé. Vérifiez votre e-mail pour confirmer l’adresse, puis connectez-vous.', 'success');
      }
    }
  } catch (error) { setFormMessage(authMessage, displayError(error, 'Authentification impossible.'), 'error'); }
  finally { button.disabled = false; }
}

function logout() {
  clearSession();
  targets = [];
  selectedIds.clear();
  currentUser = null;
  showAuth('Vous êtes déconnecté.');
}

function showNotice(message, isError = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.classList.remove('hidden');
}

async function boot() {
  setConnection(navigator.onLine);
  window.addEventListener('online', () => setConnection(true));
  window.addEventListener('offline', () => setConnection(false));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  document.querySelectorAll('.auth-tab').forEach((button) => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  authForm.addEventListener('submit', handleAuth);
  targetForm.addEventListener('submit', saveTarget);
  $('#cancel-edit').addEventListener('click', resetTargetForm);
  $('#select-all').addEventListener('change', (event) => {
    selectedIds = event.target.checked ? new Set(targets.map((target) => target.id)) : new Set();
    renderTargets();
  });
  startButton.addEventListener('click', startRun);
  $('#proxy-form').addEventListener('submit', saveProxy);
  $('#remove-proxy').addEventListener('click', removeProxy);
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
    const response = await fetch('/api/config', { cache: 'no-store' });
    config = response.ok ? await response.json() : null;
  } catch { config = null; }
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) {
    showAuth('Le serveur n’est pas encore configuré. L’interface est prête, mais l’authentification cloud n’est pas disponible.');
    return;
  }
  if (await verifySession()) {
    await enterWorkspace();
    setConnection(true);
  } else {
    showAuth();
  }
}

boot().catch((error) => showNotice(displayError(error), true));
