/**
 * Pont minimal vers React.
 *
 * L'interface est écrite avec `createElement` et rendue par le React chargé
 * depuis le serveur (voir ui/index.html). Aucun outil de compilation n'est
 * nécessaire : le VPS reçoit du JavaScript déjà lisible, et `npm ci --omit=dev`
 * n'a pas besoin de React comme dépendance de production.
 *
 * Ce module n'importe rien : il lit `globalThis.React`, ce qui permet de le
 * tester sous Node en injectant un React factice.
 */
export function getReact() {
  const R = globalThis.React;
  if (!R) throw new Error('React est introuvable : vérifiez le chargement de /vendor/react.js');
  return R;
}

/** `h` = createElement, en appel direct pour éviter un accès global répété. */
export const h = (...args) => getReact().createElement(...args);

/** Hooks, exposés un par un avec un nom stable et testable. */
export const useState = (...args) => getReact().useState(...args);
export const useEffect = (...args) => getReact().useEffect(...args);
export const useMemo = (...args) => getReact().useMemo(...args);
export const useCallback = (...args) => getReact().useCallback(...args);
export const useRef = (...args) => getReact().useRef(...args);
