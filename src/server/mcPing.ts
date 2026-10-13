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
                  version: data.version?.name,
                  motd: typeof data.description === 'string' ? data.description : data.description?.text,
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

// 10-second memory cache for instant responses
const pingCache: Map<string, { time: number; result: PingResult }> = new Map();

// Fast concurrent query querying direct TCP and HTTP APIs in parallel with 15s caching & anti-flapping
export async function queryMinecraftServer(
  serverAddress: string,
  dynip?: string,
  fallbackCount: number = 0
): Promise<PingResult> {
  const cacheKey = `${serverAddress}_${dynip || ''}`.toLowerCase();
  const cached = pingCache.get(cacheKey);
  const now = Date.now();

  if (cached && now - cached.time < 12000) {
    return cached.result;
  }

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

  // Run fast parallel checks: direct TCP + mcstatus.io (with 2500ms timeout)
  const tasks: Promise<PingResult | null>[] = [];

  // Direct TCP checks
  for (const t of targets) {
    tasks.push(pingMinecraftDirect(t.host, t.port, 2500));
  }

  // Fast mcstatus.io fetch
  for (const t of targets) {
    const targetStr = t.port === 25565 ? t.host : `${t.host}:${t.port}`;
    tasks.push(
      (async (): Promise<PingResult | null> => {
        try {
          const ac = new AbortController();
          const tm = setTimeout(() => ac.abort(), 2500);
          const res = await fetch(`https://api.mcstatus.io/v2/status/java/${encodeURIComponent(targetStr)}`, {
            signal: ac.signal,
          });
          clearTimeout(tm);
          if (res.ok) {
            const data = await res.json();
            if (data?.online) {
              const list: PingPlayer[] = Array.isArray(data.players?.list)
                ? data.players.list.map((p: any) => ({
                    name: p.name_clean || p.name_raw || p.name,
                    uuid: p.uuid,
                    avatarUrl: `https://minotar.net/helm/${encodeURIComponent(p.name_clean || p.name_raw || p.name)}/32.png`,
                  }))
                : [];

              return {
                online: true,
                players: {
                  online: data.players?.online || 0,
                  max: data.players?.max || 20,
                  list,
                },
                version: data.version?.name_clean,
                motd: data.motd?.clean,
              };
            }
          }
        } catch {}
        return null;
      })()
    );
  }

  // Await the fastest successful response
  try {
    const results = await Promise.all(tasks);
    const onlineResult = results.find(r => r && r.online);
    if (onlineResult) {
      pingCache.set(cacheKey, { time: now, result: onlineResult });
      return onlineResult;
    }
  } catch {}

  // Anti-flapping grace period: If server was verified online within the last 25 seconds, don't flap to offline on a single transient timeout
  if (cached && cached.result.online && now - cached.time < 25000) {
    return cached.result;
  }

  // Fallback using Aternos internal state
  const fallbackResult: PingResult = {
    online: fallbackCount > 0,
    players: {
      online: fallbackCount,
      max: 20,
      list: [],
    },
  };
  pingCache.set(cacheKey, { time: now, result: fallbackResult });
  return fallbackResult;
}
