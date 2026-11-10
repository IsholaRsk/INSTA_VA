import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { probeProxy } from '../server/proxies.js';

/**
 * Faux serveur SOCKS5 (RFC 1928) : accepte la poignée de main, vérifie les
 * identifiants, puis répond « succès » à la demande CONNECT. Aucun tunnel réel
 * n'est établi — on vérifie seulement que le client parle bien SOCKS5.
 */
function fakeSocks5({ user = 'identifiantfictif', password = 'motdepassefictif', refuseAuth = false, refuseConnect = false } = {}) {
  const seen = { methods: null, username: null, password: null, command: null, address: null };
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          const count = buffer[1];
          if (buffer.length < 2 + count) return;
          seen.methods = [...buffer.subarray(2, 2 + count)];
          buffer = buffer.subarray(2 + count);
          socket.write(Buffer.from([0x05, refuseAuth ? 0xff : 0x02]));
          stage = refuseAuth ? 'done' : 'auth';
          continue;
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return;
          const userLength = buffer[1];
          if (buffer.length < 2 + userLength + 1) return;
          const passLength = buffer[2 + userLength];
          if (buffer.length < 3 + userLength + passLength) return;
          seen.username = buffer.subarray(2, 2 + userLength).toString('utf8');
          seen.password = buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8');
          buffer = buffer.subarray(3 + userLength + passLength);
          const ok = seen.username === user && seen.password === password;
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
          if (!ok) return;
          stage = 'request';
          continue;
        }
        if (stage === 'request') {
          if (buffer.length < 5) return;
          seen.command = buffer[1];
          const type = buffer[3];
          if (type === 0x03) {
            const length = buffer[4];
            if (buffer.length < 5 + length + 2) return;
            seen.address = buffer.subarray(5, 5 + length).toString('utf8');
          }
          // Réponse : succès (0x00) ou refusé (0x05), adresse IPv4 factice.
          socket.write(Buffer.from([0x05, refuseConnect ? 0x05 : 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]));
          stage = 'done';
          if (!refuseConnect) {
            // On laisse le socket ouvert : le client va tenter un TLS dessus.
            socket.removeAllListeners('data');
          }
          return;
        }
        return;
      }
    });
    socket.on('error', () => {});
  });
  return { server, seen };
}

test('un proxy SOCKS5 reçoit une vraie poignée de main, pas un CONNECT HTTP', async () => {
  const { server, seen } = fakeSocks5();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // Le tunnel ne mènera nulle part (faux serveur) : on s'intéresse au protocole.
    await probeProxy({ scheme: 'socks5', host: '127.0.0.1', port, username: 'identifiantfictif', password: 'motdepassefictif' }, 1500)
      .catch(() => {});
    assert.deepEqual(seen.methods, [0x00, 0x02], 'méthodes SOCKS5 annoncées, dont identifiant/mot de passe');
    assert.equal(seen.username, 'identifiantfictif');
    assert.equal(seen.password, 'motdepassefictif');
    assert.equal(seen.command, 0x01, 'commande CONNECT');
    // Le premier service d'écho d'IP, ou le second si le premier est injoignable.
    assert.ok(['api.ipify.org', 'ipinfo.io'].includes(seen.address), `hôte inattendu : ${seen.address}`);
  } finally { server.close(); }
});

test('un refus d’identifiants SOCKS5 est signalé en français', async () => {
  const { server } = fakeSocks5({ refuseAuth: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => probeProxy({ scheme: 'socks5', host: '127.0.0.1', port, username: 'identifiantfictif', password: 'motdepassefictif' }, 1500),
      /Identifiants refusés par le proxy SOCKS5|méthode d’authentification/,
    );
  } finally { server.close(); }
});

test('un destinataire refusé par le proxy SOCKS5 donne un motif lisible', async () => {
  const { server } = fakeSocks5({ refuseConnect: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => probeProxy({ scheme: 'socks5', host: '127.0.0.1', port, username: 'identifiantfictif', password: 'motdepassefictif' }, 1500),
      /refusé la connexion/,
    );
  } finally { server.close(); }
});

test('un proxy HTTP continue de recevoir un CONNECT (aucune régression)', async () => {
  const received = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => { received.push(chunk.toString('utf8', 0, 7)); socket.destroy(); });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await probeProxy({ scheme: 'http', host: '127.0.0.1', port, username: 'u', password: 'p' }, 1500).catch(() => {});
    assert.equal(received[0], 'CONNECT', 'un proxy HTTP garde son tunnel CONNECT');
  } finally { server.close(); }
});
