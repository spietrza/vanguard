#!/usr/bin/env node
// Standalone zero-dep CONNECT proxy for the egress enclave sidecar. Only tunnels HTTPS CONNECT to
// allowlisted domains on port 443 that resolve to public addresses (others 403). ALLOW and TRUSTED
// (comma-separated; TRUSTED = custom endpoints exempt from the port/address rule) and PORT come from env. The allow
// semantics (exact or subdomain) are imported from the shared `egress-allow.mjs`, which the host
// `docker cp`'s next to this file — the SAME module egress-proxy.ts uses, so the two never drift.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { writeSync } from 'node:fs';
import { resolveConnectTarget, connectOptions } from './egress-allow.mjs';

// Synchronous stdout: `docker logs` reads a pipe, and async console.log buffers can be dropped by
// process.exit — the crash evidence is the point, so it must flush before death (PR #353 review).
// Best-effort even so: a saturated non-blocking pipe can make writeSync itself throw (EAGAIN), and
// a logger that throws while handling a failure would mask the failure.
const log = (line) => {
  try {
    writeSync(1, `${line}\n`);
  } catch {
    /* the pipe is gone or full — dying silently here would still exit nonzero below */
  }
};

const ALLOW = (process.env.ALLOW ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
// Exact hosts (configured custom endpoints) that may use any port and resolve to private addresses.
const TRUSTED = (process.env.TRUSTED ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== '');
const PORT = Number(process.env.PORT ?? '8080');

// The proxy must not die silently mid-run (dogfood #352: a dead proxy bricks every remaining
// stage with ConnectionRefused). It runs as container PID 1 under `--restart on-failure`, so the
// right response to the unexpected is: write the reason to stdout (docker logs) and let docker
// restart a fresh process — never a silent exit, never limping on in unknown state.
process.on('uncaughtException', (err) => {
  log(`egress proxy crashed: ${err?.stack ?? err}`);
  process.exit(1);
});

createServer((_req, res) => res.writeHead(405).end('This proxy only supports HTTPS CONNECT.'))
  .on('error', (err) => {
    // A listen-time failure (EADDRINUSE, EACCES) MUST be fatal-nonzero: swallowing it ends the
    // process with exit 0, which --restart on-failure reads as success — the port-closed brick
    // this server exists to prevent (PR #353 review). Accept-level errors (EMFILE) keep serving.
    if (err.syscall === 'listen') {
      log(`egress proxy cannot bind: ${err}`);
      process.exit(1);
    }
    log(`egress proxy server error: ${err}`);
  })
  .on('clientError', (_err, socket) => socket.destroy())
  .on('connect', (req, clientSocket, head) => {
    // For 'connect' node hands over a raw socket with NO error listener. A client that RSTs while
    // the 403 (or 200) is in flight makes the write emit 'error' (EPIPE/ECONNRESET) — unhandled,
    // that is an uncaughtException → exit 1 → docker restart, and the CLI's aborted CONNECTs to
    // disallowed telemetry hosts repeat it until the restart cap kills the enclave for good
    // (dogfood #352, second failure). Absorb socket errors before the first write can happen.
    clientSocket.on('error', () => clientSocket.destroy());
    // Port 443 only and no private/loopback/link-local addresses, except for TRUSTED custom endpoints.
    resolveConnectTarget(req.url ?? '', ALLOW, TRUSTED).then((dest) => {
      if (dest === undefined) {
        clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      if (clientSocket.destroyed) return;
      const upstream = connect(connectOptions(dest), () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    }, () => clientSocket.destroy());
  })
  .listen(PORT, function () {
    // The ACTUALLY-bound port (PORT=0 ⇒ ephemeral), so the banner is truthful for tests/debugging.
    log(`egress proxy on ${this.address().port}; allow=${ALLOW.join(',')}`);
  });
