import net from 'net';
import dns from 'dns';

export interface PingPlayer {
  name: string;
  uuid?: string;
  avatarUrl: string;
}

export interface PingResult {
  online: boolean;
  players: {
    online: number;
    max: number;
    list: PingPlayer[];
  };
  version?: string;
  motd?: string;
}

function writeVarInt(val: number): Buffer {
  const bytes: number[] = [];
  while (true) {
    if ((val & ~0x7f) === 0) {
      bytes.push(val);
      break;
    }
    bytes.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset: number = 0): { value: number; size: number } {
  let value = 0;
  let size = 0;
  let byte = 0;
  do {
    if (offset + size >= buffer.length) {
      throw new Error('Buffer overflow reading VarInt');
    }
    byte = buffer[offset + size];
    value |= (byte & 0x7f) << (size * 7);
    size++;
    if (size > 5) {
      throw new Error('VarInt too large');
    }
  } while ((byte & 0x80) === 0x80);
  return { value, size };
}

function createPacket(packetId: number, data: Buffer): Buffer {
  const idBuf = writeVarInt(packetId);
  const lengthBuf = writeVarInt(idBuf.length + data.length);
  return Buffer.concat([lengthBuf, idBuf, data]);
}

// Aternos proxy returns "● Offline" or protocol -1 when server is turned off
export function isAternosOfflineIndicator(versionName?: string, motdClean?: string, protocolVersion?: number): boolean {
  const v = (versionName || '').toLowerCase().trim();
  const m = (motdClean || '').toLowerCase().trim();
  if (protocolVersion === -1) return true;
  if (v.includes('offline') || v.includes('● offline') || v === 'offline' || v === '●') return true;
  if (
    m.includes('server is offline') ||
    m.includes('this server is offline') ||
    m.includes('get this server more ram') ||
    m.includes('● offline') ||
    m.includes('offline server')
  ) {
    return true;
  }
  return false;
}

// Fast Low-level TCP Minecraft SLP ping (timeout 900ms)
export async function pingMinecraftDirect(host: string, port: number = 25565, timeoutMs: number = 900): Promise<PingResult | null> {
  return new Promise(resolve => {
    let resolvedHost = host;
    let resolvedPort = port;

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    let socket: net.Socket | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {}
        socket = null;
      }
    };

    const doConnect = () => {
      try {
        socket = net.createConnection({ host: resolvedHost, port: resolvedPort });
        socket.setTimeout(timeoutMs);

        let receivedBuffer = Buffer.alloc(0);

        socket.on('connect', () => {
          try {
            const hostBuf = Buffer.from(resolvedHost, 'utf8');
            const hostLenBuf = writeVarInt(hostBuf.length);
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(resolvedPort);

            const handshakeData = Buffer.concat([
              writeVarInt(765), // Protocol version
              hostLenBuf,
              hostBuf,
              portBuf,
              writeVarInt(1), // State 1: status
            ]);
            const handshakePacket = createPacket(0x00, handshakeData);
            const requestPacket = createPacket(0x00, Buffer.alloc(0));

            socket?.write(Buffer.concat([handshakePacket, requestPacket]));
          } catch {
            cleanup();
            resolve(null);
          }
        });

        socket.on('data', chunk => {
          receivedBuffer = Buffer.concat([receivedBuffer, chunk]);

          try {
            let offset = 0;
            const { value: packetLen, size: packetLenSize } = readVarInt(receivedBuffer, offset);
            offset += packetLenSize;

            if (receivedBuffer.length >= offset + packetLen) {
              const { value: packetId, size: packetIdSize } = readVarInt(receivedBuffer, offset);
              offset += packetIdSize;

              if (packetId === 0x00) {
                const { value: stringLen, size: stringLenSize } = readVarInt(receivedBuffer, offset);
                offset += stringLenSize;

                const jsonStr = receivedBuffer.toString('utf8', offset, offset + stringLen);
                const data = JSON.parse(jsonStr);

                const verName = data.version?.name || '';
                const motdText = typeof data.description === 'string' ? data.description : data.description?.text || '';
                const protocol = data.version?.protocol;

                // Explicitly check for Aternos offline proxy
                if (isAternosOfflineIndicator(verName, motdText, protocol)) {
                  cleanup();
                  resolve({
                    online: false,
                    players: { online: 0, max: 20, list: [] },
                    version: verName,
                    motd: motdText,
                  });
                  return;
                }

                const sample = Array.isArray(data.players?.sample) ? data.players.sample : [];
                const list: PingPlayer[] = sample.map((p: any) => ({
                  name: p.name,
                  uuid: p.id,
                  avatarUrl: `https://mc-heads.net/avatar/${encodeURIComponent(p.name)}/128.png`,
                }));

                cleanup();
                resolve({
                  online: true,
                  players: {
                    online: data.players?.online || 0,
                    max: data.players?.max || 20,
                    list,
                  },
                  version: verName,
                  motd: motdText,
                });
              }
            }
          } catch {}
        });

        socket.on('error', () => {
          cleanup();
          resolve(null);
        });

        socket.on('timeout', () => {
          cleanup();
          resolve(null);
        });

        socket.on('close', () => {
          cleanup();
          resolve(null);
        });
      } catch {
        cleanup();
        resolve(null);
      }
    };

    if (port === 25565) {
      dns.promises
        .resolveSrv(`_minecraft._tcp.${host}`)
        .then(records => {
          if (records && records.length > 0) {
            resolvedHost = records[0].name;
            resolvedPort = records[0].port;
          }
          doConnect();
        })
        .catch(() => {
          doConnect();
        });
    } else {
      doConnect();
    }
  });
}

// 6-second memory cache for instant responses
const pingCache: Map<string, { time: number; result: PingResult }> = new Map();
const inFlightPings: Map<string, Promise<PingResult>> = new Map();

// Fast concurrent query querying direct TCP and HTTP APIs in parallel with accurate offline detection
export async function queryMinecraftServer(
  serverAddress: string,
  dynip?: string,
  fallbackCount: number = 0,
  fallbackPlayerList: string[] = [],
  fallbackOnline: boolean = false
): Promise<PingResult> {
  const cacheKey = `${serverAddress}_${dynip || ''}`.toLowerCase();
  const cached = pingCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.time < 12000) {
    return cached.result;
  }

  const existingInFlight = inFlightPings.get(cacheKey);
  if (existingInFlight) {
    return existingInFlight;
  }

  const queryPromise = (async (): Promise<PingResult> => {
    try {
      const parseAddress = (addr: string) => {
        const parts = addr.split(':');
        return {
          host: parts[0].trim(),
          port: parts[1] ? parseInt(parts[1], 10) : 25565,
        };
      };

      const targets: Array<{ host: string; port: number }> = [];
      if (dynip && dynip.trim()) targets.push(parseAddress(dynip.trim()));
      if (serverAddress && serverAddress.trim()) targets.push(parseAddress(serverAddress.trim()));

      // STEP 1: Fast parallel direct TCP checks (concurrent, sub-450ms)
      const tcpPromises = targets.map(async t => {
        try {
          const directRes = await pingMinecraftDirect(t.host, t.port, 450);
          if (directRes && directRes.online && !isAternosOfflineIndicator(directRes.version, directRes.motd)) {
            return directRes;
          }
        } catch {}
        return null;
      });

      const tcpResults = await Promise.all(tcpPromises);
      for (const res of tcpResults) {
        if (res && res.online) {
          pingCache.set(cacheKey, { time: Date.now(), result: res });
          return res;
        }
      }

      // If Aternos has already confirmed server is offline or stopping, don't stall on external HTTP queries
      if (!fallbackOnline) {
        const offlineResult: PingResult = {
          online: false,
          players: { online: 0, max: 20, list: [] },
        };
        pingCache.set(cacheKey, { time: Date.now(), result: offlineResult });
        return offlineResult;
      }

      // STEP 2: Fallback to fast external HTTP checks (850ms timeout)
      const tasks: Promise<PingResult | null>[] = [];

      // Fast mcstatus.io fetch
      for (const t of targets) {
        const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
        tasks.push(
          (async (): Promise<PingResult | null> => {
            try {
              const ac = new AbortController();
              const tm = setTimeout(() => ac.abort(), 850);
              const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal,
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
                  const verName = data.version?.name_clean || data.version?.name_raw || '';
                  const motdClean = data.motd?.clean || '';
                  const proto = data.version?.protocol;

                  if (isAternosOfflineIndicator(verName, motdClean, proto)) {
                    return {
                      online: false,
                      players: { online: 0, max: 20, list: [] },
                      version: verName,
                      motd: motdClean,
                    };
                  }

                  const rawList = Array.isArray(data.players?.list) ? data.players.list : [];
                  const list: PingPlayer[] = rawList.map((p: any) => {
                    const name = typeof p === 'string' ? p : p.name_clean || p.name_raw || p.name || '';
                    return {
                      name,
                      uuid: typeof p === 'object' ? p.uuid : undefined,
                      avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`,
                    };
                  }).filter((p: PingPlayer) => Boolean(p.name));

                  return {
                    online: true,
                    players: {
                      online: data.players?.online ?? list.length,
                      max: data.players?.max || 20,
                      list,
                    },
                    version: verName,
                    motd: motdClean,
                  };
                }
              }
            } catch {}
            return null;
          })()
        );
      }

      // Fast mcsrvstat.us fetch
      for (const t of targets) {
        const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
        tasks.push(
          (async (): Promise<PingResult | null> => {
            try {
              const ac = new AbortController();
              const tm = setTimeout(() => ac.abort(), 850);
              const res = await fetch(`https://api.mcsrvstat.us/3/${encodeURIComponent(targetStr)}`, {
                signal: ac.signal,
              });
              clearTimeout(tm);
              if (res.ok) {
                const data = await res.json();
                if (data?.online) {
                  const verName = String(data.version || '');
                  const motdClean = Array.isArray(data.motd?.clean) ? data.motd.clean.join(' ') : String(data.motd?.clean || '');
                  const proto = data.protocol?.version;

                  if (isAternosOfflineIndicator(verName, motdClean, proto)) {
                    return {
                      online: false,
                      players: { online: 0, max: 20, list: [] },
                      version: verName,
                      motd: motdClean,
                    };
                  }

                  const rawList = Array.isArray(data.players?.list) ? data.players.list : [];
                  const list: PingPlayer[] = rawList.map((p: any) => {
                    const name = typeof p === 'string' ? p : p.name || p.name_clean || '';
                    return {
                      name,
                      uuid: typeof p === 'object' ? p.uuid : undefined,
                      avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`,
                    };
                  }).filter((p: PingPlayer) => Boolean(p.name));

                  return {
                    online: true,
                    players: {
                      online: data.players?.online ?? list.length,
                      max: data.players?.max || 20,
                      list,
                    },
                    version: verName,
                    motd: motdClean,
                  };
                }
              }
            } catch {}
            return null;
          })()
        );
      }

      // Await results
      try {
        const results = await Promise.all(tasks);
        const hasExplicitOffline = results.some(r => r && !r.online && isAternosOfflineIndicator(r.version, r.motd));
        if (hasExplicitOffline) {
          const offlineRes: PingResult = {
            online: false,
            players: { online: 0, max: 20, list: [] },
            version: '● Offline',
            motd: 'This server is offline.',
          };
          pingCache.set(cacheKey, { time: Date.now(), result: offlineRes });
          return offlineRes;
        }

        const onlineResult = results.find(r => r && r.online);
        if (onlineResult) {
          const existingNames = new Set(onlineResult.players.list.map(p => p.name.toLowerCase()));
          for (const name of fallbackPlayerList) {
            if (name && !existingNames.has(name.toLowerCase())) {
              onlineResult.players.list.push({
                name,
                avatarUrl: `https://minotar.net/helm/${encodeURIComponent(name)}/32.png`,
              });
            }
          }
          onlineResult.players.online = Math.max(onlineResult.players.online, onlineResult.players.list.length, fallbackCount);
          pingCache.set(cacheKey, { time: Date.now(), result: onlineResult });
          return onlineResult;
        }
      } catch {}

      // If direct ping and external APIs all failed, server is unreachable / offline
      const fallbackResult: PingResult = {
        online: false,
        players: {
          online: 0,
          max: 20,
          list: [],
        },
        version: '● Offline',
        motd: 'This server is offline.',
      };
      pingCache.set(cacheKey, { time: Date.now(), result: fallbackResult });
      return fallbackResult;
    } finally {
      inFlightPings.delete(cacheKey);
    }
  })();

  inFlightPings.set(cacheKey, queryPromise);
  return queryPromise;
}
