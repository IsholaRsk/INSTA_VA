const STORAGE_KEY = "savedTargets";
const MAX_SAVED_TARGETS = 50;
const MAX_TARGET_EXECUTIONS = 50;
const MAX_TARGET_DURATION_DAYS = 30;
const MAX_SCHEDULED_VISITS = 300;
const MIN_SCHEDULE_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWPORT = { width: 1280, height: 800 };
const REDIRECT_QUIET_MS = 2500;
const REDIRECT_MAX_WAIT_MS = 15000;
const MIN_OCR_CONFIDENCE = 45;
const ALWAYS_CONFIRM_RE = /\b(pay|payment|purchase|buy|order|submit|send|delete|remove|post|publish|confirm|payer|paiement|achat|acheter|commander|valider|envoyer|supprimer|effacer|publier|poster|confirmer)\b/i;

const $ = (id) => document.getElementById(id);
const targetListNode = $("targetList");
const emptyTargetsNode = $("emptyTargets");
const selectionSummaryNode = $("selectionSummary");
const targetForm = $("targetForm");
const targetPseudoInput = $("targetPseudo");
const targetUrlInput = $("targetUrl");
const targetLinkLabelInput = $("targetLinkLabel");
const targetExecutionCountInput = $("targetExecutionCount");
const targetDurationDaysInput = $("targetDurationDays");
const commonExecutionCountInput = $("commonExecutionCount");
const commonDurationDaysInput = $("commonDurationDays");
const formTitle = $("formTitle");
const saveTargetButton = $("saveTarget");
const cancelEditButton = $("cancelEdit");
const selectAllTargetsButton = $("selectAllTargets");
const clearSelectionButton = $("clearSelection");
const applyCountToAllButton = $("applyCountToAll");
const applyDurationToAllButton = $("applyDurationToAll");
const languageInput = $("ocrLanguage");
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
  targetDurationDaysInput,
  commonExecutionCountInput,
  commonDurationDaysInput,
  languageInput,
  confirmClicksInput,
];

let savedTargets = [];
let selectedTargetIds = new Set();
let editingTargetId = null;
let running = false;
let stopRequested = false;
let activeTabId = null;
let ocrWorker = null;
let loadedLanguage = "";

$("clearLog").addEventListener("click", () => logNode.replaceChildren());
targetForm.addEventListener("submit", saveTargetFromForm);
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
});

initializeTargets();

async function initializeTargets() {
  setConfigurationDisabled(true);
  startButton.disabled = true;
  setStatus("Chargement des cibles enregistrées…");
  try {
    const result = await chromeCall(chrome.storage.local.get, STORAGE_KEY);
    const stored = result?.[STORAGE_KEY];
    savedTargets = Array.isArray(stored) ? stored.map(sanitizeSavedTarget).filter(Boolean) : [];
    renderTargetList();
    setStatus(savedTargets.length ? `${savedTargets.length} cible(s) chargée(s).` : "Ajoute une cible pour commencer.");
  } catch (error) {
    savedTargets = [];
    renderTargetList();
    setStatus(`Impossible de charger le stockage local : ${error.message}`);
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
    const linkLabel = String(raw.linkLabel ?? raw.buttonLabel ?? "").trim();
    const executionTarget = Number(raw.executionTarget);
    const durationDays = Number(raw.durationDays);
    if (!pseudo || pseudo.length > 60 || linkLabel.length > 100) return null;
    if (!Number.isInteger(executionTarget) || executionTarget < 1 || executionTarget > MAX_TARGET_EXECUTIONS) return null;
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > MAX_TARGET_DURATION_DAYS) return null;
    return { id: raw.id, pseudo, url, linkLabel, executionTarget, durationDays };
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

    const bounds = getExecutionBounds(target.executionTarget);
    const meta = document.createElement("p");
    meta.className = "target-meta";
    meta.textContent = `${target.url}\nLien : ${target.linkLabel || "aucun — attendre puis fermer"}\nExécutions : visée ${target.executionTarget}, tirage ${bounds.min}–${bounds.max} · Durée : ${target.durationDays} jour(s)`;
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
  try {
    const wasEditing = Boolean(editingTargetId);
    const target = readTargetForm();
    const duplicate = savedTargets.find((item) =>
      item.id !== editingTargetId && item.pseudo.toLocaleLowerCase("fr") === target.pseudo.toLocaleLowerCase("fr"));
    if (duplicate) throw new Error("Ce pseudo est déjà utilisé par une autre cible.");
    if (!editingTargetId && savedTargets.length >= MAX_SAVED_TARGETS) {
      throw new Error(`Maximum ${MAX_SAVED_TARGETS} cibles enregistrées.`);
    }

    const nextTargets = editingTargetId
      ? savedTargets.map((item) => item.id === editingTargetId ? { ...item, ...target } : item)
      : [...savedTargets, { id: crypto.randomUUID(), ...target }];
    await persistTargets(nextTargets);
    savedTargets = nextTargets;
    clearTargetForm();
    renderTargetList();
    setStatus(wasEditing ? "Cible mise à jour." : "Cible enregistrée localement.");
  } catch (error) {
    setStatus(error.message);
  }
}

function readTargetForm() {
  const pseudo = targetPseudoInput.value.trim();
  if (!pseudo) throw new Error("Renseigne un pseudo ou nom de cible.");
  if (pseudo.length > 60) throw new Error("Le pseudo doit faire 60 caractères maximum.");
  const url = normalizeTargetUrl(targetUrlInput.value);
  const linkLabel = targetLinkLabelInput.value.trim();
  if (linkLabel.length > 100) throw new Error("Le libellé complet du lien doit faire 100 caractères maximum.");
  const executionTarget = readInteger(targetExecutionCountInput.value, 1, MAX_TARGET_EXECUTIONS, "Nombre visé");
  const durationDays = readInteger(targetDurationDaysInput.value, 1, MAX_TARGET_DURATION_DAYS, "Durée");
  return { pseudo, url, linkLabel, executionTarget, durationDays };
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
  await chromeCall(chrome.storage.local.set, { [STORAGE_KEY]: targets });
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
  targetDurationDaysInput.value = String(target.durationDays);
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
    const value = isCount
      ? readInteger(commonExecutionCountInput.value, 1, MAX_TARGET_EXECUTIONS, "Nombre cible commun")
      : readInteger(commonDurationDaysInput.value, 1, MAX_TARGET_DURATION_DAYS, "Durée commune");
    const nextTargets = savedTargets.map((target) => ({ ...target, [field]: value }));
    await persistTargets(nextTargets);
    savedTargets = nextTargets;
    if (editingTargetId) {
      const edited = savedTargets.find((target) => target.id === editingTargetId);
      if (edited) {
        if (isCount) targetExecutionCountInput.value = String(value);
        else targetDurationDaysInput.value = String(value);
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
  const selectedTargets = savedTargets.filter((target) => selectedTargetIds.has(target.id));
  if (!selectedTargets.length) {
    setStatus("Sélectionne au moins une cible enregistrée.");
    return;
  }

  let totalWorstCaseVisits = 0;
  try {
    for (const target of selectedTargets) {
      normalizeTargetUrl(target.url);
      readInteger(target.executionTarget, 1, MAX_TARGET_EXECUTIONS, `Nombre visé pour ${target.pseudo}`);
      readInteger(target.durationDays, 1, MAX_TARGET_DURATION_DAYS, `Durée pour ${target.pseudo}`);
      totalWorstCaseVisits += target.executionTarget + 10;
    }
    if (totalWorstCaseVisits > MAX_SCHEDULED_VISITS) {
      throw new Error(`La sélection pourrait dépasser ${MAX_SCHEDULED_VISITS} visites de pages au total. Réduis le nombre visé ou la sélection.`);
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
  ocrTextNode.textContent = "L’OCR local ne sera chargé que pour les cibles ayant un libellé de lien.";

  let totalFailures = 0;
  let completedRuns = 0;
  let totalRuns = 0;
  try {
    const focusedTabs = await chromeCall(chrome.tabs.query, { active: true, lastFocusedWindow: true });
    const windowId = focusedTabs[0]?.windowId;
    const startAt = Date.now();
    const plans = selectedTargets.map((target, order) => createTargetPlan(target, startAt, order));
    totalRuns = plans.reduce((sum, plan) => sum + plan.count, 0);
    for (const plan of plans) {
      const bounds = getExecutionBounds(plan.target.executionTarget);
      addLog(
        `Planifiée · ${plan.target.pseudo}`,
        `${plan.count} exécution(s) tirée(s) entre ${bounds.min} et ${bounds.max} (cible ${plan.target.executionTarget} ±10); durée propre : ${plan.target.durationDays} jour(s); ${plan.target.linkLabel ? `lien exact « ${plan.target.linkLabel} »` : "aucun libellé, attente puis fermeture"}.`,
      );
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

      addLog(`${plan.target.pseudo} · exécution ${runNumber}/${plan.count}`, `Début : ${new Date().toLocaleString()}`);
      try {
        await executeTargetRun(plan.target, runNumber, plan.count, windowId);
      } catch (error) {
        if (stopRequested) break;
        totalFailures += 1;
        addLog(`${plan.target.pseudo} · exécution en erreur`, error.message, true);
      }
      if (stopRequested) break;
      plan.lastRunFinishedAt = Date.now();
      plan.nextIndex += 1;
      completedRuns += 1;
    }

    if (stopRequested) setStatus(`Traitement arrêté après ${completedRuns}/${totalRuns} exécution(s).`);
    else if (totalFailures) setStatus(`Terminé avec ${totalFailures} erreur(s) sur ${completedRuns} exécution(s).`);
    else setStatus(`Terminé : ${completedRuns} exécution(s) sur ${selectedTargets.length} cible(s).`);
  } catch (error) {
    if (stopRequested) setStatus(`Traitement arrêté après ${completedRuns}/${totalRuns} exécution(s).`);
    else {
      setStatus(`Erreur de planification : ${error.message}`);
      addLog("Erreur", error.message, true);
    }
  } finally {
    if (ocrWorker) {
      try { await ocrWorker.terminate(); } catch { /* worker déjà arrêté */ }
    }
    ocrWorker = null;
    loadedLanguage = "";
    activeTabId = null;
    running = false;
    setConfigurationDisabled(false);
    stopButton.disabled = true;
    updateSelectionSummary();
  }
}

function getExecutionBounds(targetCount) {
  return { min: Math.max(1, targetCount - 10), max: targetCount + 10 };
}

function createTargetPlan(target, startAt, order) {
  const bounds = getExecutionBounds(target.executionTarget);
  const count = randomInteger(bounds.min, bounds.max);
  return {
    target: { ...target },
    count,
    runTimes: buildRandomRunTimes(count, target.durationDays, startAt),
    nextIndex: 0,
    lastRunFinishedAt: 0,
    order,
  };
}

function buildRandomRunTimes(count, durationDays, startAt) {
  const runTimes = [startAt];
  if (count <= 1) return runTimes;
  const durationMs = durationDays * DAY_MS;
  const gapCount = count;
  const extraMs = durationMs - gapCount * MIN_SCHEDULE_INTERVAL_MS;
  if (extraMs < 0) throw new Error("La durée choisie est trop courte pour les intervalles minimaux.");
  const weights = Array.from({ length: gapCount }, () => -Math.log(randomUnit()));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  let elapsed = 0;
  let allocatedExtra = 0;
  for (let index = 0; index < gapCount; index += 1) {
    const extra = index === gapCount - 1
      ? extraMs - allocatedExtra
      : extraMs * weights[index] / weightTotal;
    allocatedExtra += extra;
    elapsed += MIN_SCHEDULE_INTERVAL_MS + extra;
    if (index < count - 1) runTimes.push(startAt + Math.round(elapsed));
  }
  return runTimes;
}

function getNextDueAt(plan) {
  const plannedTime = plan.runTimes[plan.nextIndex];
  if (plan.nextIndex === 0) return plannedTime;
  return Math.max(plannedTime, plan.lastRunFinishedAt + MIN_SCHEDULE_INTERVAL_MS);
}

async function executeTargetRun(target, runIndex, runCount, windowId) {
  try {
    if (target.linkLabel) await ensureOcrWorker(languageInput.value);
    await processTarget(target, runIndex, runCount, windowId);
  } finally {
    if (ocrWorker) {
      try { await ocrWorker.terminate(); } catch { /* worker déjà arrêté */ }
    }
    ocrWorker = null;
    loadedLanguage = "";
  }
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

function randomInteger(minimum, maximum) {
  return minimum + Math.floor(randomUnit() * (maximum - minimum + 1));
}

function randomUnit() {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return (value[0] + 1) / 4294967297;
}

function setConfigurationDisabled(disabled) {
  runConfigurationInputs.forEach((input) => { input.disabled = disabled; });
  for (const button of [cancelEditButton, selectAllTargetsButton, clearSelectionButton, applyCountToAllButton, applyDurationToAllButton, saveTargetButton]) {
    button.disabled = disabled;
  }
  targetListNode.querySelectorAll("input, button").forEach((element) => { element.disabled = disabled; });
  if (!disabled) {
    selectAllTargetsButton.disabled = savedTargets.length === 0;
    applyCountToAllButton.disabled = savedTargets.length === 0;
    applyDurationToAllButton.disabled = savedTargets.length === 0;
  }
}

async function processTarget(target, runIndex, runCount, windowId) {
  const url = target.url;
  const linkLabel = target.linkLabel;
  setStatus(`${target.pseudo} · exécution ${runIndex}/${runCount} · ouverture…`);
  let tab;
  let attached = false;
  let redirectCount = 0;
  const childTabIds = [];
  const monitoredTabIds = new Set();
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

    if (!linkLabel) {
      showOcrText("OCR non exécuté : aucun libellé de lien configuré.");
      addLog(`${target.pseudo} · terminé`, "URL stabilisée; aucun libellé fourni, fermeture de l’onglet.");
      return;
    }

    const screenshot = await captureScreen(tab.id);
    renderScreenshot(screenshot);
    const ocrResult = await readScreen(screenshot);
    showOcrText(ocrResult.text);
    addLog(`${target.pseudo} · texte reconnu`, ocrResult.text ? excerpt(ocrResult.text, 700) : "Aucun texte détecté.");
    const matches = await findExactLinks(tab.id, linkLabel);
    if (!matches.length) {
      addLog(`${target.pseudo} · lien introuvable`, `Aucun lien visible dont le libellé complet correspond à « ${linkLabel} ». Onglet fermé sans clic.`, true);
      return;
    }
    if (matches.length > 1) {
      addLog(`${target.pseudo} · liens identiques`, `${matches.length} liens visibles portent le libellé complet « ${linkLabel} ». Aucun clic effectué pour éviter une sélection ambiguë.`, true);
      return;
    }
    const match = matches[0];

    const description = `Cible : ${target.pseudo}\nCliquer une fois sur le lien complet « ${linkLabel} »${match.href ? ` (${match.href})` : ""}.`;
    if ((confirmClicksInput.checked || ALWAYS_CONFIRM_RE.test(linkLabel)) && !(await askConfirmation(description))) {
      addLog(`${target.pseudo} · clic ignoré`, `Lien « ${linkLabel} »`);
      return;
    }
    if (stopRequested) return;

    const redirectsBeforeClick = redirectCount;
    const openedTabPromise = waitForOpenedTab(tab.id, (childTab) => {
      childTabIds.push(childTab.id);
      monitoredTabIds.add(childTab.id);
    });
    await clickAt(tab.id, match.x, match.y);
    const openedTab = await openedTabPromise;
    addLog(`${target.pseudo} · lien cliqué`, `« ${linkLabel} »${match.href ? ` → ${match.href}` : ""}`);
    if (openedTab) finalTab = await waitForStableUrl(openedTab.id, false);
    else {
      await waitForStableUrl(tab.id);
      finalTab = await chromeCall(chrome.tabs.get, tab.id);
    }
    currentUrlNode.textContent = finalTab.url || "";
    const redirectsAfterClick = redirectCount - redirectsBeforeClick;
    addLog(
      `${target.pseudo} · redirection après clic`,
      `${redirectsAfterClick ? `${redirectsAfterClick} redirection(s)` : "URL stabilisée sans redirection détectée"}\n→ ${finalTab.url || "URL inconnue"}${openedTab ? " · nouvel onglet temporaire" : ""}`,
    );
    if (!openedTab) {
      try { renderScreenshot(await captureScreen(tab.id)); } catch { /* la page peut se fermer pendant la navigation */ }
    }
  } finally {
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
  }
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

async function findExactLinks(tabId, label) {
  const normalizedLabel = normalizeLinkLabel(label);
  const expression = `(() => {
    const target = ${JSON.stringify(normalizedLabel)};
    const normalize = (value) => String(value || "")
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "")
      .toLocaleLowerCase("fr")
      .replace(/\\s+/g, " ")
      .trim();
    return Array.from(document.querySelectorAll('a[href], [role="link"]'))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        if (!rect.width || !rect.height || rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0 || style.pointerEvents === "none") return false;
        if (element.getAttribute("aria-disabled") === "true") return false;
        const visibleText = String(element.innerText || "").replace(/\\s+/g, " ").trim();
        const accessibleText = visibleText || element.getAttribute("aria-label") || "";
        return normalize(accessibleText) === target;
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const left = Math.max(0, rect.left);
        const right = Math.min(window.innerWidth, rect.right);
        const top = Math.max(0, rect.top);
        const bottom = Math.min(window.innerHeight, rect.bottom);
        return {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          href: element.href || element.getAttribute("href") || "",
        };
      });
  })()`;
  const result = await sendCDP(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error("Impossible de vérifier le libellé du lien dans la page.");
  if (!Array.isArray(result.result?.value)) throw new Error("La page n’a pas renvoyé les liens visibles.");
  return result.result.value;
}

function normalizeLinkLabel(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("fr")
    .replace(/\s+/g, " ")
    .trim();
}

async function readScreen(base64) {
  if (!ocrWorker) throw new Error("Le moteur OCR local n'est pas initialisé.");
  const result = await ocrWorker.recognize(
    `data:image/jpeg;base64,${base64}`,
    {},
    { tsv: true },
  );
  return { text: result.data.text || "", words: parseTsv(result.data.tsv || "") };
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
