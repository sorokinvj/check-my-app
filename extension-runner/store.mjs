import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
const exec = promisify(execFile);

export function extensionIdForKey(key) {
  return [...createHash('sha256').update(key).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
}

// CRX3 protobuf fields are length-delimited; skip other wire types explicitly.
function fields(bytes) {
  let pos = 0;
  const result = [];
  function varint() {
    let n = 0, shift = 0;
    for (let i = 0; i < 5 && pos < bytes.length; i++) {
      const b = bytes[pos++]; n += (b & 127) * 2 ** shift;
      if (!(b & 128)) return n;
      shift += 7;
    }
    throw new Error('Invalid CRX header');
  }
  while (pos < bytes.length) {
    const tag = varint(), wire = tag & 7;
    if (wire === 2) {
      const len = varint();
      if (pos + len > bytes.length) throw new Error('Truncated CRX header');
      result.push([Math.floor(tag / 8), bytes.subarray(pos, pos + len)]); pos += len;
    } else if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error('Unsupported CRX header');
  }
  return result;
}

export function unpackHeader(buffer, expectedId) {
  if (buffer.length < 16 || buffer.toString('ascii', 0, 4) !== 'Cr24') throw new Error('Store did not return a CRX package');
  const version = buffer.readUInt32LE(4);
  let key, zipOffset;
  if (version === 2) {
    const keyLength = buffer.readUInt32LE(8), sigLength = buffer.readUInt32LE(12);
    key = buffer.subarray(16, 16 + keyLength); zipOffset = 16 + keyLength + sigLength;
  } else if (version === 3) {
    zipOffset = 12 + buffer.readUInt32LE(8);
    if (zipOffset > buffer.length) throw new Error('Truncated CRX package');
    for (const [tag, proof] of fields(buffer.subarray(12, zipOffset))) {
      if (tag !== 2 && tag !== 3) continue;
      const candidate = fields(proof).find(([n]) => n === 1)?.[1];
      if (candidate && extensionIdForKey(candidate) === expectedId) key = candidate;
    }
  } else throw new Error('Unsupported CRX version');
  if (!key || extensionIdForKey(key) !== expectedId || zipOffset >= buffer.length) throw new Error('Store package identity mismatch');
  return { key: key.toString('base64'), zip: buffer.subarray(zipOffset) };
}

export async function installFromStore(id, directory) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('Invalid extension ID');
  const url = new URL('https://clients2.google.com/service/update2/crx');
  url.search = new URLSearchParams({ response: 'redirect', prodversion: '150.0.0.0', acceptformat: 'crx2,crx3', x: `id=${id}&uc` }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Store package unavailable (${response.status})`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error('Extension exceeds 100 MB');
    chunks.push(chunk);
  }
  const crx = Buffer.concat(chunks);
  const { key, zip } = unpackHeader(crx, id);
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}.zip`, zip, { mode: 0o600 });
  await exec('python3', ['-c', `
import pathlib, sys, zipfile, stat
root=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist()
 if len(entries)>20000 or sum(i.file_size for i in entries)>300*1024*1024: raise ValueError('Expanded package too large')
 for i in entries:
  dest=(root/i.filename).resolve()
  if not dest.is_relative_to(root) or stat.S_ISLNK(i.external_attr>>16): raise ValueError('Unsafe package path')
 z.extractall(root)
`, `${directory}.zip`, directory]);
  const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
  // An unpacked Store artifact needs its original key to retain its identity.
  // Executable files are unchanged; retain the original CRX digest as source.
  manifest.key = key;
  await writeFile(`${directory}/manifest.json`, JSON.stringify(manifest));
  let name = manifest.name;
  if (/^__MSG_(.+)__$/.test(name) && manifest.default_locale) {
    const messages = JSON.parse(await readFile(`${directory}/_locales/${manifest.default_locale}/messages.json`, 'utf8'));
    name = messages[name.slice(6, -2)]?.message ?? name;
  }
  return { extensionId: id, name, packageVersion: manifest.version, manifestVersion: manifest.manifest_version,
    artifactSha256: createHash('sha256').update(crx).digest('hex'), homepageUrl: manifest.homepage_url ?? null,
    popupPath: manifest.action?.default_popup ?? manifest.browser_action?.default_popup ?? null,
    permissions: manifest.permissions ?? [], hostPermissions: manifest.host_permissions ?? [],
    source: 'chrome-web-store', identityKeyRestored: true };
}
