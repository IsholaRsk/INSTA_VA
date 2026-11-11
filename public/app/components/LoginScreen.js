import { h, useState } from '../lib.js';

/**
 * Écran de connexion / première installation, dans le même langage visuel que
 * le reste (carte violette, champs sombres).
 */
export function LoginScreen({ firstRun = false, signupOpen = false, busy = false, onSubmit = () => {}, toast = null } = {}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signupCode, setSignupCode] = useState('');
  const [mode, setMode] = useState(firstRun ? 'register' : 'login');

  const submit = (event) => {
    event.preventDefault();
    onSubmit({ mode, email: email.trim(), password, signupCode: signupCode.trim() });
  };

  return h('div', { className: 'app' },
    h('div', { className: 'greeting', style: { marginTop: '18vh' } },
      h('h1', null, firstRun ? 'Bienvenue !' : 'Bonjour !'),
      h('p', null, firstRun
        ? 'Premier démarrage : crée le compte propriétaire de ce serveur.'
        : 'Connecte-toi pour retrouver ton solde et tes séries.'),
    ),

    h('section', { className: 'section', 'aria-label': 'Connexion' },
      h('form', { onSubmit: submit, style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('label', { htmlFor: 'email', style: { fontSize: '11px', color: 'var(--muted)' } }, 'Adresse e-mail'),
        h('input', {
          id: 'email', type: 'email', required: true, autoComplete: 'email', inputMode: 'email',
          value: email, onChange: (event) => setEmail(event.target.value),
          style: inputStyle,
        }),
        h('label', { htmlFor: 'password', style: { fontSize: '11px', color: 'var(--muted)', marginTop: '4px' } }, 'Mot de passe'),
        h('input', {
          id: 'password', type: 'password', required: true, minLength: 8, autoComplete: mode === 'register' ? 'new-password' : 'current-password',
          value: password, onChange: (event) => setPassword(event.target.value),
          style: inputStyle,
        }),
        mode === 'register' && h('input', {
          type: 'text', placeholder: 'Code d’inscription (si demandé)',
          value: signupCode, onChange: (event) => setSignupCode(event.target.value),
          style: inputStyle,
        }),
        h('button', {
          type: 'submit',
          disabled: busy,
          style: {
            marginTop: '8px', border: 0, borderRadius: '14px', padding: '14px',
            background: 'linear-gradient(150deg, var(--violet-soft), var(--violet-deep))',
            color: '#fff', fontWeight: 700, fontSize: '13px', cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? .6 : 1,
          },
        }, busy ? 'Connexion…' : (mode === 'register' ? 'Créer le compte' : 'Se connecter')),
      ),
      signupOpen && !firstRun && h('button', {
        type: 'button',
        className: 'link',
        style: { marginTop: '12px', background: 'none', border: 0, color: 'var(--muted)', fontSize: '11px', cursor: 'pointer' },
        onClick: () => setMode(mode === 'login' ? 'register' : 'login'),
      }, mode === 'login' ? 'Créer un compte' : 'J’ai déjà un compte'),
    ),

    toast && h('div', { className: `toast show${toast.isError ? ' error' : ''}`, role: 'status' }, toast.message),
  );
}

const inputStyle = {
  width: '100%',
  minHeight: '46px',
  padding: '0 14px',
  borderRadius: '13px',
  border: '1px solid var(--line-strong)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontSize: '13px',
};
