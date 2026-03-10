import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces, arch, platform, hostname, cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';

let _cached = null;

export async function getMachineId() {
  if (_cached) return _cached;
  _cached = await resolveHardwareId();
  return _cached;
}

export function getMachineIdLegacy() {
  const interfaces = networkInterfaces();
  let mac = '';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.mac !== '00:00:00:00:00:00') {
        mac = iface.mac;
        break;
      }
    }
    if (mac) break;
  }
  return hash(mac + arch() + platform());
}

async function resolveHardwareId() {
  const os = platform();

  // L1: Hardware-level ID (survives OS reinstall)
  try {
    if (os === 'darwin') {
      const serial = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformSerialNumber/{print $4}'",
        { encoding: 'utf8', timeout: 3000 },
      ).trim();
      if (serial && serial.length >= 8) return hash(serial);
    } else if (os === 'linux') {
      const uuid = readFileSafe('/sys/class/dmi/id/product_uuid');
      if (uuid && uuid.length >= 8) return hash(uuid);
    } else if (os === 'win32') {
      const out = execSync('wmic csproduct get UUID', { encoding: 'utf8', timeout: 3000 });
      const uuid = out.split('\n').map(l => l.trim()).filter(l => l && l !== 'UUID')[0];
      if (uuid && uuid.length >= 8) return hash(uuid);
    }
  } catch { /* fallback */ }

  // L2: Linux machine-id (changes on reinstall)
  try {
    if (os === 'linux') {
      const mid = readFileSafe('/etc/machine-id');
      if (mid && mid.length >= 16) return hash(mid);
    }
  } catch { /* fallback */ }

  // L3: Hardware fingerprint (hostname + cpu + memory + arch)
  try {
    const fp = [hostname(), cpus()[0]?.model || '', String(totalmem()), arch()].join('|');
    if (fp.length > 10) return hash(fp);
  } catch { /* fallback */ }

  // L4: Legacy (MAC + arch + platform)
  return getMachineIdLegacy();
}

function readFileSafe(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
  } catch { return null; }
}

function hash(input) {
  return createHash('sha256').update(input).digest('hex').substring(0, 16).toUpperCase();
}
