import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function lanIps() {
  const out = new Set();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== "IPv4" || info.internal) continue;
      out.add(info.address);
    }
  }
  for (const extra of String(process.env.LAN_IP || process.env.CERT_IP || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    out.add(extra);
  }
  return [...out];
}

function writeOpenSslConfig(cfgPath, ips) {
  const alt = [
    "DNS:localhost",
    "DNS:xgimi-remote.local",
    "IP:127.0.0.1",
    ...ips.map((ip) => `IP:${ip}`),
  ].join(",");
  fs.writeFileSync(
    cfgPath,
    `[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no

[dn]
CN = XGIMI Remote
O = XGIMI LAN

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${alt}
`,
  );
}

/**
 * Ensure a LAN HTTPS CA + leaf exist. Returns { key, cert, ca } PEM buffers.
 * Browsers need the CA installed once for PWA install / service workers.
 */
export function ensureTlsMaterial(tlsDir) {
  fs.mkdirSync(tlsDir, { recursive: true });
  const caKey = path.join(tlsDir, "ca.key");
  const caCert = path.join(tlsDir, "ca.crt");
  const serverKey = path.join(tlsDir, "server.key");
  const serverCert = path.join(tlsDir, "server.crt");
  const cfgPath = path.join(tlsDir, "openssl.cnf");
  const ips = lanIps();
  writeOpenSslConfig(cfgPath, ips);

  const haveAll =
    fs.existsSync(caKey) &&
    fs.existsSync(caCert) &&
    fs.existsSync(serverKey) &&
    fs.existsSync(serverCert);

  if (!haveAll) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "3650",
        "-nodes",
        "-keyout",
        caKey,
        "-out",
        caCert,
        "-subj",
        "/CN=XGIMI Remote CA/O=XGIMI LAN",
        "-extensions",
        "v3_ca",
        "-config",
        cfgPath,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      ["genrsa", "-out", serverKey, "2048"],
      { stdio: "ignore" },
    );
    const csr = path.join(tlsDir, "server.csr");
    execFileSync(
      "openssl",
      [
        "req",
        "-new",
        "-key",
        serverKey,
        "-out",
        csr,
        "-subj",
        "/CN=XGIMI Remote/O=XGIMI LAN",
        "-config",
        cfgPath,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "openssl",
      [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        caCert,
        "-CAkey",
        caKey,
        "-CAcreateserial",
        "-out",
        serverCert,
        "-days",
        "825",
        "-sha256",
        "-extfile",
        cfgPath,
        "-extensions",
        "v3_req",
      ],
      { stdio: "ignore" },
    );
    try {
      fs.unlinkSync(csr);
    } catch {
      /* ignore */
    }
  }

  return {
    key: fs.readFileSync(serverKey),
    cert: fs.readFileSync(serverCert),
    ca: fs.readFileSync(caCert),
    caPath: caCert,
    ips,
  };
}
