import { h, useState, useEffect, useMemo } from './lib.js';
import { createApi } from './api.js';
import { BalanceCard } from './components/BalanceCard.js';
import { QuickActions } from './components/QuickActions.js';
import { ClicksByTarget, RecentActivity } from './components/ActivityList.js';
import { TabBar } from './components/TabBar.js';
import { LoginScreen } from './components/LoginScreen.js';
import { ClicksScreen, BotScreen, AccountScreen } from './components/Screens.js';
import { IconMenu, IconBell } from './components/icons.js';
import { initials } from './domain/format.js';

/**
 * Application principale.
 *
 * Trois états : chargement, non connecté, connecté. Le solde est calculé à
 * partir du total de clics renvoyé par /api/visits — aucune valeur inventée.
 */
export function App({ api = createApi() } = {}) {
  const [status, setStatus] = useState('loading'); // loading | anonymous | ready
  const [server, setServer] = useState(null);
  const [user, setUser] = useState(null);
  const [tab, setTab] = useState('home');
  const [data, setData] = useState({ visits: [], clicksByTarget: [], clicksTotal: 0, todayTotal: 0, targets: [], worker: null });
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  const notify = (message, isError = false) => {
    setToast({ message, isError, id: Date.now() });
  };

  const refresh = async () => {
    try {
      const [visits, targets, health] = await Promise.all([
        api.visits().catch(() => ({})),
        api.targets().catch(() => ({ targets: [] })),
        api.health().catch(() => null),
      ]);
      setData({
        visits: visits.visits || [],
        clicksByTarget: visits.clicksByTarget || [],
        clicksTotal: Number(visits.clicksTotal || 0),
        todayTotal: Number(visits.todayTotal || 0),
        targets: targets.targets || [],
        worker: health?.worker || null,
      });
    } catch (error) {
      notify(error.message, true);
    }
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const health = await api.health().catch(() => null);
      if (!alive) return;
      setServer(health);
      if (!health?.ok) { setStatus('anonymous'); return; }
      const session = await api.me().catch(() => null);
      if (!alive) return;
      if (session?.user) {
        setUser(session.user);
        setStatus('ready');
      } else {
        setStatus('anonymous');
      }
    })();
    return () => { alive = false; };
    // Une seule initialisation : l'API est stable pour la durée de vie de l'app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'ready') return undefined;
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  const signIn = async (credentials) => {
    setBusy(true);
    try {
      const result = credentials.mode === 'register'
        ? await api.register(credentials.email, credentials.password, credentials.signupCode)
        : await api.login(credentials.email, credentials.password);
      setUser(result.user);
      setStatus('ready');
      notify('Connexion réussie.');
    } catch (error) {
      notify(error.message, true);
    } finally { setBusy(false); }
  };

  const signOut = async () => {
    await api.logout().catch(() => null);
    setUser(null);
    setStatus('anonymous');
  };

  const launch = async () => {
    const ids = data.targets.filter((target) => target.enabled !== false).map((target) => target.id);
    if (!ids.length) { notify('Ajoute d’abord une cible.', true); return; }
    setBusy(true);
    try {
      const result = await api.start(ids, false);
      notify(`${result.targets?.length || ids.length} cible(s) programmée(s).`);
      refresh();
    } catch (error) { notify(error.message, true); }
    finally { setBusy(false); }
  };

  const byTarget = useMemo(
    () => data.clicksByTarget.map((item) => ({ ...item })),
    [data.clicksByTarget],
  );

  if (status === 'loading') {
    return h('div', { className: 'app' }, h('p', { className: 'empty' }, 'Chargement…'));
  }

  if (status === 'anonymous') {
    return h(LoginScreen, {
      firstRun: Boolean(server?.firstRun),
      signupOpen: Boolean(server?.setupOpen),
      busy,
      onSubmit: signIn,
      toast,
    });
  }

  return h('div', { className: 'app' },
    h('header', { className: 'topbar' },
      h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Menu', onClick: () => setTab('account') }, h(IconMenu)),
      h('div', { className: 'topbar-right' },
        h('button', { className: 'icon-button', type: 'button', 'aria-label': 'Notifications', onClick: () => notify('Aucune nouvelle notification.') }, h(IconBell)),
        h('div', { className: 'avatar', title: user?.email || '' }, initials(user?.email)),
      ),
    ),

    h('div', { className: 'greeting' },
      h('h1', null, `Bonjour ${String(user?.email || '').split('@')[0] || 'toi'} !`),
      h('p', null, data.todayTotal > 0
        ? `${data.todayTotal} clic(s) aujourd’hui — le solde monte tout seul.`
        : 'Ton bot travaille pendant que tu dors.'),
    ),

    h('div', { className: 'wallet' },
      h(BalanceCard, { clicks: data.clicksTotal, user, onTopUp: launch, now: new Date() }),
      h(QuickActions, {
        busy,
        onRun: launch,
        onRefresh: () => { refresh(); notify('Données actualisées.'); },
        onProxies: () => setTab('bot'),
        onMore: () => setTab('clicks'),
      }),
    ),

    h('div', { className: 'secondary' },
      tab === 'home' && h(ClicksByTarget, { targets: byTarget, onViewAll: () => setTab('clicks') }),
      tab === 'home' && h(RecentActivity, { visits: data.visits }),

      tab === 'clicks' && h(ClicksScreen, { clicksTotal: data.clicksTotal, targets: byTarget, todayTotal: data.todayTotal }),
      tab === 'bot' && h(BotScreen, { worker: data.worker, targets: data.targets, onLaunch: launch, busy }),
      tab === 'account' && h(AccountScreen, { user, onSignOut: signOut, server }),
    ),

    h(TabBar, { active: tab, onChange: setTab }),

    toast && h('div', {
      className: `toast show${toast.isError ? ' error' : ''}`,
      role: 'status',
      'aria-live': 'polite',
    }, toast.message),
  );
}
