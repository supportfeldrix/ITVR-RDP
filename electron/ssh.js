'use strict';
const { Client } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');
const store = require('./store');

const sessions = new Map(); // sessionId -> { client, stream, sender }

function open({ sender, item, password, passphrase, cols, rows }) {
  const sessionId = crypto.randomUUID();
  const hostPort = `${item.host}:${item.port}`;
  const send = (channel, payload) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  return new Promise((resolve, reject) => {
    const client = new Client();
    let privateKey;
    if (item.privateKeyPath) {
      try {
        privateKey = fs.readFileSync(item.privateKeyPath);
      } catch (e) {
        return reject(new Error(`Cannot read private key: ${e.message}`));
      }
    }

    client
      .on('ready', () => {
        client.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
          if (err) {
            client.end();
            return reject(err);
          }
          sessions.set(sessionId, { client, stream, sftp: null });
          stream.on('data', (d) => send('ssh:data', { sessionId, data: d.toString('utf8') }));
          stream.stderr.on('data', (d) => send('ssh:data', { sessionId, data: d.toString('utf8') }));
          stream.on('close', () => {
            sessions.delete(sessionId);
            client.end();
            send('ssh:closed', { sessionId });
          });
          resolve({ sessionId });
        });
      })
      .on('error', (e) => {
        if (sessions.has(sessionId)) send('ssh:closed', { sessionId, error: e.message });
        sessions.delete(sessionId);
        reject(e);
      })
      .connect({
        host: item.host,
        port: item.port,
        username: item.username,
        password: password || undefined,
        privateKey,
        passphrase: passphrase || undefined,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        hostHash: 'sha256',
        hostVerifier: (fingerprint) => {
          const known = store.getKnownHost(hostPort);
          if (!known) {
            store.setKnownHost(hostPort, fingerprint); // trust on first use
            return true;
          }
          return known === fingerprint;
        },
      });
  });
}

const write = (id, data) => sessions.get(id)?.stream.write(data);
const resize = (id, cols, rows) => sessions.get(id)?.stream.setWindow(rows, cols, 0, 0);
function close(id) {
  const s = sessions.get(id);
  if (s) {
    s.stream.end();
    s.client.end();
    sessions.delete(id);
  }
}
const closeAll = () => [...sessions.keys()].forEach(close);

const get = (id) => sessions.get(id) || null;

module.exports = { open, write, resize, close, closeAll, get };
