const STORAGE_KEY = "savedTargets";
const PROXY_STORAGE_KEY = "savedProxies";
const PROXY_SETTINGS_KEY = "proxySettings";
const PROXY_MIGRATION_FLAG = "proxiesMigrated";
const MAX_SAVED_TARGETS = 50;
const MAX_TARGET_DURATION_DAYS = 365;
const DEFAULT_TARGET_DAYS = 7;
const DEFAULT_VISIT_INTERVAL_MS = 2500;
const DAILY_JOURNAL_KEY = "dailyClicks";
const DAILY_JOURNAL_KEEP_DAYS = 40;
const PROXY_RECOVERY_KEY = "temporaryProxyRecovery";
const PROXY_AUTH_SESSION_KEY = "temporaryProxyAuth";
const MIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 800 };
const REDIRECT_QUIET_MS = 2500;
const REDIRECT_MAX_WAIT_MS = 15000;
const MIN_OCR_CONFIDENCE = 45;
const OCR_ASSET_BASE = "vendor/";

const Utils = globalThis.InstaVAUtils;
if (!Utils) throw new Error("Le module bot-utils.js n’a pas été chargé.");
const {
  MAX_CONSECUTIVE_FAILURES,
  MAX_TARGET_VISITS,
  MIN_VISITS_PER_DAY,
  MAX_INTERVAL_DAYS,
  normalizeTargetMode,
  parseTargetVisits,
  parseTargetDays,
  executionBounds,
  dailyMinimumVisits,
  dailyVisitQuota,
  buildDailyRunTimes,
  fitVisitsToRate,
  maxVisitsPerDay,
  dayKey,
  pruneDailyJournal,
  dailyClickTarget,
  needsMoreToday,
  planVisits,
  nextVisitDelayMs,
  normalizeLinkLabel: normalizeLinkLabelText,
  isSensitiveLabel,
  describeTargetPlan,
  validateProxyEntry,
  proxySignature,
  proxyGatewayHint,
  parseProxyLine,
  parseProxyLines,
  proxyEndpoint,
  proxyLabel,
  proxyCredentialsLine,
  maskUsername,
  pickProxy,
  applyProxyOutcome,
  sanitizeSavedProxy,
  sanitizeProxySettings,
  normalizeOcrLanguage,
  buildOcrWorkerOptions,
} = Utils;

const $ = (id) => document.getElementById(id);
const targetListNode = $("targetList");
const emptyTargetsNode = $("emptyTargets");
const selectionSummaryNode = $("selectionSummary");
const targetForm = $("targetForm");
const targetPseudoInput = $("targetPseudo");
const targetUrlInput = $("targetUrl");
const targetLinkLabelInput = $("targetLinkLabel");
const targetModeIntervalInput = $("targetModeInterval");
const targetModeGoalInput = $("targetModeGoal");
const targetExecutionCountLabel = $("targetExecutionCountLabel");
const targetDurationField = $("targetDurationField");
const targetModeHint = $("targetModeHint");
const targetExecutionCountInput = $("targetExecutionCount");
const targetDurationWeeksInput = $("targetDurationWeeks");
const commonExecutionCountInput = $("commonExecutionCount");
const commonDurationWeeksInput = $("commonDurationWeeks");
const useRotatingProxyInput = $("useRotatingProxy");
const proxyRotationModeInput = $("proxyRotationMode");
const autoDisableProxyInput = $("autoDisableProxy");
const proxyListNode = $("proxyList");
const emptyProxiesNode = $("emptyProxies");
const proxySummaryNode = $("proxySummary");
const clearProxiesButton = $("clearProxies");
const proxyForm = $("proxyForm");
const proxyFormTitle = $("proxyFormTitle");
const proxyHostInput = $("proxyHost");
const proxyPortInput = $("proxyPort");
const proxySchemeInput = $("proxyScheme");
const proxyUsernameInput = $("proxyUsername");
const proxyPasswordInput = $("proxyPassword");
const saveProxyButton = $("saveProxy");
const cancelProxyEditButton = $("cancelProxyEdit");
const proxyFormFeedbackNode = $("proxyFormFeedback");
const proxyImportForm = $("proxyImportForm");
const proxyImportLinesInput = $("proxyImportLines");
const proxyDefaultUsernameInput = $("proxyDefaultUsername");
const proxyDefaultPasswordInput = $("proxyDefaultPassword");
const importProxiesButton = $("importProxies");
const proxyImportFeedbackNode = $("proxyImportFeedback");
const formTitle = $("formTitle");
const saveTargetButton = $("saveTarget");
const cancelEditButton = $("cancelEdit");
const selectAllTargetsButton = $("selectAllTargets");
const clearSelectionButton = $("clearSelection");
const applyCountToAllButton = $("applyCountToAll");
const applyDurationToAllButton = $("applyDurationToAll");
const languageInput = $("ocrLanguage");
const ocrWorkerStatusNode = $("ocrWorkerStatus");
const confirmClicksInput = $("confirmClicks");
const startButton = $("startButton");
const stopButton = $("stopButton");
const statusNode = $("status");
const currentUrlNode = $("currentUrl");
const screenPreview = $("screenPreview");
const previewEmpty = $("previewEmpty");
const ocrTextNode = $("ocrText");
const logNode = $("log");
const runConfigurationInputs = [
  targetPseudoInput,
  targetUrlInput,
  targetLinkLabelInput,
  targetExecutionCountInput,
  targetDurationWeeksInput,
  targetModeIntervalInput,
  targetModeGoalInput,
  commonExecutionCountInput,
  commonDurationWeeksInput,
  useRotatingProxyInput,
  proxyRotationModeInput,
  autoDisableProxyInput,
  proxyImportLinesInput,
  proxyDefaultUsernameInput,
  proxyDefaultPasswordInput,
  importProxiesButton,
  languageInput,
  confirmClicksInput,
];

let savedTargets = [];
let savedProxies = [];
let proxySettings = sanitizeProxySettings(null);
let selectedTargetIds = new Set();
let editingTargetId = null;
let editingProxyId = null;
let running = false;
let stopRequested = false;
let activeTabId = null;
let ocrWorker = null;
let ocrReadyPromise = null;
let ocrStartingLanguage = "";
let ocrWorkerState = "idle";
let loadedLanguage = "";

$("clearLog").addEventListener("click", () => logNode.replaceChildren());
proxyForm.addEventListener("submit", saveProxyFromForm);
proxyHostInput.addEventListener("paste", handleProxyHostPaste);
proxyImportForm.addEventListener("submit", importProxiesFromText);
clearProxiesButton.addEventListener("click", clearAllProxies);
cancelProxyEditButton.addEventListener("click", clearProxyForm);
useRotatingProxyInput.addEventListener("change", saveProxySettingsFromForm);
proxyRotationModeInput.addEventListener("change", saveProxySettingsFromForm);
autoDisableProxyInput.addEventListener("change", saveProxySettingsFromForm);
targetForm.addEventListener("submit", saveTargetFromForm);
targetModeIntervalInput.addEventListener("change", applyTargetModeToForm);
targetModeGoalInput.addEventListener("change", applyTargetModeToForm);
cancelEditButton.addEventListener("click", clearTargetForm);
selectAllTargetsButton.addEventListener("click", selectAllTargets);
clearSelectionButton.addEventListener("click", clearTargetSelection);
applyCountToAllButton.addEventListener("click", () => applyCommonValue("executionTarget"));
applyDurationToAllButton.addEventListener("click", () => applyCommonValue("durationDays"));
startButton.addEventListener("click", startRun);
stopButton.addEventListener("click", () => {
  stopRequested = true;
  if (activeTabId !== null) chromeCall(chrome.tabs.remove, activeTabId).catch(() => {});
  setStatus("Arrêt demandé…");
  stopButton.disabled = true;
});
window.addEventListener("pagehide", () => {
  stopRequested = true;
  if (activeTabId !== null) chromeCall(chrome.tabs.remove, activeTabId).catch(() => {});
  chrome.runtime.sendMessage({ type: "restore-temporary-proxy" }).catch(() => {});
});

initializeTargets();
initializeProxies();

async function initializeTargets() {
  setConfigurationDisabled(true);
  startButton.disabled = true;
  setStatus("Chargement des cibles enregistrées…");
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result?.[STORAGE_KEY];
    savedTargets = Array.isArray(stored) ? stored.map(sanitizeSavedTarget).filter(Boolean) : [];
    renderTargetList();
    setStatus(savedTargets.length ? `${savedTargets.length} cible(s) chargée(s).` : "Ajoute une cible pour commencer.");
  } catch (error) {
    savedTargets = [];
    renderTargetList();
    setStatus(`Impossible de charger le stockage local : ${error.message}`);
    addLog("Chargement des cibles échoué", error.message, true);
  } finally {
    setConfigurationDisabled(false);
    updateSelectionSummary();
  }
}

function sanitizeSavedTarget(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  try {
    const pseudo = String(raw.pseudo || "").trim();
    const url = normalizeTargetUrl(String(raw.url || ""));
    const legacyClickStep = Array.isArray(raw.workflowSteps)
      ? raw.workflowSteps.find((step) => step?.type === "click-link")
      : null;
    const rawLinkLabel = [raw.linkLabel, raw.buttonLabel, legacyClickStep?.label, legacyClickStep?.linkLabel]
      .map((value) => String(value ?? "").trim())
      .find(Boolean) || "";
    const linkLabel = normalizeLinkLabelText(rawLinkLabel);
    const executionTarget = parseTargetVisits(raw.executionTarget);
    const mode = normalizeTargetMode(raw.mode);
    // La durée est exprimée en jours. Les anciennes fiches en semaines (<= 0.9.0)
    // sont converties : 1 semaine = 7 jours.
    const legacyDays = raw.durationWeeks != null
      ? Number(raw.durationWeeks) * 7
      : Number(raw.durationDays);
    const durationDays = parseTargetDays(legacyDays);
    if (!pseudo || pseudo.length > 60) return null;
    if (executionTarget === null) return null;
    if (!linkLabel.ok) return null;
    // La durée n'est conservée qu'en mode intervalle; en mode objectif elle est ignorée.
    if (mode === "interval" && durationDays === null) return null;
    return {
      id: raw.id,
      pseudo,
      url,
      linkLabel: linkLabel.label,
      mode,
      executionTarget,
      durationDays: mode === "interval" ? durationDays : DEFAULT_TARGET_DAYS,
    };
  } catch {
    return null;
  }
}

function renderTargetList() {
  targetListNode.replaceChildren();
  emptyTargetsNode.hidden = savedTargets.length > 0;
  for (const target of savedTargets) {
    const item = document.createElement("article");
    item.className = "target-item";
    const checkbox = document.createElement("input");
    checkbox.className = "target-select";
    checkbox.type = "checkbox";
    checkbox.checked = selectedTargetIds.has(target.id);
    checkbox.setAttribute("aria-label", `Sélectionner ${target.pseudo}`);
    const content = document.createElement("div");
    content.className = "target-content";
    const topLine = document.createElement("div");
    topLine.className = "target-topline";
    const pseudo = document.createElement("div");
    pseudo.className = "target-pseudo";
    pseudo.textContent = target.pseudo;
    const actions = document.createElement("div");
    actions.className = "target-actions";
    const editButton = document.createElement("button");
    editButton.className = "text-button";
    editButton.type = "button";
    editButton.textContent = "Modifier";
    editButton.addEventListener("click", () => editTarget(target.id));
    const deleteButton = document.createElement("button");
    deleteButton.className = "text-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Supprimer";
    deleteButton.addEventListener("click", () => deleteTarget(target.id));
    actions.append(editButton, deleteButton);
    topLine.append(pseudo, actions);

    const bounds = executionBounds(target.mode, target.executionTarget);
    const meta = document.createElement("p");
    meta.className = "target-meta";
    const modeLabel = target.mode === "goal" ? "Objectif" : "Intervalle";
    const linkText = target.linkLabel ? `« ${target.linkLabel} »` : "lien principal (libellé vide)";
    const planText = target.mode === "goal"
      ? `${target.executionTarget} visite(s) d’affilée, sans durée`
      : `visée ${target.executionTarget} · Durée : ${target.durationDays} jour(s) · ≥ ${MIN_VISITS_PER_DAY} clics/jour`;
    meta.textContent = `${target.url}\nLien à cliquer : ${linkText}\nMode ${modeLabel} : ${planText}`;
    content.append(topLine, meta);
    item.append(checkbox, content);
    if (checkbox.checked) item.classList.add("selected");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedTargetIds.add(target.id);
      else selectedTargetIds.delete(target.id);
      item.classList.toggle("selected", checkbox.checked);
      updateSelectionSummary();
    });
    targetListNode.append(item);
  }
  selectAllTargetsButton.disabled = running || savedTargets.length === 0;
  clearSelectionButton.disabled = running || selectedTargetIds.size === 0;
  applyCountToAllButton.disabled = running || savedTargets.length === 0;
  applyDurationToAllButton.disabled = running || savedTargets.length === 0;
  updateSelectionSummary();
}

function updateSelectionSummary() {
  selectionSummaryNode.textContent = `${selectedTargetIds.size} sélectionnée(s) sur ${savedTargets.length}`;
  if (!running) startButton.disabled = selectedTargetIds.size === 0;
  clearSelectionButton.disabled = running || selectedTargetIds.size === 0;
}

function selectAllTargets() {
  if (running) return;
  selectedTargetIds = new Set(savedTargets.map((target) => target.id));
  renderTargetList();
}

function clearTargetSelection() {
  if (running) return;
  selectedTargetIds.clear();
  renderTargetList();
}

async function saveTargetFromForm(event) {
  event.preventDefault();
  if (running) return;

  const wasEditing = Boolean(editingTargetId);
  let target;
  try {
    target = readTargetForm();
    const duplicate = savedTargets.find((item) =>
      item.id !== editingTargetId && item.pseudo.toLocaleLowerCase("fr") === target.pseudo.toLocaleLowerCase("fr"));
    if (duplicate) throw new Error("Ce pseudo est déjà utilisé par une autre cible.");
    if (!editingTargetId && savedTargets.length >= MAX_SAVED_TARGETS) {
      throw new Error(`Maximum ${MAX_SAVED_TARGETS} cibles enregistrées.`);
    }
  } catch (error) {
    setStatus(error.message);
    return;
  }

  const nextTargets = editingTargetId
    ? savedTargets.map((item) => item.id === editingTargetId ? { ...item, ...target } : item)
    : [...savedTargets, { id: crypto.randomUUID(), ...target }];
  try {
    await persistTargets(nextTargets);
  } catch (error) {
    setStatus(`Échec de l’enregistrement local : ${error.message}`);
    addLog("Enregistrement de la cible échoué", error.message, true);
    return;
  }

  savedTargets = nextTargets;
  clearTargetForm();
  renderTargetList();
  setStatus(wasEditing ? "Cible mise à jour." : "Cible enregistrée localement.");
}

function readTargetForm() {
  const pseudo = targetPseudoInput.value.trim();
  if (!pseudo) throw new Error("Renseigne un pseudo ou nom de cible.");
  if (pseudo.length > 60) throw new Error("Le pseudo doit faire 60 caractères maximum.");
  const url = normalizeTargetUrl(targetUrlInput.value);
  // Libellé facultatif : vide = le bot clique le lien principal de la page.
  const linkLabel = normalizeLinkLabelText(targetLinkLabelInput.value);
  if (!linkLabel.ok) throw new Error(linkLabel.message);
  const mode = selectedTargetMode();
  const executionTarget = parseTargetVisits(targetExecutionCountInput.value);
  if (executionTarget === null) {
    throw new Error(`Nombre ${mode === "goal" ? "cible" : "visé"} invalide : saisis un entier positif (maximum ${MAX_TARGET_VISITS.toLocaleString("fr")}).`);
  }
  const durationDays = mode === "goal" ? DEFAULT_TARGET_DAYS : parseTargetDays(targetDurationWeeksInput.value);
  if (mode === "interval" && durationDays === null) {
    throw new Error(`Durée en jours invalide : saisis un entier entre 1 et ${MAX_TARGET_DURATION_DAYS}.`);
  }
  return { pseudo, url, linkLabel: linkLabel.label, mode, executionTarget, durationDays };
}

function selectedTargetMode() {
  return normalizeTargetMode(targetModeGoalInput.checked ? "goal" : "interval");
}

function setTargetMode(mode) {
  const normalized = normalizeTargetMode(mode);
  targetModeGoalInput.checked = normalized === "goal";
  targetModeIntervalInput.checked = normalized !== "goal";
  applyTargetModeToForm();
}

/** Le mode objectif n'a pas de durée : le champ est masqué et non requis. */
function applyTargetModeToForm() {
  const mode = selectedTargetMode();
  const isGoal = mode === "goal";
  targetDurationField.hidden = isGoal;
  targetDurationWeeksInput.disabled = isGoal || running;
  targetDurationWeeksInput.required = !isGoal;
  targetExecutionCountLabel.textContent = isGoal ? "Nombre cible" : "Nombre visé";
  targetExecutionCountInput.placeholder = isGoal ? "Ex. 500" : "Ex. 10";
  targetModeHint.textContent = isGoal
    ? "Le bot enchaîne exactement ce nombre de visites en une seule fois, sans durée ni étalement. Avec un libellé, il clique ce lien à chaque visite; sans libellé, il clique le lien principal de la page."
    : `Le nombre saisi est exécuté à l'identique, réparti sur la durée en jours choisie (1 à ${MAX_TARGET_DURATION_DAYS}), avec au moins ${MIN_VISITS_PER_DAY} clics par jour et 5 minutes minimum entre deux visites. Un nombre trop faible est relevé au minimum quotidien.`;
}

function readProxyForm() {
  const validation = validateProxyEntry({
    scheme: proxySchemeInput.value,
    host: proxyHostInput.value,
    port: proxyPortInput.value,
    username: proxyUsernameInput.value,
    password: proxyPasswordInput.value,
  });
  if (!validation.ok) throw new Error(validation.message);
  return validation.value;
}

async function persistProxies(proxies = savedProxies) {
  await chrome.storage.local.set({ [PROXY_STORAGE_KEY]: proxies });
}

async function persistProxySettings(settings = proxySettings) {
  proxySettings = sanitizeProxySettings(settings);
  await chrome.storage.local.set({ [PROXY_SETTINGS_KEY]: proxySettings });
}

async function initializeProxies() {
  try {
    const stored = await chrome.storage.local.get([PROXY_STORAGE_KEY, PROXY_SETTINGS_KEY, PROXY_MIGRATION_FLAG]);
    savedProxies = Array.isArray(stored?.[PROXY_STORAGE_KEY])
      ? stored[PROXY_STORAGE_KEY].map(sanitizeSavedProxy).filter(Boolean)
      : [];
    proxySettings = sanitizeProxySettings(stored?.[PROXY_SETTINGS_KEY]);
    // Récupère le tout premier proxy saisi dans l'ancien formulaire unique (v0.7.0).
    if (!stored?.[PROXY_MIGRATION_FLAG]) {
      const migrated = await migrateLegacyProxyForm();
      if (migrated) await persistProxies();
      await chrome.storage.local.set({ [PROXY_MIGRATION_FLAG]: true });
    }
    renderProxySettings();
    renderProxyList();
  } catch (error) {
    savedProxies = [];
    renderProxySettings();
    renderProxyList();
    addLog("Chargement des proxys échoué", error.message, true);
  }
}

/**
 * Les versions ≤ 0.7.0 ne conservaient qu'un seul jeu d'identifiants en stockage
 * de session. On le reprend une fois s'il est encore présent.
 */
async function migrateLegacyProxyForm() {
  try {
    const session = await chrome.storage.session.get(PROXY_AUTH_SESSION_KEY);
    const legacy = session?.[PROXY_AUTH_SESSION_KEY];
    if (!legacy) return false;
    const validation = validateProxyEntry({ ...legacy, scheme: legacy.scheme || "http" });
    if (!validation.ok) return false;
    if (savedProxies.some((proxy) => proxySignature(proxy) === proxySignature(validation.value))) return false;
    savedProxies.push(createProxyRecord(validation.value));
    return true;
  } catch {
    return false;
  }
}

function createProxyRecord(value) {
  return {
    id: crypto.randomUUID(),
    name: "",
    scheme: value.scheme,
    host: value.host,
    port: value.port,
    username: value.username,
    password: value.password,
    enabled: true,
    uses: 0,
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastUsedAt: "",
    lastError: "",
    lastTestAt: "",
    lastTestIp: "",
    lastTestError: "",
    disabledReason: "",
    createdAt: new Date().toISOString(),
  };
}

function renderProxySettings() {
  useRotatingProxyInput.checked = proxySettings.useProxy;
  proxyRotationModeInput.value = proxySettings.mode;
  autoDisableProxyInput.checked = proxySettings.autoDisable;
}

function setProxyFeedback(element, message, tone = "ok") {
  if (!element) return;
  if (!message) {
    element.textContent = "";
    element.hidden = true;
    element.className = "import-feedback";
    return;
  }
  element.textContent = message;
  element.className = `import-feedback ${tone}`;
  element.hidden = false;
}

function renderProxyList() {
  proxyListNode.replaceChildren();
  emptyProxiesNode.hidden = savedProxies.length > 0;
  clearProxiesButton.hidden = savedProxies.length === 0;
  clearProxiesButton.disabled = running;
  proxySummaryNode.textContent = proxySummaryText();

  for (const proxy of savedProxies) {
    const item = document.createElement("article");
    item.className = "proxy-item";
    if (!proxy.enabled) item.classList.add("disabled");
    if (proxy.enabled && proxySettings.useProxy) item.classList.add("selected");
    if (proxy.id === editingProxyId) item.classList.add("editing");

    const main = document.createElement("div");
    main.className = "proxy-main";
    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = proxy.enabled;
    enabledToggle.disabled = running;
    enabledToggle.setAttribute("aria-label", `Activer ${proxyLabel(proxy)}`);
    enabledToggle.addEventListener("change", () => toggleProxy(proxy.id, enabledToggle.checked));

    const body = document.createElement("div");
    body.className = "proxy-body";
    const topLine = document.createElement("div");
    topLine.className = "proxy-topline";
    const name = document.createElement("div");
    name.className = "proxy-name";
    const gwHint = !proxy.name ? proxyGatewayHint(proxy) : "";
    name.textContent = gwHint ? `${proxyLabel(proxy)} · ${gwHint}` : proxyLabel(proxy);
    const badge = document.createElement("span");
    badge.className = "proxy-badge";
    if (!proxy.enabled) {
      badge.classList.add("off");
      badge.textContent = proxy.disabledReason ? "désactivé" : "off";
    } else if (proxy.lastError) {
      badge.classList.add("warn");
      badge.textContent = `${proxy.consecutiveFailures} échec(s)`;
    } else if (proxy.uses > 0) {
      badge.classList.add("ok");
      badge.textContent = "utilisé";
    } else {
      badge.textContent = "prêt";
    }
    topLine.append(name, badge);

    const meta = document.createElement("p");
    meta.className = "proxy-meta";
    const endpoint = proxyEndpoint(proxy);
    const usage = `${proxy.uses} cycle(s) · ${proxy.successes} OK · ${proxy.failures} échec(s)`;
    const test = proxy.lastTestIp
      ? `Dernier test : IP ${proxy.lastTestIp}`
      : proxy.lastTestError
        ? `Dernier test échoué : ${proxy.lastTestError}`
        : "Jamais testé";
    const kind = proxy.ipKind
      ? InstaVAUtils.describeIpKind({ kind: proxy.ipKind, org: proxy.ipOrg, asn: proxy.ipAsn })
      : "Nature d’IP inconnue — lancez « Tester »";
    const identity = proxy.name ? `${endpoint} · ${maskUsername(proxy.username)}` : maskUsername(proxy.username);
    meta.textContent = [
      proxy.name ? endpoint : identity,
      kind,
      usage,
      test,
      proxy.disabledReason || (proxy.lastError ? `Dernière erreur : ${proxy.lastError}` : ""),
    ].filter(Boolean).join("\n");

    const actions = document.createElement("div");
    actions.className = "proxy-actions";
    actions.append(
      proxyActionButton("Modifier", () => editProxy(proxy.id)),
      proxyActionButton("Tester", () => testProxy(proxy.id)),
      proxyActionButton("Copier", () => copyProxy(proxy.id)),
      proxyActionButton("Supprimer", () => deleteProxy(proxy.id), !running),
    );

    body.append(topLine, meta, actions);
    main.append(enabledToggle, body);
    item.append(main);
    proxyListNode.append(item);
  }

  proxySummaryNode.textContent = proxySummaryText();
}

/** Récapitulatif : combien sont actifs et combien sont résidentiels. */
function proxySummaryText() {
  if (!savedProxies.length) return "Aucun proxy";
  const enabledCount = savedProxies.filter((proxy) => proxy.enabled).length;
  const residential = savedProxies.filter((proxy) => proxy.enabled && proxy.ipKind === "residential").length;
  const order = proxySettings.mode === "random" ? "au hasard" : "dans l’ordre";
  return `${enabledCount}/${savedProxies.length} actif(s) · ${residential} résidentiel(s) · ${order}`;
}

function proxyActionButton(label, handler, disabled = false) {
  const button = document.createElement("button");
  button.className = "text-button";
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled || running;
  button.addEventListener("click", handler);
  return button;
}

function clearProxyForm() {
  editingProxyId = null;
  proxyForm.reset();
  proxySchemeInput.value = "http";
  proxyHostInput.value = "";
  proxyPortInput.value = "";
  proxyUsernameInput.value = "";
  proxyPasswordInput.value = "";
  proxyFormTitle.textContent = "Ajouter un proxy";
  saveProxyButton.textContent = "Ajouter à la liste";
  cancelProxyEditButton.hidden = true;
  setProxyFeedback(proxyFormFeedbackNode, "");
  renderProxyList();
}

function handleProxyHostPaste(event) {
  if (running) return;
  const pasted = String(event.clipboardData?.getData("text") || "").trim();
  if (!pasted) return;

  // Si l'utilisateur colle plusieurs lignes (ou des proxys séparés par , ou ;) dans « Hôte »,
  // on redirige automatiquement vers la zone « Import en masse » au lieu de tronquer les retours à la ligne.
  if (/[\r\n]/.test(pasted) || (pasted.indexOf(":") > 0 && /[,;]/.test(pasted) && parseProxyLines(pasted).entries.length > 1)) {
    event.preventDefault();
    proxyImportLinesInput.value = proxyImportLinesInput.value.trim()
      ? `${proxyImportLinesInput.value.trim()}\n${pasted}`
      : pasted;
    setProxyFeedback(proxyFormFeedbackNode, "");
    setProxyFeedback(proxyImportFeedbackNode, "Liste collée dans « Import en masse » : clique sur « Importer la liste ».", "warn");
    if (typeof proxyImportForm.scrollIntoView === "function") {
      proxyImportForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    proxyImportLinesInput.focus();
    return;
  }

  // Si une ligne complète (user:pass@host:port ou host:port:user:pass) est collée dans « Hôte »,
  // on remplit automatiquement tous les champs du formulaire.
  if (pasted.indexOf(":") > 0) {
    const parsed = parseProxyLine(pasted, { defaultScheme: proxySchemeInput.value || "http" });
    if (parsed.ok) {
      event.preventDefault();
      proxySchemeInput.value = parsed.value.scheme;
      proxyHostInput.value = parsed.value.host;
      proxyPortInput.value = String(parsed.value.port);
      proxyUsernameInput.value = parsed.value.username;
      proxyPasswordInput.value = parsed.value.password;
      setProxyFeedback(proxyFormFeedbackNode, "Ligne reconnue : clique sur « Ajouter à la liste ».", "ok");
    }
  }
}

async function clearAllProxies() {
  if (running || !savedProxies.length) return;
  if (!window.confirm(`Supprimer les ${savedProxies.length} proxy(s) de la liste ?`)) return;
  try {
    await persistProxies([]);
    savedProxies = [];
    if (editingProxyId) clearProxyForm();
    renderProxyList();
    setProxyFeedback(proxyImportFeedbackNode, "Liste vidée. Tu peux coller une nouvelle liste ci-dessus.", "ok");
    setStatus("Liste des proxys vidée.");
  } catch (error) {
    setProxyFeedback(proxyImportFeedbackNode, `Suppression impossible : ${error.message}`, "error");
    addLog("Vidage des proxys échoué", error.message, true);
  }
}

async function saveProxyFromForm(event) {
  event.preventDefault();
  if (running) return;
  let value;
  try {
    value = readProxyForm();
  } catch (error) {
    setProxyFeedback(proxyFormFeedbackNode, error.message, "error");
    setStatus(error.message);
    return;
  }

  const signature = proxySignature(value);
  const duplicate = savedProxies.find((proxy) => proxySignature(proxy) === signature && proxy.id !== editingProxyId);
  if (duplicate) {
    const message = `Ce proxy existe déjà dans la liste (${proxyLabel(duplicate)}).`;
    setProxyFeedback(proxyFormFeedbackNode, message, "warn");
    setStatus(message);
    return;
  }

  const isEditing = Boolean(editingProxyId);
  const nextProxies = isEditing
    ? savedProxies.map((proxy) => proxy.id === editingProxyId
      ? { ...proxy, ...value, enabled: true, disabledReason: "", consecutiveFailures: 0, lastError: "" }
      : proxy)
    : [...savedProxies, createProxyRecord(value)];

  try {
    await persistProxies(nextProxies);
  } catch (error) {
    setProxyFeedback(proxyFormFeedbackNode, `Enregistrement échoué : ${error.message}`, "error");
    addLog("Enregistrement du proxy échoué", error.message, true);
    return;
  }
  savedProxies = nextProxies;
  clearProxyForm();
  renderProxyList();
  const doneMessage = isEditing ? "Proxy mis à jour." : "✓ Proxy ajouté à la liste ci-dessus.";
  setProxyFeedback(proxyFormFeedbackNode, doneMessage, "ok");
  setStatus(isEditing ? "Proxy mis à jour." : "Proxy ajouté à la liste.");
  if (typeof proxyListNode.scrollIntoView === "function") {
    proxyListNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function importProxiesFromText(event) {
  event.preventDefault();
  if (running) return;
  const defaultUsername = proxyDefaultUsernameInput.value;
  const defaultPassword = proxyDefaultPasswordInput.value;
  const { entries, errors, duplicates: internalDuplicates } = parseProxyLines(proxyImportLinesInput.value, {
    defaultScheme: proxySchemeInput.value || "http",
    defaultUsername,
    defaultPassword,
  });

  if (!entries.length) {
    const errorMessage = errors.length
      ? `Aucun proxy importé (${errors.length} ligne(s) refusée(s)) — Ligne ${errors[0].line} : ${errors[0].message}`
      : "Colle au moins une ligne de proxy avant d’importer.";
    setProxyFeedback(proxyImportFeedbackNode, errorMessage, "error");
    setStatus(errorMessage);
    if (errors.length) addLog("Lignes ignorées", errors.map((error) => `Ligne ${error.line} : ${error.message}`).join("\n"), true);
    return;
  }

  const known = new Set(savedProxies.map(proxySignature));
  const additions = [];
  let duplicates = Number(internalDuplicates || 0);
  for (const entry of entries) {
    const signature = proxySignature(entry);
    if (known.has(signature)) {
      duplicates += 1;
      continue;
    }
    known.add(signature);
    additions.push(createProxyRecord(entry));
  }

  if (additions.length) {
    const nextProxies = [...savedProxies, ...additions];
    try {
      await persistProxies(nextProxies);
      savedProxies = nextProxies;
    } catch (error) {
      setProxyFeedback(proxyImportFeedbackNode, `Import échoué : ${error.message}`, "error");
      addLog("Import des proxys échoué", error.message, true);
      return;
    }
  }

  renderProxyList();
  const parts = [`${additions.length} proxy(s) importé(s)`];
  if (duplicates) parts.push(`${duplicates} doublon(s) ignoré(s)`);
  if (errors.length) parts.push(`${errors.length} ligne(s) invalide(s)`);
  const summary = `${parts.join(" · ")}.`;
  setStatus(summary);
  if (errors.length) addLog("Lignes ignorées", errors.map((error) => `Ligne ${error.line} : ${error.message}`).join("\n"), true);

  if (!additions.length) {
    setProxyFeedback(
      proxyImportFeedbackNode,
      `Ces ${duplicates} proxy(s) figurent déjà dans la liste ci-dessus (${summary})`,
      "warn",
    );
    if (typeof proxyListNode.scrollIntoView === "function") {
      proxyListNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    return;
  }

  proxyImportLinesInput.value = "";
  proxyDefaultPasswordInput.value = "";
  setProxyFeedback(
    proxyImportFeedbackNode,
    `✓ ${summary} Voir la liste ci-dessus.`,
    errors.length ? "warn" : "ok",
  );
  if (typeof proxyListNode.scrollIntoView === "function") {
    proxyListNode.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function toggleProxy(id, enabled) {
  if (running) return;
  const nextProxies = savedProxies.map((proxy) => proxy.id === id
    ? { ...proxy, enabled, disabledReason: "", consecutiveFailures: enabled ? 0 : proxy.consecutiveFailures }
    : proxy);
  try {
    await persistProxies(nextProxies);
  } catch (error) {
    addLog("Mise à jour du proxy échouée", error.message, true);
    return;
  }
  savedProxies = nextProxies;
  renderProxyList();
  setStatus(enabled ? "Proxy réactivé." : "Proxy désactivé; il sera ignoré par la rotation.");
}

function editProxy(id) {
  if (running) return;
  const proxy = savedProxies.find((item) => item.id === id);
  if (!proxy) return;
  editingProxyId = proxy.id;
  proxyHostInput.value = proxy.host;
  proxyPortInput.value = String(proxy.port);
  proxySchemeInput.value = proxy.scheme;
  proxyUsernameInput.value = proxy.username;
  proxyPasswordInput.value = proxy.password;
  proxyFormTitle.textContent = "Modifier le proxy";
  saveProxyButton.textContent = "Enregistrer les modifications";
  cancelProxyEditButton.hidden = false;
  proxyForm.scrollIntoView({ behavior: "smooth", block: "start" });
  proxyHostInput.focus();
  renderProxyList();
}

async function deleteProxy(id) {
  if (running) return;
  const proxy = savedProxies.find((item) => item.id === id);
  if (!proxy || !window.confirm(`Supprimer le proxy « ${proxyLabel(proxy)} » ?`)) return;
  const nextProxies = savedProxies.filter((item) => item.id !== id);
  try {
    await persistProxies(nextProxies);
    savedProxies = nextProxies;
    if (editingProxyId === id) clearProxyForm();
    renderProxyList();
    setStatus("Proxy supprimé.");
  } catch (error) {
    addLog("Suppression du proxy échouée", error.message, true);
  }
}

async function copyProxy(id) {
  const proxy = savedProxies.find((item) => item.id === id);
  if (!proxy) return;
  const line = proxyCredentialsLine(proxy);
  try {
    await navigator.clipboard.writeText(line);
    setStatus("Ligne host:port:user:pass copiée dans le presse-papiers.");
  } catch {
    setStatus(`Copie impossible; ligne du proxy : ${line}`);
  }
}

async function saveProxySettingsFromForm() {
  if (running) {
    renderProxySettings();
    return;
  }
  try {
    await persistProxySettings({
      ...proxySettings,
      useProxy: useRotatingProxyInput.checked,
      mode: proxyRotationModeInput.value,
      autoDisable: autoDisableProxyInput.checked,
    });
    renderProxyList();
    setStatus(proxySettings.useProxy
      ? "Rotation des proxys activée pour les prochains cycles."
      : "Rotation désactivée : le proxy Chrome existant sera utilisé.");
  } catch (error) {
    addLog("Réglages proxy non enregistrés", error.message, true);
  }
}

async function testProxy(id) {
  if (running) return;
  const proxy = savedProxies.find((item) => item.id === id);
  if (!proxy) return;
  setStatus(`Test du proxy ${proxyLabel(proxy)}…`);
  let recovery = null;
  const result = { ip: "", error: "" };
  try {
    const control = await chrome.proxy.settings.get({ incognito: false });
    if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(control.levelOfControl)) {
      throw new Error("Les paramètres proxy de Chrome sont contrôlés ailleurs.");
    }
    await chrome.storage.session.set({
      [PROXY_AUTH_SESSION_KEY]: {
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
      },
    });
    recovery = await activateRotatingProxy(proxy);
    const endpoint = `https://api.ipify.org?format=json&ts=${Date.now()}`;
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`Le service de test a répondu ${response.status}.`);
    const text = (await response.text()).trim();
    let address = text;
    try {
      const parsed = JSON.parse(text);
      address = String(parsed?.ip || text);
    } catch { /* réponse texte simple */ }
    if (!address) throw new Error("Aucune adresse IP renvoyée.");
    result.ip = address.slice(0, 80);
    // Nature de l'adresse : c'est le premier critère que regarde un site
    // protégé, avant même l'empreinte du navigateur.
    try {
      const asnInfo = await lookupIpAsn(result.ip);
      result.ipKind = asnInfo.kind;
      result.ipOrg = asnInfo.org || "";
      result.ipProvider = asnInfo.provider || "";
      result.ipAsn = asnInfo.asn || null;
    } catch { /* annuaire injoignable : la nature reste inconnue, le test reste valide */ }
  } catch (error) {
    result.error = String(error.message || "Test impossible.").slice(0, 200);
  } finally {
    if (recovery) {
      try { await restoreRotatingProxy(recovery); } catch (error) { addLog("Restauration du proxy après test échouée", error.message, true); }
    }
    try { await chrome.storage.session.remove(PROXY_AUTH_SESSION_KEY); } catch { /* session déjà fermée */ }
    if (recovery) {
      const control = await chromeCall(chrome.proxy.settings.get, { incognito: false }).catch(() => null);
      if (control && !["controllable_by_this_extension", "controlled_by_this_extension"].includes(control.levelOfControl)) {
        result.error = "Proxy de test restauré, mais Chrome ne rend pas le contrôle à l’extension.";
      }
    }
  }

  const nextProxies = savedProxies.map((item) => item.id === id
    ? {
      ...item,
      lastTestAt: new Date().toISOString(),
      lastTestIp: result.ip,
      lastTestError: result.error,
      ipKind: result.ipKind || item.ipKind || "",
      ipOrg: result.ipOrg || item.ipOrg || "",
      ipAsn: result.ipAsn || item.ipAsn || null,
      ipCheckedAt: result.ipKind ? new Date().toISOString() : (item.ipCheckedAt || ""),
      enabled: result.ip ? true : item.enabled,
      disabledReason: result.ip ? "" : item.disabledReason,
    }
    : item);
  try { await persistProxies(nextProxies); } catch { /* statistique non bloquante */ }
  savedProxies = nextProxies;
  renderProxyList();
  if (result.ip) {
    const kindLabel = result.ipKind ? InstaVAUtils.describeIpKind({ kind: result.ipKind, org: result.ipOrg, asn: result.ipAsn, provider: result.ipProvider }) : "nature d’IP non identifiée";
    setStatus(`Proxy ${proxyLabel(proxy)} fonctionnel · IP de sortie ${result.ip} · ${kindLabel}.`);
    const warning = result.ipKind === "datacenter"
      ? "\nUn hébergeur est mal noté par les sites protégés : attendez-vous à des vérifications plus fréquentes qu’avec un résidentiel."
      : "";
    addLog(`${proxyLabel(proxy)} · test réussi`, `IP de sortie observée : ${result.ip}\n${kindLabel}${warning}`, result.ipKind === "datacenter");
  } else {
    setStatus(`Proxy ${proxyLabel(proxy)} en échec : ${result.error}`);
    addLog(`${proxyLabel(proxy)} · test échoué`, result.error, true);
  }
}

/**
 * Interroge un annuaire d'ASN avec repli (ipinfo puis ipwho, tous deux sans
 * clé). Renvoie toujours un objet : nature « inconnue » si personne ne répond,
 * pour ne jamais bloquer un test de proxy sur un service tiers.
 */
async function lookupIpAsn(ip) {
  const address = String(ip || "").trim();
  if (!address) return InstaVAUtils.classifyIp({});
  const services = [
    {
      url: `https://ipinfo.io/${encodeURIComponent(address)}/json`,
      read: (data) => {
        const org = String(data?.org || "");
        const match = /^AS(\d+)\s+(.*)$/i.exec(org.trim());
        if (match) return { asn: Number(match[1]), org: match[2] };
        return org ? { asn: null, org } : null;
      },
    },
    {
      url: `https://ipwho.is/${encodeURIComponent(address)}`,
      read: (data) => {
        if (!data || data.success === false) return null;
        const asn = Number(data?.connection?.asn);
        const org = String(data?.connection?.org || data?.connection?.isp || "").trim();
        return (Number.isFinite(asn) && asn > 0) || org ? { asn: Number.isFinite(asn) && asn > 0 ? asn : null, org } : null;
      },
    },
  ];
  for (const service of services) {
    try {
      const response = await fetch(service.url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
      if (!response.ok) continue;
      const parsed = service.read(await response.json());
      if (parsed) return InstaVAUtils.classifyIp(parsed);
    } catch { /* service suivant */ }
  }
  return InstaVAUtils.classifyIp({});
}

function readInteger(raw, minimum, maximum, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} doit être un entier entre ${minimum} et ${maximum}.`);
  }
  return value;
}

function normalizeTargetUrl(raw) {
  let value = String(raw || "").trim();
  if (!value) throw new Error("Renseigne une URL cible.");
  if (value.startsWith("//")) value = `https:${value}`;
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    if (!/^https?:\/\//i.test(value)) throw new Error("Seules les URL HTTP(S) sont acceptées.");
  } else value = `https://${value}`;
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error("URL cible invalide."); }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Fournis une URL HTTP(S) valide, sans identifiants intégrés.");
  }
  return parsed.href;
}

async function persistTargets(targets = savedTargets) {
  await chrome.storage.local.set({ [STORAGE_KEY]: targets });
}

function editTarget(id) {
  if (running) return;
  const target = savedTargets.find((item) => item.id === id);
  if (!target) return;
  editingTargetId = target.id;
  targetPseudoInput.value = target.pseudo;
  targetUrlInput.value = target.url;
  targetLinkLabelInput.value = target.linkLabel;
  targetExecutionCountInput.value = String(target.executionTarget);
  targetDurationWeeksInput.value = String(target.durationDays);
  setTargetMode(target.mode);
  formTitle.textContent = "Modifier une cible";
  saveTargetButton.textContent = "Enregistrer les modifications";
  cancelEditButton.hidden = false;
  targetForm.scrollIntoView({ behavior: "smooth", block: "start" });
  targetPseudoInput.focus();
}

async function deleteTarget(id) {
  if (running) return;
  const target = savedTargets.find((item) => item.id === id);
  if (!target || !window.confirm(`Supprimer la cible « ${target.pseudo} » ?`)) return;
  const nextTargets = savedTargets.filter((item) => item.id !== id);
  try {
    await persistTargets(nextTargets);
    savedTargets = nextTargets;
    selectedTargetIds.delete(id);
    if (editingTargetId === id) clearTargetForm();
    renderTargetList();
    setStatus(`Cible « ${target.pseudo} » supprimée.`);
  } catch (error) {
    setStatus(`Échec de la suppression : ${error.message}`);
  }
}

function clearTargetForm() {
  editingTargetId = null;
  targetForm.reset();
  setTargetMode("interval");
  formTitle.textContent = "Ajouter une cible";
  saveTargetButton.textContent = "Enregistrer la cible";
  cancelEditButton.hidden = true;
}

async function applyCommonValue(field) {
  if (running) return;
  if (!savedTargets.length) {
    setStatus("Aucune cible à mettre à jour.");
    return;
  }
  const isCount = field === "executionTarget";
  try {
    let value;
    if (isCount) {
      value = parseTargetVisits(commonExecutionCountInput.value);
      if (value === null) throw new Error(`Nombre cible commun invalide : entier positif attendu (maximum ${MAX_TARGET_VISITS.toLocaleString("fr")}).`);
    } else {
      value = parseTargetDays(commonDurationWeeksInput.value);
      if (value === null) throw new Error(`Durée commune invalide : entier entre 1 et ${MAX_TARGET_DURATION_DAYS} attendu.`);
    }
    const nextTargets = savedTargets.map((target) => ({ ...target, [field]: value }));
    await persistTargets(nextTargets);
    savedTargets = nextTargets;
    if (editingTargetId) {
      const edited = savedTargets.find((target) => target.id === editingTargetId);
      if (edited) {
        if (isCount) targetExecutionCountInput.value = String(value);
        else targetDurationWeeksInput.value = String(value);
      }
    }
    renderTargetList();
    setStatus(isCount ? "Nombre cible appliqué à toutes les fiches." : "Durée appliquée à toutes les fiches.");
  } catch (error) {
    setStatus(`Échec de la mise à jour : ${error.message}`);
  }
}

async function startRun() {
  if (running) return;
  try { await restoreTemporaryProxyIfNeeded(); }
  catch (error) {
    setStatus(`Impossible de rétablir le proxy Chrome : ${error.message}`);
    return;
  }
  const selectedTargets = savedTargets.filter((target) => selectedTargetIds.has(target.id));
  if (!selectedTargets.length) {
    setStatus("Sélectionne au moins une cible enregistrée.");
    return;
  }

  let expectedVisits = 0;
  let proxyPool = null;
  try {
    for (const target of selectedTargets) {
      normalizeTargetUrl(target.url);
      const label = normalizeLinkLabelText(target.linkLabel);
      if (!label.ok) throw new Error(`Libellé du lien de « ${target.pseudo} » : ${label.message}`);
      if (parseTargetVisits(target.executionTarget) === null) {
        throw new Error(`Nombre de visites invalide pour « ${target.pseudo} » (entier positif, maximum ${MAX_TARGET_VISITS.toLocaleString("fr")}).`);
      }
      if (target.mode === "interval" && parseTargetDays(target.durationDays) === null) {
        throw new Error(`Durée invalide pour « ${target.pseudo} » (1 à ${MAX_TARGET_DURATION_DAYS} jours).`);
      }
      if (target.mode === "goal") {
        expectedVisits += target.executionTarget;
      } else {
        // Le mode intervalle tient au moins 100 clics/jour sur la durée choisie.
        expectedVisits += fitVisitsToRate(target.executionTarget, target.durationDays, MIN_SCHEDULE_INTERVAL_MS).count;
      }
    }
    // Aucun plafond de visites : on informe simplement pour les grosses sélections.
    if (expectedVisits > 500) {
      addLog("Sélection importante", `${expectedVisits.toLocaleString("fr")} visite(s) au total. Le panneau doit rester ouvert pendant toute la série; tu peux l’arrêter à tout moment.`);
    }
    if (proxySettings.useProxy) {
      const enabledProxies = savedProxies.filter((proxy) => proxy.enabled);
      // Une liste vide ne doit pas empêcher de travailler : on retombe sur le proxy Chrome.
      if (!enabledProxies.length) {
        addLog(
          "Aucun proxy actif",
          "La rotation est cochée mais la liste ne contient aucun proxy actif : les cycles utilisent le réglage proxy de Chrome.",
          savedProxies.length > 0,
        );
      }
      for (const proxy of enabledProxies) {
        const validation = validateProxyEntry(proxy);
        if (!validation.ok) throw new Error(`Proxy invalide (${proxyLabel(proxy)}) : ${validation.message}`);
      }
      if (enabledProxies.length) {
        proxyPool = {
          mode: proxySettings.mode,
          cursor: proxySettings.cursor,
          autoDisable: proxySettings.autoDisable,
          list: enabledProxies.map((proxy) => ({ ...proxy })),
        };
      }
    }
  } catch (error) {
    setStatus(error.message);
    return;
  }

  running = true;
  stopRequested = false;
  setConfigurationDisabled(true);
  startButton.disabled = true;
  stopButton.disabled = false;
  logNode.replaceChildren();
  ocrTextNode.textContent = "L’OCR local vérifiera le lien à cliquer pendant chaque cycle.";

  let totalFailures = 0;
  let totalBlocked = 0;
  let completedRuns = 0;
  let totalRuns = 0;
  const dailyJournal = await loadDailyJournal();
  try {
    if (proxyPool) {
      const proxyControl = await chrome.proxy.settings.get({ incognito: false });
      if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(proxyControl.levelOfControl)) {
        throw new Error("Les paramètres proxy de Chrome sont contrôlés ailleurs ou indisponibles; aucun onglet ne sera ouvert.");
      }
      addLog(
        "Proxys Webshare prêts",
        `${proxyPool.list.length} proxy(s) actif(s), rotation ${proxyPool.mode === "random" ? "au hasard" : "dans l’ordre"}. Un proxy différent est appliqué à chaque cycle; ${proxyPool.autoDisable ? `il est désactivé après ${MAX_CONSECUTIVE_FAILURES} échecs consécutifs` : "les échecs ne désactivent rien"}.`,
      );
    } else {
      await chrome.storage.session.remove(PROXY_AUTH_SESSION_KEY);
      addLog("Proxy Webshare désactivé", "Les cycles utiliseront le réglage proxy actuellement configuré dans Chrome.");
    }
    const focusedTabs = await chromeCall(chrome.tabs.query, { active: true, lastFocusedWindow: true });
    const windowId = focusedTabs[0]?.windowId;
    const startAt = Date.now();
    const plans = selectedTargets.map((target, order) => createTargetPlan(target, startAt, order));
    totalRuns = plans.reduce((sum, plan) => sum + plan.count, 0);
    for (const plan of plans) {
      addLog(`Planifiée · ${plan.target.pseudo}`, `${plan.count.toLocaleString("fr")} cycle(s) — ${describeTargetPlan({ ...plan.target, executionTarget: plan.count })}`);
    }

    while (!stopRequested) {
      const pending = plans
        .filter((plan) => plan.nextIndex < plan.count)
        .map((plan) => ({ plan, dueAt: getNextDueAt(plan) }))
        .sort((a, b) => a.dueAt - b.dueAt || a.plan.order - b.plan.order);
      if (!pending.length) break;
      const { plan, dueAt } = pending[0];
      const runNumber = plan.nextIndex + 1;
      if (dueAt > Date.now()) await waitUntil(dueAt, plan.target.pseudo, runNumber, plan.count);
      if (stopRequested) break;

      // Journal quotidien : garantit au moins 100 clics par jour sur la durée.
      if (!plan.batch) {
        const targetForToday = rollPlanToToday(plan, dailyJournal);
        if (!needsMoreToday({
          doneToday: plan.doneToday,
          plannedToday: plan.plannedToday,
          minimumToday: plan.minimumToday,
          backlog: plan.backlog,
        })) {
          // Objectif du jour atteint : on attend le lendemain pour la suite du plan.
          const tomorrow = Date.parse(dayKey(Date.now()) + "T00:00:00Z") + DAY_MS;
          await waitUntil(tomorrow + MIN_SCHEDULE_INTERVAL_MS, plan.target.pseudo, runNumber, plan.count);
          if (stopRequested) break;
          continue;
        }
        // Recalage de l'horaire si le retard impose des clics supplémentaires.
        if (plan.doneToday >= plan.plannedToday && plan.nextIndex < plan.count) {
          const topUpAt = plan.lastRunFinishedAt ? plan.lastRunFinishedAt + MIN_SCHEDULE_INTERVAL_MS : Date.now();
          if (topUpAt > Date.now()) await waitUntil(topUpAt, plan.target.pseudo, runNumber, plan.count);
          if (stopRequested) break;
        }
        void targetForToday;
      }

      let proxy = null;
      if (proxyPool) {
        const picked = pickProxy(proxyPool.list, { mode: proxyPool.mode, cursor: proxyPool.cursor });
        proxyPool.cursor = picked.cursor;
        proxy = picked.proxy;
        if (!proxy) {
          addLog("Aucun proxy disponible", "Tous les proxys de la liste sont désactivés; le cycle utilise le réglage proxy de Chrome.", true);
        }
      }

      // Mode objectif : une seule confirmation pour tout le lot.
      if (plan.batch && plan.batchApproval === null && planRequiresConfirmation(plan)) {
        const label = plan.target.linkLabel;
        const approved = await askConfirmation(
          `Mode objectif · ${plan.target.pseudo}\n${plan.count.toLocaleString("fr")} visite(s) vont s’enchaîner sur ${plan.target.url}\n` +
          `Lien : ${label ? `« ${label} »` : "choisi automatiquement (lien principal de la page)"}.\n` +
          "Une seule validation couvre toute la série.",
        );
        plan.batchApproval = approved ? "granted" : "declined";
        if (!approved) {
          addLog(`${plan.target.pseudo} · série annulée`, `${plan.count} visite(s) annulée(s) avant le premier clic.`);
          plan.nextIndex = plan.count;
          continue;
        }
        addLog(`${plan.target.pseudo} · lot validé`, `${plan.count.toLocaleString("fr")} visite(s) confirmée(s) en une fois.`);
      }
      if (plan.batch && plan.batchApproval === "declined") {
        plan.nextIndex = plan.count;
        continue;
      }

      addLog(
        `${plan.target.pseudo} · exécution ${runNumber}/${plan.count}`,
        `Début : ${new Date().toLocaleString()}${proxy ? `\nProxy : ${proxyLabel(proxy)}` : ""}`,
      );
      let outcome = { status: "skipped" };
      try {
        outcome = await executeTargetRun(plan.target, runNumber, plan.count, windowId, proxy, proxyPool, {
          skipConfirm: plan.batch && plan.batchApproval === "granted",
        });
      } catch (error) {
        if (stopRequested) break;
        totalFailures += 1;
        outcome = {
          status: "failed",
          error: error.proxyError || error.message,
          active: Boolean(error.proxyActive),
        };
        addLog(`${plan.target.pseudo} · exécution en erreur`, error.message, true);
      }
      if (outcome.status === "blocked" || outcome.status === "challenged") totalBlocked += 1;
      if (proxy) await recordProxyOutcome(proxy, outcome, proxyPool);
      if (stopRequested) break;
      if (!plan.batch) {
        // Un cycle exécuté compte comme un clic du jour, même sans clic effectif.
        const today = dayKey(Date.now());
        dailyJournal[today] = (dailyJournal[today] || 0) + 1;
        plan.doneToday = dailyJournal[today];
        await saveDailyJournal(dailyJournal);
      }
      plan.lastRunFinishedAt = Date.now();
      // Mode objectif : les visites s'enchaînent avec une pause courte et variable.
      if (plan.batch) plan.nextDelayMs = nextVisitDelayMs(DEFAULT_VISIT_INTERVAL_MS, randomUnit);
      plan.nextIndex += 1;
      completedRuns += 1;
    }

    const blockedNote = totalBlocked
      ? ` · ${totalBlocked} page(s) bloquée(s) ou vérifiée(s) (le proxy n’est pas tenu pour responsable)`
      : "";
    if (stopRequested) setStatus(`Traitement arrêté après ${completedRuns}/${totalRuns} exécution(s)${blockedNote}.`);
    else if (totalFailures) setStatus(`Terminé avec ${totalFailures} erreur(s) sur ${completedRuns} exécution(s)${blockedNote}.`);
    else setStatus(`Terminé : ${completedRuns} exécution(s) sur ${selectedTargets.length} cible(s)${blockedNote}.`);
  } catch (error) {
    if (stopRequested) setStatus(`Traitement arrêté après ${completedRuns}/${totalRuns} exécution(s).`);
    else {
      setStatus(`Erreur de planification : ${error.message}`);
      addLog("Erreur", error.message, true);
    }
  } finally {
    await shutdownOcrWorker("fin de série");
    try { await chrome.storage.session.remove(PROXY_AUTH_SESSION_KEY); }
    catch (error) { addLog("Nettoyage des identifiants proxy échoué", error.message, true); }
    if (proxyPool) {
      proxyPool.list.forEach((proxy) => {
        proxy.username = "";
        proxy.password = "";
      });
      try {
        await persistProxySettings({ ...proxySettings, cursor: proxyPool.cursor });
      } catch (error) {
        addLog("Curseur de rotation non enregistré", error.message, true);
      }
    }
    proxyUsernameInput.value = "";
    proxyPasswordInput.value = "";
    activeTabId = null;
    running = false;
    setConfigurationDisabled(false);
    stopButton.disabled = true;
    renderProxyList();
    updateSelectionSummary();
  }
}

/**
 * Enregistre l'issue du cycle sur le proxy concerné (compteurs, échecs consécutifs,
 * désactivation automatique) et rafraîchit la liste affichée.
 */
async function recordProxyOutcome(proxy, outcome, proxyPool) {
  const entry = proxyPool.list.find((item) => item.id === proxy.id);
  if (!entry) return;
  // Cycle échoué avant toute application du proxy (OCR, onglet, arrêt) :
  // rien à imputer au proxy.
  if (outcome.active === false) return;
  const updated = applyProxyOutcome(entry, outcome, {
    autoDisable: proxyPool.autoDisable,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
  });
  Object.assign(entry, updated);
  savedProxies = savedProxies.map((item) => item.id === entry.id ? { ...entry } : item);
  renderProxyList();
  if (outcome.status === "success") {
    addLog(`Proxy ${proxyLabel(proxy)} · cycle réussi`, `${entry.successes} succès · ${entry.failures} échec(s) pour ${entry.uses} cycle(s).`);
  } else if (outcome.status === "failed" && entry.enabled === false) {
    addLog(`Proxy ${proxyLabel(proxy)} désactivé`, `${entry.disabledReason} Il reste ${savedProxies.filter((item) => item.enabled).length} proxy(s) actif(s).`, true);
  } else if (outcome.status === "failed") {
    addLog(`Proxy ${proxyLabel(proxy)} · échec ${entry.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`, String(outcome.error || "Échec du cycle."));
  }
  try {
    await persistProxies();
  } catch (error) {
    addLog("Statistiques proxy non enregistrées", error.message, true);
  }
}

/**
 * Mode intervalle : visites réparties sur la durée (tirage ±10).
 * Mode objectif : exactement le nombre cible, enchaîné en un seul lot, sans durée.
 */
function createTargetPlan(target, startAt, order) {
  const mode = normalizeTargetMode(target.mode);
  const batch = mode === "goal";
  if (batch) {
    const count = planVisits("goal", target.executionTarget);
    return {
      target: { ...target, mode },
      count,
      batch,
      batchApproval: null,
      runTimes: Array.from({ length: count }, () => startAt),
      nextIndex: 0,
      lastRunFinishedAt: 0,
      order,
    };
  }

  const days = parseTargetDays(target.durationDays) || DEFAULT_TARGET_DAYS;
  const fitted = fitVisitsToRate(target.executionTarget, days, MIN_SCHEDULE_INTERVAL_MS);
  return {
    target: { ...target, mode },
    count: fitted.count,
    requested: fitted.requested,
    adjusted: fitted.adjusted,
    minimum: fitted.minimum,
    maximum: fitted.maximum,
    batch: false,
    batchApproval: null,
    runTimes: buildDailyRunTimes(fitted.count, days, startAt, {
      minimumGapMs: MIN_SCHEDULE_INTERVAL_MS,
      random: randomUnit,
    }),
    days,
    // Rythme minimum garanti : au moins 100 clics par jour sur la durée.
    plannedToday: Math.max(fitted.count / days, MIN_VISITS_PER_DAY),
    minimumToday: MIN_VISITS_PER_DAY,
    dayQuota: dailyVisitQuota(fitted.count, days),
    quotaEnd: dailyVisitQuota(fitted.count, days)[0] || 0,
    dayIndex: 0,
    todayKey: dayKey(startAt),
    doneToday: 0,
    backlog: 0,
    journal: {},
    nextIndex: 0,
    lastRunFinishedAt: 0,
    order,
  };
}

function getNextDueAt(plan) {
  if (plan.batch) {
    if (plan.nextIndex === 0) return plan.runTimes[0];
    return plan.lastRunFinishedAt + plan.nextDelayMs;
  }
  const plannedTime = plan.runTimes[Math.min(plan.nextIndex, plan.runTimes.length - 1)];
  const earliest = plan.nextIndex === 0 ? plannedTime : plan.lastRunFinishedAt + MIN_SCHEDULE_INTERVAL_MS;
  // Tant que le quota du jour n'est pas atteint, on reste dans la journée visée.
  if (plan.nextIndex < plan.quotaEnd) {
    const milestone = plan.runTimes[plan.quotaEnd];
    return Math.min(Math.max(plannedTime, earliest), milestone);
  }
  return Math.max(plannedTime, earliest);
}

/**
 * En mode objectif, un même lot cliquerait le même lien des centaines de fois :
 * on demande une seule confirmation pour toute la série au lieu d'une par visite.
 */
function planRequiresConfirmation(plan) {
  return confirmClicksInput.checked || isSensitiveLabel(plan.target.linkLabel || "");
}

async function executeTargetRun(target, runIndex, runCount, windowId, proxy, proxyPool, options = {}) {
  // L'OCR est un contrôle complémentaire : s'il ne démarre pas, le cycle continue
  // avec la seule détection DOM exacte du libellé.
  let ocrReady = true;
  try {
    await ensureOcrWorker(languageInput.value);
  } catch (error) {
    ocrReady = false;
    addLog("OCR local indisponible", `${error.message} Le cycle continue avec la vérification DOM du libellé.`, true);
    await shutdownOcrWorker("erreur", `OCR en échec : ${error.message}`);
  }
  return processTarget(target, runIndex, runCount, windowId, proxy, proxyPool, ocrReady, options);
}

/** Charge le journal de clics (une entrée par jour) depuis le stockage local. */
async function loadDailyJournal() {
  try {
    const stored = await chrome.storage.local.get(DAILY_JOURNAL_KEY);
    return pruneDailyJournal(stored?.[DAILY_JOURNAL_KEY], DAILY_JOURNAL_KEEP_DAYS);
  } catch {
    return {};
  }
}

async function saveDailyJournal(journal) {
  try {
    await chrome.storage.local.set({ [DAILY_JOURNAL_KEY]: pruneDailyJournal(journal, DAILY_JOURNAL_KEEP_DAYS) });
  } catch (error) {
    addLog("Journal quotidien non enregistré", error.message, true);
  }
}

/**
 * Passe le plan à la journée courante : avance les quotas et calcule le retard
 * (jours précédents sous 100 clics). Retourne l'objectif de clics du jour.
 */
function rollPlanToToday(plan, journal, now = Date.now()) {
  const today = dayKey(now);
  const todayDone = journal[today] || 0;
  if (plan.todayKey === today) {
    plan.doneToday = todayDone;
    plan.backlog = 0;
    return dailyClickTarget({ doneToday: todayDone, plannedToday: plan.plannedToday, minimumToday: plan.minimumToday, backlog: 0 });
  }

  // Nouvelle journée : avance d'autant de jours que nécessaire.
  let guard = 0;
  while (plan.todayKey !== today && guard < 400) {
    plan.todayKey = dayKey(Date.parse(plan.todayKey + "T00:00:00Z") + DAY_MS);
    plan.dayIndex += 1;
    plan.doneToday = 0;
    guard += 1;
  }
  // Quota cumulé jusqu'à la journée courante (le plan ne dépasse pas sa durée).
  const cumulative = plan.dayQuota.slice(0, Math.min(plan.dayIndex + 1, plan.dayQuota.length))
    .reduce((sum, value) => sum + value, 0);
  plan.quotaEnd = Math.min(cumulative, plan.count);
  // Retard : jours écoulés sous le minimum de 100 clics.
  const elapsed = Math.min(plan.dayIndex + 1, plan.days);
  const expected = plan.minimumToday * elapsed;
  plan.backlog = Math.max(0, expected - cumulative);
  plan.doneToday = todayDone;
  return dailyClickTarget({
    doneToday: todayDone,
    plannedToday: plan.plannedToday,
    minimumToday: plan.minimumToday,
    backlog: plan.backlog,
  });
}

async function waitUntil(dueAt, pseudo, runNumber, runCount) {
  while (!stopRequested && Date.now() < dueAt) {
    const remaining = dueAt - Date.now();
    setStatus(`${pseudo} · exécution ${runNumber}/${runCount} dans ${formatDuration(remaining)}.`);
    await delay(Math.min(30000, remaining));
  }
}

function formatDuration(milliseconds) {
  const totalMinutes = Math.ceil(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days} j` : "", hours ? `${hours} h` : "", `${minutes} min`].filter(Boolean).join(" ");
}

function randomUnit() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] + 1) / 4294967297;
}

function setConfigurationDisabled(disabled) {
  runConfigurationInputs.forEach((input) => { input.disabled = disabled; });
  proxyImportForm.querySelectorAll("textarea").forEach((element) => { element.disabled = disabled; });
  for (const button of [saveProxyButton, cancelProxyEditButton, clearProxiesButton]) button.disabled = disabled;
  proxyListNode.querySelectorAll("input, button").forEach((element) => { element.disabled = disabled; });
  for (const button of [cancelEditButton, selectAllTargetsButton, clearSelectionButton, applyCountToAllButton, applyDurationToAllButton, saveTargetButton]) {
    button.disabled = disabled;
  }
  targetListNode.querySelectorAll("input, button").forEach((element) => { element.disabled = disabled; });
  if (!disabled) {
    selectAllTargetsButton.disabled = savedTargets.length === 0;
    applyCountToAllButton.disabled = savedTargets.length === 0;
    applyDurationToAllButton.disabled = savedTargets.length === 0;
    renderProxyList();
  }
}

/**
 * Un cycle complet. `proxy` est le proxy Webshare tiré pour ce cycle (ou null).
 * Le retour `{ status }` alimente les statistiques du proxy :
 *  - "success"  : le clic et la redirection ont abouti via ce proxy
 *  - "failed"   : la navigation via ce proxy a échoué
 *  - "skipped"  : pas de clic (lien absent, ambigu ou ignoré) : le proxy n'est pas mis en cause
 */
async function processTarget(target, runIndex, runCount, windowId, proxy, proxyPool, ocrReady = true, options = {}) {
  const url = target.url;
  const useProxy = Boolean(proxy);
  setStatus(`${target.pseudo} · exécution ${runIndex}/${runCount} · ouverture${useProxy ? ` via ${proxyLabel(proxy)}` : ""}…`);
  let tab;
  let attached = false;
  let redirectCount = 0;
  const childTabIds = [];
  const monitoredTabIds = new Set();
  let proxyActive = false;
  let proxyRecovery = null;
  let clicked = false;
  let failure = null;
  let proxyApplied = false;
  let proxyActivationAttempted = false;
  const redirectListener = (details) => {
    if (!monitoredTabIds.has(details.tabId) || details.frameId !== 0) return;
    if ((details.transitionQualifiers || []).some((item) => item.includes("redirect"))) redirectCount += 1;
  };

  try {
    const createProperties = { url: "about:blank", active: true };
    if (windowId !== undefined) createProperties.windowId = windowId;
    tab = await chromeCall(chrome.tabs.create, createProperties);
    activeTabId = tab.id;
    monitoredTabIds.add(tab.id);
    chrome.webNavigation.onCommitted.addListener(redirectListener);

    await chromeCall(chrome.debugger.attach, { tabId: tab.id }, "1.3");
    attached = true;
    await sendCDP(tab.id, "Page.enable");
    await sendCDP(tab.id, "Emulation.setDeviceMetricsOverride", {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
    });

    // Le proxy reste actif pendant toute la navigation, le clic et la redirection.
    if (useProxy) {
      proxyActivationAttempted = true;
      await chrome.storage.session.set({
        [PROXY_AUTH_SESSION_KEY]: {
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
        },
      });
      proxyRecovery = await activateRotatingProxy(proxy);
      proxyActive = true;
      proxyApplied = true;
      if (stopRequested) return { status: "skipped", proxyActive: false };
      addLog(`${target.pseudo} · proxy actif`, `Le proxy ${proxyLabel(proxy)} route l’ouverture, le clic et la redirection.`);
    }

    let navigationFinished = false;
    const observer = observeDuringLoad(tab.id, () => navigationFinished);
    const completed = waitForComplete(tab.id, 35000);
    try {
      await chromeCall(chrome.tabs.update, tab.id, { url });
      await completed;
    } finally {
      navigationFinished = true;
      await observer;
    }

    let finalTab = await waitForStableUrl(tab.id);
    currentUrlNode.textContent = finalTab.url || url;
    const redirectText = redirectCount ? `${redirectCount} redirection(s)` : "aucune redirection détectée";
    addLog(`${target.pseudo} · arrivée sur l’URL`, `${url}\n→ ${finalTab.url || url}\n${redirectText}${finalTab.title ? ` · ${finalTab.title}` : ""}`);

    // Page de blocage ou vérification anti-bot : l'onglet est fermé tout de
    // suite et le cycle est marqué « bloqué ». Un 1020 ne dit rien de la
    // qualité du proxy et ne doit jamais le faire désactiver.
    const gate = await readPageGate(tab.id);
    if (gate) {
      const isHardBlock = gate.kind === "blocked";
      addLog(
        `${target.pseudo} · ${isHardBlock ? "blocage du site (1020)" : "vérification anti-bot"}`,
        isHardBlock
          ? `Le site refuse purement cette connexion (${gate.reason}). Ce n’est pas une vérification en cours : rien ne se débloquera en attendant. `
            + "La fenêtre est fermée et la série continue. Un proxy résidentiel est la seule marge de manœuvre."
          : `Page de vérification affichée (${gate.reason}). La fenêtre est fermée et la série continue.`,
        true,
      );
      return { status: isHardBlock ? "blocked" : "challenged", gate, proxyActive };
    }

    const label = target.linkLabel;
    const activePageTabId = tab.id;
    setStatus(`${target.pseudo} · vérification du lien exact…`);
    const screenshot = await captureScreen(activePageTabId);
    renderScreenshot(screenshot);
    let ocrResult = { text: "", words: [], width: 0, height: 0 };
    if (ocrReady) {
      try {
        ocrResult = await readScreen(screenshot);
        showOcrText(ocrResult.text);
        addLog(`${target.pseudo} · texte reconnu`, ocrResult.text ? excerpt(ocrResult.text, 700) : "Aucun texte détecté.");
      } catch (error) {
        // L'OCR ne bloque pas le cycle : la détection DOM exacte reste la référence.
        addLog(`${target.pseudo} · OCR indisponible`, error.message, true);
        await shutdownOcrWorker("erreur", `OCR en échec : ${error.message}`);
      }
    }

    let match;
    if (label) {
      const matches = await findExactClickables(activePageTabId, label);
      if (!matches.length) {
        addLog(`${target.pseudo} · libellé introuvable`, `Aucun lien ni bouton visible dont le libellé complet correspond à « ${label} ». Aucun clic effectué.`, true);
        return { status: "skipped", proxyActive };
      }
      if (matches.length > 1) {
        addLog(`${target.pseudo} · libellés identiques`, `${matches.length} éléments visibles (liens ou boutons) portent le libellé complet « ${label} ». Aucun clic effectué pour éviter une sélection ambiguë.`, true);
        return { status: "skipped", proxyActive };
      }
      match = matches[0];
    } else {
      // Aucun libellé : on clique sans critère de texte.
      const primary = await findPrimaryLink(activePageTabId);
      if (!primary.picked) {
        addLog(`${target.pseudo} · aucun élément cliquable`, "La page chargée ne contient aucun lien ni bouton visible. Aucun clic effectué.", true);
        return { status: "skipped", proxyActive };
      }
      match = primary.picked;
      addLog(
        `${target.pseudo} · cible choisie automatiquement`,
        `${primary.links.length} élément(s) cliquable(s) → ${primary.picked.reason} : ${primary.picked.text ? `« ${primary.picked.text} »` : "sans texte"}${primary.picked.href ? `\n→ ${primary.picked.href}` : ""}`
        + (primary.picked.bioLink ? "\nLien en bio reconnu : il passe devant les boutons d’action du profil." : ""),
      );
    }
    const ocrPhrase = findOcrPhrase(ocrResult.words, label);
    if (ocrPhrase) {
      // La capture est prise dans le même viewport émulé : même échelle que les coordonnées DOM.
      const scaleX = ocrResult.width ? ocrResult.width / VIEWPORT.width : 1;
      const scaleY = ocrResult.height ? ocrResult.height / VIEWPORT.height : 1;
      const distance = Math.hypot(ocrPhrase.x / scaleX - match.x, ocrPhrase.y / scaleY - match.y);
      addLog(
        `${target.pseudo} · OCR concordant`,
        `« ${label} » retrouvé dans la capture (confiance ${Math.round(ocrPhrase.confidence)} %), à ${Math.round(distance)} px du lien DOM.`,
        distance > 160,
      );
    } else if (ocrResult.words.length) {
      addLog(`${target.pseudo} · OCR sans correspondance`, `Le libellé « ${label} » n’a pas été relu dans la capture; la détection DOM exacte est conservée.`);
    }
    const kind = match.type || "lien";
    const description = label
      ? `Cible : ${target.pseudo}\nCliquer une fois sur le ${kind} « ${label} »${match.href ? ` (${match.href})` : ""}.`
      : `Cible : ${target.pseudo}\nCliquer une fois sur le ${kind} choisi automatiquement${match.text ? ` : « ${match.text} »` : ""}${match.href ? ` (${match.href})` : ""}.`;
    const sensitive = isSensitiveLabel(label);
    const needsConfirm = (confirmClicksInput.checked || sensitive) && !options.skipConfirm;
    if (needsConfirm && !(await askConfirmation(description))) {
      addLog(`${target.pseudo} · clic ignoré`, `${kind} « ${label || match.text || ""} »`);
      return { status: "skipped", proxyActive };
    }
    if (stopRequested) return { status: "skipped", proxyActive };

    const redirectsBeforeClick = redirectCount;
    const openedTabPromise = waitForOpenedTab(activePageTabId, (childTab) => {
      childTabIds.push(childTab.id);
      monitoredTabIds.add(childTab.id);
    });
    await clickAt(activePageTabId, match.x, match.y);
    clicked = true;
    const openedTab = await openedTabPromise;
    addLog(`${target.pseudo} · ${kind} cliqué`, `« ${label || match.text || ""} »${match.href ? ` → ${match.href}` : ""}`);
    if (openedTab) {
      activeTabId = openedTab.id;
      finalTab = await waitForStableUrl(openedTab.id, false);
    } else {
      await waitForStableUrl(activePageTabId);
      finalTab = await chromeCall(chrome.tabs.get, activePageTabId);
    }
    // Lien en bio Instagram : Instagram redirige vers l.instagram.com/?u=… au
    // lieu de la destination. Sans ce décodage, la bio n'est jamais visitée.
    const unwrapped = InstaVAUtils.unwrapRedirectUrl(finalTab.url || "");
    if (unwrapped && unwrapped !== finalTab.url && /^https?:/i.test(unwrapped)) {
      addLog(`${target.pseudo} · lien en bio décodé`, `Le redirecteur masquait la destination : ${unwrapped}`);
      try {
        await chromeCall(chrome.tabs.update, (openedTab || tab).id, { url: unwrapped });
        finalTab = await waitForStableUrl((openedTab || tab).id, false);
        currentUrlNode.textContent = finalTab.url || unwrapped;
      } catch (error) {
        addLog(`${target.pseudo} · destination inaccessible`, error.message, true);
      }
    }
    currentUrlNode.textContent = finalTab.url || "";
    const redirectsAfterClick = redirectCount - redirectsBeforeClick;
    addLog(
      `${target.pseudo} · redirection après clic`,
      `${redirectsAfterClick ? `${redirectsAfterClick} redirection(s)` : "URL stabilisée sans redirection détectée"}\n→ ${finalTab.url || "URL inconnue"}${openedTab ? " · nouvel onglet temporaire" : ""}`,
    );
    if (!openedTab) {
      try { renderScreenshot(await captureScreen(activePageTabId)); } catch { /* la page peut se fermer pendant la navigation */ }
    }
    if (!stopRequested) addLog(`${target.pseudo} · cycle terminé`, "Lien cliqué et redirection attendue.");
    return { status: "success", proxyActive };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (proxyRecovery || proxyActive) {
      try {
        const restored = await restoreTemporaryProxyIfNeeded(proxyRecovery);
        proxyRecovery = null;
        if (restored) addLog(`${target.pseudo} · proxy restauré`, "Les paramètres proxy précédents de Chrome ont été rétablis.");
      } catch (error) {
        addLog("Le proxy Chrome doit être restauré", error.message, true);
      }
    }
    chrome.webNavigation.onCommitted.removeListener(redirectListener);
    for (const childTabId of childTabIds) {
      try { await chromeCall(chrome.tabs.remove, childTabId); } catch { /* onglet déjà fermé */ }
    }
    if (tab && attached) {
      try { await chromeCall(chrome.debugger.detach, { tabId: tab.id }); } catch { /* déjà détaché */ }
    }
    if (tab) {
      try { await chromeCall(chrome.tabs.remove, tab.id); } catch { /* onglet déjà fermé */ }
    }
    activeTabId = null;
    currentUrlNode.textContent = "Onglet fermé";
    if (failure && useProxy) {
      // Attribution : une activation impossible ou un échec avant le clic (page non
      // chargée, tunnel refusé) est imputé au proxy. Après le clic, l'échec n'est
      // imputé au proxy que si le message trahit un problème réseau/proxy.
      const blameProxy = !proxyApplied
        ? proxyActivationAttempted
        : (!clicked || errorLooksLikeProxyFailure(failure));
      failure.proxyActive = blameProxy;
      if (blameProxy) failure.proxyError = String(failure.message || "Échec du cycle.").slice(0, 200);
    }
  }
}

function errorLooksLikeProxyFailure(error) {
  return /ERR_PROXY|ERR_TUNNEL|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|proxy/i
    .test(String(error && error.message ? error.message : error));
}

async function activateRotatingProxy(config) {
  const pending = await chrome.storage.local.get(PROXY_RECOVERY_KEY);
  if (pending?.[PROXY_RECOVERY_KEY]) await restoreRotatingProxy(pending[PROXY_RECOVERY_KEY]);
  const previous = await chrome.proxy.settings.get({ incognito: false });
  if (!["controllable_by_this_extension", "controlled_by_this_extension"].includes(previous.levelOfControl)) {
    throw new Error("Les paramètres proxy de Chrome sont contrôlés ailleurs ou indisponibles; le gateway Webshare n’a pas été activé.");
  }
  const recovery = {
    restoreWithSet: previous.levelOfControl === "controlled_by_this_extension",
    previousValue: previous.value,
  };
  await chrome.storage.local.set({ [PROXY_RECOVERY_KEY]: recovery });
  if (stopRequested) {
    await chrome.storage.local.remove(PROXY_RECOVERY_KEY);
    throw new Error("Activation du proxy annulée car l’arrêt a été demandé.");
  }
  try {
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: { singleProxy: { scheme: config.scheme, host: config.host, port: config.port } },
      },
      scope: "regular",
    });
    const applied = await chrome.proxy.settings.get({ incognito: false });
    const server = applied.value?.rules?.singleProxy;
    if (applied.levelOfControl !== "controlled_by_this_extension" ||
        applied.value?.mode !== "fixed_servers" || server?.host !== config.host || server?.port !== config.port ||
        (server?.scheme ?? "http") !== config.scheme) {
      throw new Error("Chrome n’a pas confirmé l’application du gateway proxy configuré.");
    }
    return recovery;
  } catch (error) {
    try { await restoreRotatingProxy(recovery); }
    catch (restoreError) {
      throw new Error(`${error.message} La restauration des réglages précédents a aussi échoué : ${restoreError.message}`);
    }
    throw error;
  }
}

async function restoreRotatingProxy(recovery) {
  if (recovery.restoreWithSet) {
    await chrome.proxy.settings.set({ value: recovery.previousValue, scope: "regular" });
  } else {
    await chrome.proxy.settings.clear({ scope: "regular" });
  }
  await chrome.storage.local.remove(PROXY_RECOVERY_KEY);
}

async function restoreTemporaryProxyIfNeeded(recovery = null) {
  let pendingRecovery = recovery;
  if (!pendingRecovery) {
    const result = await chrome.storage.local.get(PROXY_RECOVERY_KEY);
    pendingRecovery = result?.[PROXY_RECOVERY_KEY] || null;
  }
  if (!pendingRecovery) return false;
  await restoreRotatingProxy(pendingRecovery);
  return true;
}

function waitForOpenedTab(openerTabId, onOpened, timeoutMs = 900) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (tab) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onCreated.removeListener(onCreated);
      resolve(tab);
    };
    const onCreated = (tab) => {
      if (tab.openerTabId !== openerTabId) return;
      onOpened?.(tab);
      finish(tab);
    };
    chrome.tabs.onCreated.addListener(onCreated);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Lit le titre et un extrait du document pour reconnaître une page de blocage
 * (1020) ou de vérification. Ne lève jamais : une page illisible n'est pas un
 * blocage.
 */
async function readPageGate(tabId) {
  try {
    const result = await sendCDP(tabId, "Runtime.evaluate", {
      expression: `(() => ({
        title: document.title || "",
        html: document.documentElement ? document.documentElement.outerHTML.slice(0, 20000) : "",
      }))()`,
      returnByValue: true,
    });
    const snapshot = result.result?.value;
    if (!snapshot) return null;
    return InstaVAUtils.detectPageGate(snapshot);
  } catch {
    return null;
  }
}

/** Sélecteur commun : liens + boutons/boutons-liens réellement cliquables. */
const CLICKABLE_SELECTOR = 'a[href], [role="link"], button, input[type="button"], input[type="submit"], [role="button"], summary';

function clickableHelpersSource() {
  return `
    const normalize = (value) => String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("fr")
      .replace(/\s+/g, " ")
      .trim();
    const labelOf = (element) => {
      if (element instanceof HTMLInputElement) return element.value || element.getAttribute("aria-label") || "";
      const visibleText = String(element.innerText || "").replace(/\s+/g, " ").trim();
      return visibleText || element.getAttribute("aria-label") || element.getAttribute("title") || "";
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 ||
          rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (style.pointerEvents === "none" || element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
      return true;
    };
    const kindOf = (element) => {
      if (element.tagName === "A" || element.getAttribute("role") === "link") return "lien";
      if (element.tagName === "SUMMARY") return "résumé";
      return "bouton";
    };
    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const rawHref = element instanceof HTMLAnchorElement ? (element.href || "") : "";
      return {
        index: Number(element.dataset.instavaIndex),
        x: (left + right) / 2,
        y: (top + bottom) / 2,
        href: rawHref,
        text: labelOf(element).slice(0, 160),
        type: kindOf(element),
        area: (right - left) * (bottom - top),
        tagName: element.tagName,
        hasClickHandler: typeof element.onclick === "function" ||
          element.hasAttribute("onclick") || element.getAttribute("tabindex") !== null,
        isControl: element.tagName === "BUTTON" || element.getAttribute("role") === "button" ||
          (element.tagName === "INPUT" && /^(button|submit)$/i.test(element.type)),
      };
    };`;
}

/**
 * Libellé fourni : cherche un lien ou un bouton visible dont le libellé correspond
 * exactement (insensible à la casse, aux accents et aux espaces).
 */
async function findExactClickables(tabId, label) {
  const normalizedLabel = normalizeLinkLabelKey(label);
  const expression = `(() => {
    const target = ${JSON.stringify(normalizedLabel)};
    ${clickableHelpersSource()}
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)}));
    elements.forEach((element, index) => { element.dataset.instavaIndex = String(index); });
    return elements
      .filter((element) => isVisible(element) && normalize(labelOf(element)) === target)
      .map((element) => describe(element));
  })()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("Impossible de vérifier le libellé du lien ou du bouton dans la page.");
  if (!Array.isArray(result.result?.value)) throw new Error("La page n’a pas renvoyé les éléments cliquables visibles.");
  return result.result.value;
}

/**
 * Libellé vide : le bot clique tout seul le contrôle principal de la page
 * (lien ou bouton), en privilégiant la surface et le texte hors navigation.
 */
async function findPrimaryLink(tabId) {
  const expression = `(() => {
    const NAV = 'header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';
    ${clickableHelpersSource()}
    const elements = Array.from(document.querySelectorAll(${JSON.stringify(CLICKABLE_SELECTOR)}));
    elements.forEach((element, index) => { element.dataset.instavaIndex = String(index); });
    const visible = [];
    for (const element of elements) {
      if (!isVisible(element)) continue;
      if (element instanceof HTMLAnchorElement) {
        const rawHref = element.href || "";
        if (!rawHref) continue;
        const current = location.href.split('#')[0];
        if (rawHref.split('#')[0] === current && (rawHref.includes('#') || rawHref === '#')) continue;
        if (/^(javascript:|mailto:|tel:)/i.test(element.getAttribute('href') || '')) continue;
      }
      const description = describe(element);
      const inNavigation = Boolean(element.closest(NAV));
      const isControl = element.tagName === 'BUTTON' || element.getAttribute('role') === 'button' ||
        (element.tagName === 'INPUT' && /^(button|submit)$/i.test(element.type));
      // Le classement est délégué à bot-utils : la surface et la longueur du
      // texte ne décident plus à la place du sens (lien de bio prioritaire,
      // boutons d'action rétrogradés).
      const ranking = InstaVAUtils.scoreClickable({
        text: description.text,
        href: description.href,
        area: description.area,
        kind: description.type,
        inNavigation,
        isControl,
        tagName: description.tagName,
        hasClickHandler: description.hasClickHandler,
      });
      visible.push({
        ...description,
        inNavigation,
        isControl,
        score: ranking.score,
        bioLink: ranking.bioLink,
        actionButton: ranking.actionButton,
      });
    }
    visible.sort((a, b) => b.score - a.score);
    return visible;
  })()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("Impossible de repérer les éléments cliquables de la page.");
  const links = Array.isArray(result.result?.value) ? result.result.value : [];
  if (!links.length) return { links, picked: null };
  if (links.length === 1) return { links, picked: { ...links[0], reason: `seul ${links[0].type} visible` } };
  const main = links.filter((link) => !link.inNavigation);
  const picked = (main.length ? main : links)[0];
  return {
    links,
    picked: { ...picked, reason: main.length ? `${picked.type} principal` : `${picked.type} principal (toute la page est en navigation)` },
  };
}

/** Clé de comparaison des libellés dans la page (casse, accents, espaces normalisés). */
function normalizeLinkLabelKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Démarre (ou réutilise) le worker Tesseract.js local.
 * Tout est servi depuis extension/vendor/ : aucune requête réseau, aucun script distant,
 * workerBlobURL désactivé car la CSP MV3 (worker-src 'self') refuse les workers blob:.
 */
function ensureOcrWorker(requestedLanguage) {
  const language = normalizeOcrLanguage(requestedLanguage);
  if (ocrWorker && loadedLanguage === language && ocrWorkerState === "ready") return Promise.resolve(ocrWorker);
  if (ocrReadyPromise) {
    if (ocrStartingLanguage === language) return ocrReadyPromise;
    return ocrReadyPromise.catch(() => {}).then(() => ensureOcrWorker(language));
  }
  ocrStartingLanguage = language;
  ocrReadyPromise = startOcrWorker(language).finally(() => {
    ocrReadyPromise = null;
    ocrStartingLanguage = "";
  });
  return ocrReadyPromise;
}

async function startOcrWorker(language) {
  await shutdownOcrWorker("");
  if (typeof Tesseract === "undefined" || typeof Tesseract.createWorker !== "function") {
    throw new Error("Le moteur OCR local est introuvable : extension/vendor/tesseract.min.js n’a pas été chargé.");
  }
  if (typeof Worker === "undefined") {
    throw new Error("Les Web Workers sont indisponibles : impossible de lancer l’OCR local.");
  }
  setOcrWorkerStatus(`Démarrage du moteur OCR local (${language})…`);
  const assetBase = typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(OCR_ASSET_BASE)
    : OCR_ASSET_BASE;
  const options = buildOcrWorkerOptions(assetBase);
  options.logger = (message) => {
    if (!message || typeof message.progress !== "number") return;
    if (!/loading|initializ|recogni/i.test(message.status || "")) return;
    setOcrWorkerStatus(`${message.status} · ${Math.round(message.progress * 100)} % (${language})`);
  };
  let worker;
  try {
    worker = await Tesseract.createWorker(language, Tesseract.OEM.LSTM_ONLY, options);
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    const hint = /worker|importscripts|blob|fetch|network|csp/i.test(detail)
      ? " Vérifie que extension/vendor/ contient worker.min.js, tesseract-core-*.wasm.js et lang-data/*.traineddata.gz, puis recharge l’extension."
      : "";
    throw new Error(`Le moteur OCR local n’a pas pu démarrer (${detail})${hint}`);
  }
  if (!worker || typeof worker.recognize !== "function") {
    throw new Error("Le worker OCR ne répond pas correctement.");
  }
  try {
    await worker.setParameters({ preserve_interword_spaces: "1" });
  } catch { /* paramètre optionnel */ }
  ocrWorker = worker;
  loadedLanguage = language;
  ocrWorkerState = "ready";
  setOcrWorkerStatus(`Moteur OCR prêt (${language}, local).`);
  return worker;
}

async function shutdownOcrWorker(reason = "", message = "") {
  const worker = ocrWorker;
  ocrWorker = null;
  loadedLanguage = "";
  ocrWorkerState = "idle";
  if (worker) {
    try { await worker.terminate(); } catch { /* worker déjà arrêté */ }
  }
  if (message) setOcrWorkerStatus(message);
  else setOcrWorkerStatus(reason ? `Moteur OCR arrêté (${reason}).` : "Moteur OCR arrêté.");
}

function setOcrWorkerStatus(text) {
  if (ocrWorkerStatusNode) ocrWorkerStatusNode.textContent = text;
}

function base64ToBlob(base64, type) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

/**
 * Lit l’écran via Tesseract.js et renvoie le texte, les mots avec leur boîte
 * et la taille réelle de l’image (les coordonnées TSV y sont exprimées).
 */
async function readScreen(base64) {
  if (!ocrWorker || ocrWorkerState !== "ready") {
    throw new Error("Le moteur OCR local n’est pas initialisé.");
  }
  const blob = base64ToBlob(base64, "image/jpeg");
  let width = 0;
  let height = 0;
  try {
    const bitmap = await createImageBitmap(blob);
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close?.();
  } catch { /* dimensions facultatives, l’échelle vaudra 1 */ }

  ocrWorkerState = "busy";
  try {
    // Output explicite : sans `text`, Tesseract v6 ne renvoie pas result.data.text.
    const result = await ocrWorker.recognize(blob, {}, { text: true, tsv: true });
    return {
      text: String(result?.data?.text || ""),
      words: parseTsv(String(result?.data?.tsv || "")),
      width,
      height,
    };
  } finally {
    ocrWorkerState = "ready";
  }
}

function parseTsv(tsv) {
  const words = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const columns = row.split("\t");
    if (Number(columns[0]) !== 5 || columns.length < 12) continue;
    const [left, top, width, height] = columns.slice(6, 10).map(Number);
    const confidence = Number(columns[10]);
    const text = columns.slice(11).join("\t").trim();
    if (!text || ![left, top, width, height].every(Number.isFinite)) continue;
    words.push({
      text,
      confidence: Number.isFinite(confidence) ? confidence : 0,
      bbox: { x0: left, y0: top, x1: left + width, y1: top + height },
    });
  }
  return words;
}

function findOcrPhrase(words, phrase) {
  const targetTokens = normalizeText(phrase).split(" ").filter(Boolean);
  if (!targetTokens.length) return null;
  const usable = words
    .filter((word) => Number(word.confidence ?? 100) >= MIN_OCR_CONFIDENCE)
    .map((word) => ({ word, centerY: (word.bbox.y0 + word.bbox.y1) / 2 }));
  const sorted = usable.sort((a, b) => a.centerY - b.centerY || a.word.bbox.x0 - b.word.bbox.x0);
  const lines = [];

  for (const item of sorted) {
    const height = Math.max(1, item.word.bbox.y1 - item.word.bbox.y0);
    let line = lines.find((candidate) => Math.abs(candidate.centerY - item.centerY) <= Math.max(9, Math.min(height, candidate.height) * 0.55));
    if (!line) {
      line = { centerY: item.centerY, height, words: [] };
      lines.push(line);
    }
    line.words.push(item.word);
    line.centerY = line.words.reduce((sum, word) => sum + (word.bbox.y0 + word.bbox.y1) / 2, 0) / line.words.length;
    line.height = line.words.reduce((sum, word) => sum + word.bbox.y1 - word.bbox.y0, 0) / line.words.length;
  }

  for (const line of lines) {
    line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const tokens = [];
    for (const word of line.words) {
      for (const token of normalizeText(word.text).split(" ").filter(Boolean)) tokens.push({ token, word });
    }
    for (let start = 0; start <= tokens.length - targetTokens.length; start += 1) {
      const candidate = tokens.slice(start, start + targetTokens.length);
      if (!candidate.every((part, i) => part.token === targetTokens[i])) continue;
      const matchedWords = [...new Set(candidate.map((part) => part.word))];
      const confidence = matchedWords.reduce((sum, word) => sum + Number(word.confidence ?? 100), 0) / matchedWords.length;
      const x0 = Math.min(...matchedWords.map((word) => word.bbox.x0));
      const y0 = Math.min(...matchedWords.map((word) => word.bbox.y0));
      const x1 = Math.max(...matchedWords.map((word) => word.bbox.x1));
      const y1 = Math.max(...matchedWords.map((word) => word.bbox.y1));
      return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, confidence };
    }
  }
  return null;
}

function normalizeText(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Délai dépassé en attendant le chargement de la page."));
    }, timeoutMs);
    const onUpdated = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      }
    };
    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        cleanup();
        reject(new Error("L'onglet a été fermé."));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function observeDuringLoad(tabId, isFinished) {
  while (!isFinished() && !stopRequested) {
    try {
      renderScreenshot(await captureScreen(tabId));
      const tab = await chromeCall(chrome.tabs.get, tabId);
      currentUrlNode.textContent = tab.url || "Chargement…";
    } catch {
      // Une capture peut échouer pendant un changement de document; réessayer au cycle suivant.
    }
    await delay(900);
  }
}

async function waitForStableUrl(tabId, capturePreview = true) {
  const started = Date.now();
  let tab = await chromeCall(chrome.tabs.get, tabId);
  let lastUrl = tab.url || "";
  let stableSince = Date.now();
  let lastPreviewAt = 0;
  while (Date.now() - started < REDIRECT_MAX_WAIT_MS) {
    if (stopRequested) throw new Error("Traitement arrêté.");
    await delay(250);
    tab = await chromeCall(chrome.tabs.get, tabId);
    const nextUrl = tab.url || "";
    if (nextUrl !== lastUrl) {
      lastUrl = nextUrl;
      stableSince = Date.now();
      currentUrlNode.textContent = nextUrl;
    }
    if (capturePreview && Date.now() - lastPreviewAt >= 1000) {
      try { renderScreenshot(await captureScreen(tabId)); } catch { /* écran en transition */ }
      lastPreviewAt = Date.now();
    }
    if (tab.status === "complete" && Date.now() - stableSince >= REDIRECT_QUIET_MS) return tab;
  }
  return tab;
}

async function captureScreen(tabId) {
  const result = await sendCDP(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 82,
    fromSurface: true,
    captureBeyondViewport: false,
  });
  return result.data;
}

async function clickAt(tabId, x, y) {
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sendCDP(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await delay(650);
}

function sendCDP(tabId, method, params = {}) {
  return chromeCall(chrome.debugger.sendCommand, { tabId }, method, params);
}

function chromeCall(apiMethod, ...args) {
  return new Promise((resolve, reject) => {
    apiMethod(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function showOcrText(text) {
  ocrTextNode.textContent = text || "Aucun texte détecté.";
}

function renderScreenshot(base64) {
  screenPreview.src = `data:image/jpeg;base64,${base64}`;
  screenPreview.hidden = false;
  previewEmpty.hidden = true;
}

function excerpt(text, maxLength) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}…` : normalized;
}

function askConfirmation(description) {
  return new Promise((resolve) => {
    const dialog = $("confirmDialog");
    const form = $("confirmForm");
    $("confirmText").textContent = description;
    const cleanup = () => {
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onCancel);
    };
    const onSubmit = (event) => {
      event.preventDefault();
      const approved = event.submitter?.id === "confirmYes";
      dialog.close();
      cleanup();
      resolve(approved);
    };
    const onCancel = (event) => {
      event.preventDefault();
      dialog.close();
      cleanup();
      resolve(false);
    };
    form.addEventListener("submit", onSubmit);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

function addLog(title, body, isError = false) {
  const item = document.createElement("li");
  if (isError) item.classList.add("error");
  const strong = document.createElement("strong");
  strong.textContent = title;
  const detail = document.createElement("div");
  detail.textContent = body;
  item.append(strong, detail);
  logNode.prepend(item);
}

function setStatus(text) {
  statusNode.textContent = text;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
