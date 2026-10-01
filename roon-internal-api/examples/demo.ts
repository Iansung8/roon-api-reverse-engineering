/**
 * Demo of the RoonClient facade — how short a PoC is now (read-only here).
 *   npx ts-node examples/demo.ts
 */
import { RoonClient } from '../src';

function requiredEnv(name: 'ROON_HOST'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function serverBrokerId(): Buffer {
  const value = process.env.ROON_SERVER_BROKER_ID?.trim() || process.env.ROON_BROKER_ID?.trim();
  if (!value) throw new Error('ROON_SERVER_BROKER_ID is required');
  if (!/^[0-9a-f]{32}$/i.test(value)) {
    throw new Error('ROON_SERVER_BROKER_ID must be exactly 32 hexadecimal characters');
  }
  return Buffer.from(value, 'hex');
}

async function main() {
  const roon = new RoonClient({
    host: requiredEnv('ROON_HOST'),
    serverBrokerId: serverBrokerId(),
  });

  try {
    await roon.connect();

    console.log('Library oid:', roon.serviceOid('Library').toString());
    console.log('Transport oid:', roon.serviceOid('Transport').toString());
    console.log('HiFi zone oid:', roon.zoneByName('HiFi')?.toString());

    const album = roon.findByTitle('AlbumLite', 'Clube Da Esquina');
    console.log('Found album "Clube Da Esquina":', album ? `oid=${album.oid}` : 'not loaded');

    // Everything below is one-liners (left commented so the demo stays read-only):
    //   if (album) await roon.favoriteAlbum(roon.albumIdOf(album)!, true);
    //   await roon.playAlbumOnZone('HiFi', 'Clube Da Esquina');
    //   roon.zoneControl(roon.zoneByName('HiFi')!, 'Pause');
    //   roon.standby(roon.endpointByName('HiFi')!);
  } finally {
    roon.close();
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
