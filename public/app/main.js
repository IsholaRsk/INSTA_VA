import { App } from './App.js';
import { getReact } from './lib.js';

// Point d'entrée. React et ReactDOM sont chargés avant ce module (voir
// ui/index.html) : le serveur les sert depuis public/vendor, la CSP n'autorise
// que 'self' pour les scripts.
const React = getReact();
const ReactDOM = globalThis.ReactDOM;
if (!ReactDOM) throw new Error('ReactDOM est introuvable : vérifiez /vendor/react-dom.js');

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
